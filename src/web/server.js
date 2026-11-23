const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadPlaylists, savePlaylists } = require('../playlists');
const { searchYouTube } = require('../youtube');

const SOUNDS_DIR = path.join(__dirname, '..', '..', 'sounds');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD_BYTES = 500 * 1024; // 500 KB per sound

// Every sound is levelled to the same loudness so no clip is much louder than another.
// -20 LUFS sits near voice-chat level; the true-peak cap keeps loud memes from clipping.
const TARGET_LUFS = -20;

// Re-encodes `src` with FFmpeg's loudnorm and moves the result to `dest` (atomic rename).
// If FFmpeg is missing or fails, `src` is kept as is, so an upload is never lost.
// Resolves true when the file was normalized.
// ponytail: single-pass loudnorm, accurate to ~1-2 LU on short clips; two-pass if that ever matters
function normalizeSound(src, dest) {
  const out = `${src}.norm.mp3`;
  return new Promise(resolve => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
      '-af', `loudnorm=I=${TARGET_LUFS}:TP=-2:LRA=11`,
      '-ar', '48000', '-c:a', 'libmp3lame', '-b:a', '128k', out,
    ]);
    let err = '';
    ff.stderr.on('data', d => { err += d; });
    let done = false; // 'error' and 'close' can both fire when ffmpeg fails to start
    const finish = ok => {
      if (done) return;
      done = true;
      if (!ok) console.warn(`[Normalize] Skipped ${path.basename(dest)}: ${err.trim().split('\n').pop() || 'ffmpeg unavailable'}`);
      fs.rmSync(ok ? src : out, { force: true });
      fs.renameSync(ok ? out : src, dest);
      resolve(ok);
    };
    ff.on('error', () => finish(false));
    ff.on('close', code => finish(code === 0));
  });
}

// One-off for sounds added before normalization existed: npm run normalize-sounds
async function normalizeAllSounds() {
  const files = fs.readdirSync(SOUNDS_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));
  for (const f of files) {
    const file = path.join(SOUNDS_DIR, f);
    const tmp = path.join(SOUNDS_DIR, `.${f}.orig`);
    fs.copyFileSync(file, tmp);
    console.log(`${(await normalizeSound(tmp, file)) ? 'OK  ' : 'SKIP'} ${f}`);
  }
}

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

// `search` resolves a song title or URL; tests pass a fake so they need no network.
function createWebServer({ search = searchYouTube } = {}) {
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
          normalizeSound(tempPath, targetPath).then(normalized => {
            console.log(`[Web Soundboard] Uploaded sound "${clean}.mp3" (${receivedBytes} bytes${normalized ? ', normalized' : ''})`);
            sendJson(res, 200, { success: true, name: clean });
          });
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

      // 8. Playlists: /api/playlists[/:name[/songs[/:index]]]
      const plMatch = pathname.match(/^\/api\/playlists(?:\/([^/]+)(\/songs(?:\/(\d+))?)?)?$/);
      if (plMatch) {
        const playlists = loadPlaylists();
        const name = plMatch[1] !== undefined ? sanitizeName(decodeURIComponent(plMatch[1])) : null;
        const isSongs = plMatch[2] !== undefined;
        const index = plMatch[3] !== undefined ? Number(plMatch[3]) : null;

        if (req.method === 'GET' && name === null) {
          const list = Object.keys(playlists).sort().map(n => ({ name: n, songs: playlists[n] }));
          return sendJson(res, 200, { playlists: list });
        }

        if (req.method === 'POST' && name === null) {
          let body;
          try { body = await parseJsonBody(req); } catch { return sendJson(res, 400, { error: 'Format JSON tidak valid' }); }
          const newName = sanitizeName(body.name);
          if (!newName) return sendJson(res, 400, { error: 'Nama playlist tidak valid (hanya huruf, angka, dash, underscore)' });
          if (playlists[newName]) return sendJson(res, 409, { error: `Playlist "${newName}" sudah ada` });
          playlists[newName] = [];
          savePlaylists(playlists);
          return sendJson(res, 200, { success: true, name: newName });
        }

        if (!name || !playlists[name]) return sendJson(res, 404, { error: 'Playlist tidak ditemukan' });

        if (req.method === 'DELETE' && !isSongs) {
          delete playlists[name];
          savePlaylists(playlists);
          return sendJson(res, 200, { success: true });
        }

        if (req.method === 'POST' && isSongs && index === null) {
          let body;
          try { body = await parseJsonBody(req); } catch { return sendJson(res, 400, { error: 'Format JSON tidak valid' }); }
          const query = String(body.query || '').trim();
          if (!query) return sendJson(res, 400, { error: 'Isi judul lagu atau URL YouTube' });
          let video;
          try { video = await search(query); } catch { return sendJson(res, 404, { error: 'Lagu tidak ditemukan di YouTube' }); }
          // Re-read: another request may have changed the file during the slow search
          const fresh = loadPlaylists();
          if (!fresh[name]) return sendJson(res, 404, { error: 'Playlist tidak ditemukan' });
          const song = { title: video.title, url: video.url, duration: video.duration };
          fresh[name].push(song);
          savePlaylists(fresh);
          return sendJson(res, 200, { success: true, song });
        }

        if (req.method === 'DELETE' && isSongs && index !== null) {
          if (index >= playlists[name].length) return sendJson(res, 404, { error: 'Lagu tidak ditemukan' });
          playlists[name].splice(index, 1);
          savePlaylists(playlists);
          return sendJson(res, 200, { success: true });
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
  normalizeSound,
  normalizeAllSounds,
};
