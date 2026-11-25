const http = require('node:http');
const crypto = require('node:crypto');
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

// An MP3 starts with an ID3 tag or an MPEG audio frame sync (11 set bits). Anything else (a renamed
// image, a script, an archive) is refused before FFmpeg or the bot ever opens it.
function looksLikeMp3(file) {
  const head = Buffer.alloc(3);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 3, 0); } finally { fs.closeSync(fd); }
  return head.toString('latin1') === 'ID3' || (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0);
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

// No built-in fallback: without WEB_PIN the dashboard stays locked instead of opening with a known PIN.
function getPin() {
  return process.env.WEB_PIN || '';
}

function pinMatches(pin) {
  const real = getPin();
  const given = Buffer.from(String(pin ?? ''));
  return Boolean(real) && given.length === Buffer.byteLength(real) && crypto.timingSafeEqual(given, Buffer.from(real));
}

// A browser that logged in holds a random session token in an HttpOnly cookie; the PIN itself is
// never stored in the cookie, the URL or localStorage.
// ponytail: sessions live in memory, so a restart (every deploy) asks for the PIN again; persist them if that annoys
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiry time

function sessionToken(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/);
  return match ? match[1] : null;
}

function hasSession(req) {
  const token = sessionToken(req);
  const expires = token && sessions.get(token);
  if (expires && expires > Date.now()) return true;
  if (token) sessions.delete(token);
  return false;
}

// PIN guessing is capped per client: 5 wrong PINs, then 15 minutes locked out.
// ponytail: per-IP and in memory; a botnet spread over many IPs would need a global cap too
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, until }
const PRIVATE_IP = /^(::ffff:)?(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd]/i;

// Behind Traefik the socket address is the proxy's, so the client is the last X-Forwarded-For entry
// (the one the proxy added). That header is only trusted when the request comes from a private address.
function clientIp(req) {
  const socketIp = req.socket.remoteAddress || '';
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
  return PRIVATE_IP.test(socketIp) && forwarded.length ? forwarded[forwarded.length - 1] : socketIp;
}

function minutesLocked(ip) {
  const entry = failures.get(ip);
  return entry && entry.until > Date.now() ? Math.ceil((entry.until - Date.now()) / 60000) : 0;
}

function recordFailure(ip) {
  const entry = failures.get(ip) || { count: 0, until: 0 };
  if (entry.until && entry.until <= Date.now()) { entry.count = 0; entry.until = 0; }
  entry.count += 1;
  if (entry.count >= MAX_FAILS) entry.until = Date.now() + LOCK_MS;
  if (failures.size > 10000) failures.clear(); // bound memory under a flood
  failures.set(ip, entry);
}

function sanitizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '').trim();
}

function validatePlaylistName(rawName, playlists) {
  const name = sanitizeName(rawName);
  if (!name) return { status: 400, error: 'Nama playlist tidak valid (hanya huruf, angka, dash, underscore)' };
  // "list" is taken by `!playlist list`, so a playlist with that name could never be played
  if (name === 'list') return { status: 400, error: 'Nama "list" sudah dipakai untuk !playlist list' };
  if (playlists[name]) return { status: 409, error: `Playlist "${name}" sudah ada` };
  return { name };
}

function renamePlaylistInMap(playlists, oldName, rawNewName) {
  if (!playlists[oldName]) return { status: 404, error: 'Playlist tidak ditemukan' };
  const clean = sanitizeName(rawNewName);
  if (clean === oldName) return { status: 200, name: oldName };
  const check = validatePlaylistName(rawNewName, playlists);
  if (check.error) return check;
  playlists[check.name] = playlists[oldName];
  delete playlists[oldName];
  return { status: 200, name: check.name };
}

