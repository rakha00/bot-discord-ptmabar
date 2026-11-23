const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const SOUNDS_DIR = path.join(__dirname, '..', '..', 'sounds');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD_BYTES = 500 * 1024; // 500 KB per sound

function getPin() {
  return process.env.WEB_PIN || '280303';
}

function sanitizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '').trim();
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) { // 1MB JSON max
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function checkAuth(req, url) {
  const currentPin = getPin();
  const headerPin = req.headers['x-pin'];
  const queryPin = url.searchParams.get('pin');
  
  // Also check cookie if present
  let cookiePin = '';
  if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)pin=([^;]*)/);
    if (match) cookiePin = decodeURIComponent(match[1]);
  }

  return (headerPin === currentPin) || (queryPin === currentPin) || (cookiePin === currentPin);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Pin',
  });
  res.end(JSON.stringify(data));
}

function createWebServer() {
  return http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Pin',
      });
      return res.end();
    }

    const host = req.headers.host || 'localhost';
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;

    // 1. Static Web UI (Index.html)
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return fs.createReadStream(indexPath).pipe(res);
      }
      return sendJson(res, 404, { error: 'UI tidak ditemukan' });
    }

    // 2. Auth Endpoint: POST /api/login
    if (req.method === 'POST' && pathname === '/api/login') {
      try {
        const body = await parseJsonBody(req);
        if (body.pin && String(body.pin).trim() === getPin()) {
          res.setHeader('Set-Cookie', `pin=${encodeURIComponent(getPin())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
          return sendJson(res, 200, { success: true });
        }
        return sendJson(res, 401, { error: 'PIN salah' });
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON' });
      }
    }

    // Protect all remaining /api routes with PIN authentication
    if (pathname.startsWith('/api/')) {
      if (!checkAuth(req, parsedUrl)) {
        return sendJson(res, 401, { error: 'Akses ditolak: PIN tidak valid atau belum login' });
      }

      // 3. GET /api/sounds: List all soundboard files
      if (req.method === 'GET' && pathname === '/api/sounds') {
        if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true });
        const files = fs.readdirSync(SOUNDS_DIR)
          .filter(f => f.toLowerCase().endsWith('.mp3'))
          .map(f => {
            const fullPath = path.join(SOUNDS_DIR, f);
            const stat = fs.statSync(fullPath);
            const baseName = path.basename(f, path.extname(f));
            return {
              name: baseName,
              filename: f,
              size: stat.size,
              updatedAt: stat.mtimeMs,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        return sendJson(res, 200, { sounds: files });
      }

      // 4. GET /api/raw/:filename: Stream audio for preview
      if (req.method === 'GET' && pathname.startsWith('/api/raw/')) {
        const rawFilename = decodeURIComponent(pathname.replace('/api/raw/', ''));
        const cleanBase = sanitizeName(path.basename(rawFilename, path.extname(rawFilename)));
        const targetFile = path.join(SOUNDS_DIR, `${cleanBase}.mp3`);

        if (!fs.existsSync(targetFile)) {
          return sendJson(res, 404, { error: 'Soundboard file tidak ditemukan' });
        }

        const stat = fs.statSync(targetFile);
        const range = req.headers.range;

        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

          if (start >= stat.size || end >= stat.size) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
            return res.end();
          }

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': (end - start) + 1,
            'Content-Type': 'audio/mpeg',
          });
          return fs.createReadStream(targetFile, { start, end }).pipe(res);
        }

        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': 'audio/mpeg',
          'Accept-Ranges': 'bytes',
        });
        return fs.createReadStream(targetFile).pipe(res);
      }

      // 5. POST /api/upload: Upload new sound (binary body stream)
      if (req.method === 'POST' && pathname === '/api/upload') {
        const queryName = parsedUrl.searchParams.get('name') || req.headers['x-sound-name'];
        const clean = sanitizeName(queryName);

        if (!clean) {
          return sendJson(res, 400, { error: 'Nama sound tidak valid (hanya huruf, angka, dash, dan underscore)' });
        }

        // Reject early when the client declares the size; the stream check below covers the rest.
        if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) {
          return sendJson(res, 413, { error: 'Ukuran file melebihi batas 500 KB' });
        }

        if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true });
        const targetPath = path.join(SOUNDS_DIR, `${clean}.mp3`);
        const tempPath = path.join(SOUNDS_DIR, `.${clean}_${Date.now()}.tmp`);

        const writeStream = fs.createWriteStream(tempPath);
        let receivedBytes = 0;
        let limitExceeded = false;

        req.on('data', chunk => {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_UPLOAD_BYTES && !limitExceeded) {
            limitExceeded = true;
            req.destroy();
            writeStream.destroy();
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            return sendJson(res, 413, { error: 'Ukuran file melebihi batas 500 KB' });
          }
        });

        req.pipe(writeStream);

        writeStream.on('finish', () => {
          if (limitExceeded) return;
          if (receivedBytes === 0) {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            return sendJson(res, 400, { error: 'File kosong atau tidak terkirim' });
          }
          // Atomic replace
          fs.renameSync(tempPath, targetPath);
          console.log(`[Web Soundboard] Uploaded sound "${clean}.mp3" (${receivedBytes} bytes)`);
          return sendJson(res, 200, { success: true, name: clean });
        });

        writeStream.on('error', err => {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          console.error('[Web Upload Error]:', err.message);
          if (!res.headersSent) sendJson(res, 500, { error: 'Gagal menyimpan file audio' });
        });

        return;
      }

      // 6. DELETE /api/sounds/:name: Delete soundboard file
      if (req.method === 'DELETE' && pathname.startsWith('/api/sounds/')) {
        const targetName = sanitizeName(pathname.replace('/api/sounds/', ''));
        if (!targetName) return sendJson(res, 400, { error: 'Nama tidak valid' });

        const targetFile = path.join(SOUNDS_DIR, `${targetName}.mp3`);
        if (!fs.existsSync(targetFile)) {
          return sendJson(res, 404, { error: 'File soundboard tidak ditemukan' });
        }

        fs.unlinkSync(targetFile);
        console.log(`[Web Soundboard] Deleted sound "${targetName}.mp3"`);
        return sendJson(res, 200, { success: true });
      }

      // 7. PATCH /api/sounds/:name: Rename soundboard file
      if (req.method === 'PATCH' && pathname.startsWith('/api/sounds/')) {
        const oldName = sanitizeName(pathname.replace('/api/sounds/', ''));
        if (!oldName) return sendJson(res, 400, { error: 'Nama lama tidak valid' });

        try {
          const body = await parseJsonBody(req);
          const newName = sanitizeName(body.newName);

          if (!newName) {
            return sendJson(res, 400, { error: 'Nama baru tidak valid (hanya huruf, angka, dash, underscore)' });
          }

          const oldFile = path.join(SOUNDS_DIR, `${oldName}.mp3`);
          const newFile = path.join(SOUNDS_DIR, `${newName}.mp3`);

          if (!fs.existsSync(oldFile)) {
            return sendJson(res, 404, { error: 'File soundboard lama tidak ditemukan' });
          }

          if (oldName !== newName && fs.existsSync(newFile)) {
            return sendJson(res, 400, { error: `Soundboard "${newName}" sudah ada` });
          }

          fs.renameSync(oldFile, newFile);
          console.log(`[Web Soundboard] Renamed "${oldName}.mp3" -> "${newName}.mp3"`);
          return sendJson(res, 200, { success: true, name: newName });
        } catch {
          return sendJson(res, 400, { error: 'Format JSON tidak valid' });
        }
      }
    }

    // Fallback 404
    sendJson(res, 404, { error: 'Not Found' });
  });
}

function startWebServer(port = parseInt(process.env.PORT, 10) || 3000) {
  const server = createWebServer();
  server.listen(port, () => {
    console.log(`🌐 Web Soundboard Manager aktif di http://0.0.0.0:${port}`);
  });
  return server;
}

module.exports = {
  createWebServer,
  startWebServer,
  sanitizeName,
  getPin,
  SOUNDS_DIR,
  PUBLIC_DIR,
};