function reorderPlaylistSongsInMap(playlists, name, from, to) {
  const songs = playlists[name];
  if (!songs) return { status: 404, error: 'Playlist tidak ditemukan' };
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= songs.length || to >= songs.length) {
    return { status: 400, error: 'Indeks lagu tidak valid' };
  }
  if (from !== to) {
    const [moved] = songs.splice(from, 1);
    songs.splice(to, 0, moved);
  }
  return { status: 200, songs };
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
        const value = body ? JSON.parse(body) : {};
        resolve(value && typeof value === 'object' ? value : {}); // `null`, numbers and strings count as empty
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// `search` resolves a song title or URL; tests pass a fake so they need no network.
function createWebServer({ search = searchYouTube } = {}) {
  const route = async (req, res) => {
    // The Host header is the client's; it plays no part in routing.
    const parsedUrl = new URL(req.url, 'http://localhost');
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

    const ip = clientIp(req);

    // 2. Auth: POST /api/login trades the PIN for a session cookie; POST /api/logout ends it
    if (req.method === 'POST' && pathname === '/api/login') {
      const wait = minutesLocked(ip);
      if (wait) return sendJson(res, 429, { error: `Terlalu banyak percobaan. Coba lagi dalam ${wait} menit.` });
      if (!getPin()) return sendJson(res, 503, { error: 'PIN web belum diatur di server (WEB_PIN).' });
      let body;
      try { body = await parseJsonBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      if (!pinMatches(String(body.pin ?? '').trim())) {
        recordFailure(ip);
        return sendJson(res, 401, { error: 'PIN salah' });
      }
      failures.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_MS);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`);
      return sendJson(res, 200, { success: true });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      sessions.delete(sessionToken(req));
      res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return sendJson(res, 200, { success: true });
    }

    // Every other /api route needs the session cookie, or the PIN in an X-Pin header (scripts, tests).
    // A wrong X-Pin counts toward the same lockout as a wrong login.
    if (pathname.startsWith('/api/')) {
      const headerPin = req.headers['x-pin'];
      if (headerPin !== undefined && minutesLocked(ip)) {
        return sendJson(res, 429, { error: 'Terlalu banyak percobaan PIN. Coba lagi nanti.' });
      }
      const authorized = hasSession(req) || (headerPin !== undefined && pinMatches(headerPin));
      if (!authorized) {
        if (headerPin !== undefined) recordFailure(ip);
        return sendJson(res, 401, { error: 'Akses ditolak: belum login' });
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
          if (!looksLikeMp3(tempPath)) {
            fs.rmSync(tempPath, { force: true });
            return sendJson(res, 400, { error: 'File bukan MP3 yang valid' });
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
          const check = validatePlaylistName(body.name, playlists);
          if (check.error) return sendJson(res, check.status, { error: check.error });
          playlists[check.name] = [];
          savePlaylists(playlists);
          return sendJson(res, 200, { success: true, name: check.name });
        }

        if (!name || !playlists[name]) return sendJson(res, 404, { error: 'Playlist tidak ditemukan' });

        if (req.method === 'PATCH' && !isSongs) {
          let body;
          try { body = await parseJsonBody(req); } catch { return sendJson(res, 400, { error: 'Format JSON tidak valid' }); }
          const result = renamePlaylistInMap(playlists, name, body.newName);
          if (result.error) return sendJson(res, result.status, { error: result.error });
          if (result.name !== name) savePlaylists(playlists);
          return sendJson(res, 200, { success: true, name: result.name });
        }

        if (req.method === 'DELETE' && !isSongs) {
          delete playlists[name];
          savePlaylists(playlists);
          return sendJson(res, 200, { success: true });
        }

        if (req.method === 'PATCH' && isSongs && index === null) {
          let body;
          try { body = await parseJsonBody(req); } catch { return sendJson(res, 400, { error: 'Format JSON tidak valid' }); }
          const result = reorderPlaylistSongsInMap(playlists, name, body.from, body.to);
          if (result.error) return sendJson(res, result.status, { error: result.error });
          if (body.from !== body.to) savePlaylists(playlists);
          return sendJson(res, 200, { success: true, songs: result.songs });
        }

        if (req.method === 'POST' && isSongs && index === null) {
          let body;
          try { body = await parseJsonBody(req); } catch { return sendJson(res, 400, { error: 'Format JSON tidak valid' }); }
          const query = String(body.query || '').trim();
          if (!query) return sendJson(res, 400, { error: 'Isi judul lagu atau URL YouTube' });
          let video;
          try {
            video = await search(query);
          } catch (err) {
            return err.code === 'NOT_YOUTUBE'
              ? sendJson(res, 400, { error: err.message })
              : sendJson(res, 404, { error: 'Lagu tidak ditemukan di YouTube' });
          }
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
  };

  // A malformed request (bad %-escape, unexpected JSON) must never take the bot down with it.
  return http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      console.error('[Web] Request ditolak:', err.message);
      if (!res.headersSent) sendJson(res, 400, { error: 'Permintaan tidak valid' });
      else res.destroy();
    }
  });
}

function startWebServer(port = parseInt(process.env.PORT, 10) || 3000) {
  const server = createWebServer();
  if (!getPin()) console.warn('⚠️ WEB_PIN belum diatur: Web Soundboard Manager terkunci sampai WEB_PIN diisi.');
  server.listen(port, () => {
    console.log(`🌐 Web Soundboard Manager aktif di http://0.0.0.0:${port}`);
  });
  return server;
}

module.exports = {
  createWebServer,
  startWebServer,
  sanitizeName,
  renamePlaylistInMap,
  reorderPlaylistSongsInMap,
  getPin,
  SOUNDS_DIR,
  PUBLIC_DIR,
  normalizeSound,
  normalizeAllSounds,
};
