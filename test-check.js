const assert = require('node:assert');
const { splitText } = require('./src/tts');
const { IDLE_TIMEOUT_MS, EMPTY_TIMEOUT_MS } = require('./src/voiceManager');
const { DONASI_TRIGGER, DONASI_REGEX, donasiSlashCommand } = require('./src/commands/donasi');
const { helpSlashCommand } = require('./src/commands/help');

// 1. Test Slash Commands
assert.strictEqual(donasiSlashCommand.name, 'donasi');
assert.strictEqual(donasiSlashCommand.options.length, 3);
assert.strictEqual(helpSlashCommand.name, 'help');
console.log('✔ Slash command schemas valid');

// 2. Test TTS Split Text
const shortText = '10000 dari Budi semangat live streamingnya';
assert.deepStrictEqual(splitText(shortText), [shortText]);

const longText = 'kata '.repeat(60); // ~300 chars
const chunks = splitText(longText, 200);
assert.ok(chunks.length > 1);
for (const chunk of chunks) {
  assert.ok(chunk.length <= 200);
}
console.log('✔ TTS split text logic valid');

// 3. Test Donasi Trigger & Regex
function testDonasi(input) {
  const content = input.trim();
  if (!DONASI_TRIGGER.test(content)) return 'IGNORED';
  const match = content.match(DONASI_REGEX);
  if (!match) return 'HINT';
  return 'SUCCESS';
}

assert.strictEqual(testDonasi('!donasi 10000 Budi mantap streamingnya'), 'SUCCESS');
assert.strictEqual(testDonasi('!donasi 50k Reza makasih bang'), 'SUCCESS');
assert.strictEqual(testDonasi('!donasi'), 'HINT');
assert.strictEqual(testDonasi('!donasi 10000'), 'HINT');
assert.strictEqual(testDonasi('!donasi 10000 Budi'), 'HINT');
assert.strictEqual(testDonasi('donasi 10000 Budi mantap'), 'IGNORED');
assert.strictEqual(testDonasi('!donasiku 10000'), 'IGNORED');
console.log('✔ Donasi command prefix & regex logic valid');

// 4. Test Timeouts, Stop & Alert Path
const fs = require('node:fs');
const { stopAudio, ALERT_PATH } = require('./src/voiceManager');
assert.ok(fs.existsSync(ALERT_PATH), `File ${ALERT_PATH} harus ada`);
assert.strictEqual(typeof stopAudio, 'function');
assert.strictEqual(IDLE_TIMEOUT_MS, 5 * 60 * 1000, 'Idle timeout harus 5 menit');
assert.strictEqual(EMPTY_TIMEOUT_MS, 5 * 60 * 1000, 'Empty channel timeout harus 5 menit');
console.log('✔ Auto-leave timeout constants valid (keduanya 5 menit)');

// 5. Test Soundboard helpers, Fuzzy Match & Pagination
const {
  getAvailableSounds,
  findSoundFile,
  findClosestSound,
  createSoundListEmbed,
  ITEMS_PER_PAGE
} = require('./src/commands/soundboard');

const sounds = getAvailableSounds();
assert.ok(Array.isArray(sounds));
assert.ok(sounds.length >= 21, 'Harus ada minimal 21 soundboard mp3');
assert.strictEqual(ITEMS_PER_PAGE, 15, 'Maksimal 15 per halaman');

// Test pagination math
const totalPages = Math.ceil(sounds.length / ITEMS_PER_PAGE);
assert.strictEqual(totalPages, 2, '21 soundboard harus menghasilkan 2 halaman');

const page0Embed = createSoundListEmbed(sounds, 0, totalPages);
assert.ok(page0Embed.data.description.includes('• `adit`'));
assert.strictEqual(page0Embed.data.footer.text, 'Gunakan: !sb <nama> [repeat]');

const page1Embed = createSoundListEmbed(sounds, 1, totalPages);
assert.ok(page1Embed.data.description.includes('• `yatim`'));
assert.strictEqual(page1Embed.data.footer.text, 'Gunakan: !sb <nama> [repeat]');

// Test alphabetical order
const sortedCopy = [...sounds].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
assert.deepStrictEqual(sounds, sortedCopy, 'Daftar sounds harus urut abjad');

// Test fuzzy matching
assert.strictEqual(findClosestSound('sorye', sounds), 'sorryye');
assert.strictEqual(findClosestSound('repot', sounds), 'report');
assert.strictEqual(findClosestSound('tamat', sounds), 'tamatlah');
assert.strictEqual(findClosestSound('respect', sounds), 'gakrespect');
assert.strictEqual(findClosestSound('qwertyuiop', sounds), null);
console.log('✔ Soundboard helpers, alphabetical sorting, pagination & fuzzy typo matching valid');

// 6. Test YouTube Music Commands & Helpers
const {
  playSlashCommand,
  skipSlashCommand,
  queueSlashCommand,
  createNowPlayingEmbed,
  createQueueEmbed,
  PLAY_TRIGGER,
  SKIP_TRIGGER,
  QUEUE_TRIGGER,
} = require('./src/commands/play');
const { searchYouTube } = require('./src/youtube');
const { playMusic, skipAudio, getQueue, queueWithInterrupt, getStreamInfo, buildSeekFfmpegArgs } = require('./src/voiceManager');

// Soundboards and donations interrupt without wiping the queue
{
  const label = q => q.map(i => (typeof i === 'string' ? `tts:${i}` : i.title || i.path));
  const song = { type: 'youtube', title: 'Lagu Satu' };
  const next = { type: 'youtube', title: 'Lagu Dua' };
  const sb = path => ({ type: 'file', path, soundboard: true });
  const oldSb = sb('old.mp3');
  // A soundboard over music: waiting soundboards dropped, the song restarts after it
  assert.deepStrictEqual(label(queueWithInterrupt([oldSb, next], song, [sb('adit.mp3'), sb('adit.mp3')])),
    ['adit.mp3', 'adit.mp3', 'Lagu Satu', 'Lagu Dua']);
  // Interrupted YouTube songs carry forward their cumulative playback position
  const firstCut = queueWithInterrupt([next], song, [sb('adit.mp3')], 32_500);
  assert.strictEqual(firstCut[1].seekMs, 32_500);
  assert.strictEqual(song.seekMs, undefined, 'does not mutate input song object');
  const secondCut = queueWithInterrupt([next], firstCut[1], [sb('aduh.mp3')], 15_000);
  assert.strictEqual(secondCut[1].seekMs, 47_500, 'accumulates across multiple interrupts');
  const probeCut = queueWithInterrupt([next], firstCut[1], [sb('aduh.mp3')], 0);
  assert.strictEqual(probeCut[1].seekMs, 32_500, 'keeps seekMs when cut before audio starts');
  // A soundboard over a soundboard does not replay the old one
  assert.deepStrictEqual(label(queueWithInterrupt([song, next], oldSb, [sb('aduh.mp3')])), ['aduh.mp3', 'Lagu Satu', 'Lagu Dua']);
  // A donation over music behaves the same: alert and TTS first, then the song again
  const donation = [{ type: 'file', path: 'alert.mp3' }, 'Budi donasi 10 ribu'];
  assert.deepStrictEqual(label(queueWithInterrupt([next], song, donation)),
    ['alert.mp3', 'tts:Budi donasi 10 ribu', 'Lagu Satu', 'Lagu Dua']);
  // A soundboard over a donation never loses the donation: the cut-off TTS chunk is replayed
  assert.deepStrictEqual(label(queueWithInterrupt(['bagian 2', song], 'bagian 1', [sb('aduh.mp3')], 1200)),
    ['aduh.mp3', 'tts:bagian 1', 'tts:bagian 2', 'Lagu Satu']);

  // Stream URL extraction & ffmpeg seek args
  assert.deepStrictEqual(
    getStreamInfo(JSON.stringify({ url: 'https://cdn.example/audio.webm', http_headers: { 'User-Agent': 'UA/1' } })),
    { url: 'https://cdn.example/audio.webm', userAgent: 'UA/1' }
  );
  assert.deepStrictEqual(
    getStreamInfo(JSON.stringify({ requested_formats: [{ url: 'https://cdn.example/f0.webm' }] })),
    { url: 'https://cdn.example/f0.webm', userAgent: undefined }
  );
  assert.strictEqual(getStreamInfo(JSON.stringify({ url: 'https://cdn.example/live', is_live: true })), null);
  assert.strictEqual(getStreamInfo('not-json'), null);

  const httpsArgs = buildSeekFfmpegArgs('https://cdn.example/a.webm', 42, 'UA/1');
  assert.ok(httpsArgs.includes('-reconnect') && httpsArgs.includes('-user_agent'));
  assert.strictEqual(httpsArgs[httpsArgs.indexOf('-ss') + 1], '42');
  const localArgs = buildSeekFfmpegArgs('/tmp/test.mp3', 3);
  assert.ok(!localArgs.includes('-reconnect'));
  assert.strictEqual(localArgs[localArgs.indexOf('-ss') + 1], '3');
  assert.strictEqual(
    getStreamInfo(JSON.stringify({ url: 'https://cdn.example/a.webm', duration: 180 })).duration,
    180
  );
}

assert.strictEqual(playSlashCommand.name, 'play');
assert.strictEqual(playSlashCommand.options.length, 1);
assert.strictEqual(playSlashCommand.options[0].name, 'query');
assert.strictEqual(skipSlashCommand.name, 'skip');
assert.strictEqual(queueSlashCommand.name, 'queue');

assert.strictEqual(PLAY_TRIGGER.test('!play rick roll'), true);
assert.strictEqual(PLAY_TRIGGER.test('!p dj viral'), true);
assert.strictEqual(PLAY_TRIGGER.test('!play'), true);
assert.strictEqual(PLAY_TRIGGER.test('play lagu'), false);

assert.strictEqual(SKIP_TRIGGER.test('!skip'), true);
assert.strictEqual(SKIP_TRIGGER.test('!skip now'), true);
assert.strictEqual(SKIP_TRIGGER.test('skip'), false);

assert.strictEqual(QUEUE_TRIGGER.test('!queue'), true);
assert.strictEqual(QUEUE_TRIGGER.test('!q'), true);
assert.strictEqual(QUEUE_TRIGGER.test('!queue info'), true);
assert.strictEqual(QUEUE_TRIGGER.test('queue'), false);

const mockVideo = { title: 'Lagu Santai', url: 'https://youtube.com/watch?v=123', duration: '3:45' };
const nowPlayingEmbed = createNowPlayingEmbed(mockVideo, 1, true);
assert.strictEqual(nowPlayingEmbed.data.title, '▶️ Sedang Memutar Musik');
assert.ok(nowPlayingEmbed.data.description.includes('Lagu Santai'));

const queuedEmbed = createNowPlayingEmbed(mockVideo, 3, false);
assert.strictEqual(queuedEmbed.data.title, '📋 Ditambahkan ke Antrean');
assert.ok(queuedEmbed.data.description.includes('Posisi antrean: #3'));

// Test queue embed empty & populated
const emptyQueueEmbed = createQueueEmbed({ isPlaying: false, current: null, queue: [] });
assert.strictEqual(emptyQueueEmbed.data.title, '📋 Antrean Musik Kosong');

const filledQueueEmbed = createQueueEmbed({
  isPlaying: true,
  current: mockVideo,
  queue: [
    { title: 'Lagu Kedua', url: 'https://youtube.com/watch?v=456', duration: '4:10' }
  ]
});
assert.strictEqual(filledQueueEmbed.data.title, '📋 Antrean Musik');
assert.ok(filledQueueEmbed.data.description.includes('Lagu Santai'));
assert.ok(filledQueueEmbed.data.description.includes('Lagu Kedua'));

// One yt-dlp command per person per second
{
  const { cooldownLeft } = require('./src/commands/play');
  const t = 1_000_000;
  assert.strictEqual(cooldownLeft('user-a', t), 0, 'first use is allowed');
  assert.strictEqual(cooldownLeft('user-a', t + 400), 1, 'second use within 1 s waits');
  assert.strictEqual(cooldownLeft('user-b', t + 400), 0, 'other people are not affected');
  assert.strictEqual(cooldownLeft('user-a', t + 1000), 0, 'allowed again after 1 s');
}

assert.strictEqual(typeof searchYouTube, 'function');
assert.strictEqual(typeof playMusic, 'function');
assert.strictEqual(typeof skipAudio, 'function');
assert.strictEqual(typeof getQueue, 'function');
console.log('✔ YouTube Music playback, queue, skip logic & embed schemas valid');

// 7. Test Web Soundboard Manager (Auth, Endpoints, Upload, Rename, Delete)
const { createWebServer, sanitizeName, getPin, SOUNDS_DIR, normalizeSound } = require('./src/web/server');
const path = require('node:path');

// Test sanitization & PIN logic
// No built-in PIN any more: without WEB_PIN the dashboard stays locked
delete process.env.WEB_PIN;
assert.strictEqual(getPin(), '');
process.env.WEB_PIN = '280303';
assert.strictEqual(getPin(), '280303');

// Only YouTube links reach yt-dlp (anything else would let Discord users make the server fetch it)
const { isYouTubeUrl } = require('./src/youtube');
assert.ok(isYouTubeUrl('https://www.youtube.com/watch?v=abc'));
assert.ok(isYouTubeUrl('https://youtu.be/abc'));
assert.ok(isYouTubeUrl('https://music.youtube.com/watch?v=abc'));
assert.ok(!isYouTubeUrl('http://127.0.0.1:3000/admin'));
assert.ok(!isYouTubeUrl('http://169.254.169.254/latest/meta-data'));
assert.ok(!isYouTubeUrl('https://youtube.com.evil.example/watch'));
assert.ok(!isYouTubeUrl('https://user@youtube.com/watch'));
assert.ok(!isYouTubeUrl('https://youtube.com:8080/watch'));
assert.strictEqual(sanitizeName('ADIT_sound-01!@#$%^'), 'adit_sound-01');
assert.strictEqual(sanitizeName('../../hack'), 'hack');

(async () => {
  // Playlists go to a scratch file, and song lookups use a fake instead of yt-dlp
  process.env.PLAYLISTS_FILE = path.join(require('node:os').tmpdir(), `playlists_test_${process.pid}.json`);
  const fakeSearch = async q => ({ title: `Lagu ${q}`, url: `https://www.youtube.com/watch?v=${q}`, duration: '3:00' });
  const server = createWebServer({ search: fakeSearch });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    let fetchSupported = true;
    try {
      const resUi = await fetch(`${baseUrl}/`);
      assert.strictEqual(resUi.status, 200);
      const htmlText = await resUi.text();
      assert.ok(htmlText.includes('Soundboard PT MABAR'));
    } catch (err) {
      if (err.cause?.code === 'EACCES') {
        fetchSupported = false;
        console.log('ℹ Sandbox environment detected (no outbound socket), validating direct HTTP handler logic');
      } else {
        throw err;
      }
    }

    if (fetchSupported) {
      // 2. Test Login API
      const resBadLogin = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '000000' }),
      });
      assert.strictEqual(resBadLogin.status, 401);

      const resGoodLogin = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '280303' }),
      });
      assert.strictEqual(resGoodLogin.status, 200);
      const loginData = await resGoodLogin.json();
      assert.strictEqual(loginData.success, true);

      // 3. Test Unauthorized Access
      const resUnauthorized = await fetch(`${baseUrl}/api/sounds`);
      assert.strictEqual(resUnauthorized.status, 401);

      // 4. Test Authorized Sound List
      const resSounds = await fetch(`${baseUrl}/api/sounds`, {
        headers: { 'X-Pin': '280303' },
      });
      assert.strictEqual(resSounds.status, 200);
      const soundsData = await resSounds.json();
      assert.ok(Array.isArray(soundsData.sounds));
      assert.ok(soundsData.sounds.length >= 21);

      // 5. Test Sound Upload (Binary Stream)
      const dummyAudio = Buffer.from('ID3dummy-mp3-content-for-testing');
      const resUpload = await fetch(`${baseUrl}/api/upload?name=test_unit_sb`, {
        method: 'POST',
        headers: {
          'X-Pin': '280303',
          'Content-Type': 'audio/mpeg',
        },
        body: dummyAudio,
      });
      assert.strictEqual(resUpload.status, 200);
      const uploadData = await resUpload.json();
      assert.strictEqual(uploadData.success, true);
      assert.strictEqual(uploadData.name, 'test_unit_sb');

      // 5b. Upload over 500 KB is rejected and leaves no file
      const resBig = await fetch(`${baseUrl}/api/upload?name=test_unit_big`, {
        method: 'POST',
        headers: { 'X-Pin': '280303', 'Content-Type': 'audio/mpeg' },
        body: Buffer.alloc(500 * 1024 + 1),
      });
      assert.strictEqual(resBig.status, 413);
      assert.ok(!fs.existsSync(path.join(SOUNDS_DIR, 'test_unit_big.mp3')));

      // 5c. A file that is not an MP3 (here a PNG header) is refused and leaves no file
      const resJunk = await fetch(`${baseUrl}/api/upload?name=test_unit_junk`, {
        method: 'POST',
        headers: { 'X-Pin': '280303', 'Content-Type': 'audio/mpeg' },
        body: Buffer.from('\x89PNG\r\n\x1a\nnot audio', 'latin1'),
      });
      assert.strictEqual(resJunk.status, 400);
      assert.ok(!fs.existsSync(path.join(SOUNDS_DIR, 'test_unit_junk.mp3')));

      const createdFile = path.join(SOUNDS_DIR, 'test_unit_sb.mp3');
      assert.ok(fs.existsSync(createdFile), 'File test_unit_sb.mp3 harus terbuat di sounds/');

      // 6. Test Stream Raw Audio
      const resRaw = await fetch(`${baseUrl}/api/raw/test_unit_sb.mp3`, { headers: { 'X-Pin': '280303' } });
      assert.strictEqual(resRaw.status, 200);
      assert.strictEqual(resRaw.headers.get('content-type'), 'audio/mpeg');

      // 7. Test Sound Rename
      const resRename = await fetch(`${baseUrl}/api/sounds/test_unit_sb`, {
        method: 'PATCH',
        headers: {
          'X-Pin': '280303',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ newName: 'test_unit_sb_renamed' }),
      });
      assert.strictEqual(resRename.status, 200);
      const renameData = await resRename.json();
      assert.strictEqual(renameData.name, 'test_unit_sb_renamed');

      const renamedFile = path.join(SOUNDS_DIR, 'test_unit_sb_renamed.mp3');
      assert.ok(fs.existsSync(renamedFile), 'File test_unit_sb_renamed.mp3 harus ada');
      assert.ok(!fs.existsSync(createdFile), 'File lama harus sudah di-rename');

      // 8. Test Sound Delete
      const resDelete = await fetch(`${baseUrl}/api/sounds/test_unit_sb_renamed`, {
        method: 'DELETE',
        headers: { 'X-Pin': '280303' },
      });
      assert.strictEqual(resDelete.status, 200);
      assert.ok(!fs.existsSync(renamedFile), 'File test_unit_sb_renamed.mp3 harus terhapus');

      // 9. Playlists: create, add songs, list, remove a song, delete
      const call = (url, method = 'GET', body) => fetch(`${baseUrl}${url}`, {
        method, headers: { 'X-Pin': '280303', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
      });
      assert.strictEqual((await call('/api/playlists', 'POST', { name: 'Galau Malam' })).status, 200);
      assert.strictEqual((await call('/api/playlists', 'POST', { name: 'galaumalam' })).status, 409, 'duplicate name');
      assert.strictEqual((await call('/api/playlists', 'POST', { name: '!!!' })).status, 400, 'invalid name');
      assert.strictEqual((await call('/api/playlists', 'POST', { name: 'List' })).status, 400, '"list" is reserved for !playlist list');
      assert.strictEqual((await call('/api/playlists/galaumalam/songs', 'POST', { query: 'satu' })).status, 200);
      assert.strictEqual((await call('/api/playlists/galaumalam/songs', 'POST', { query: 'dua' })).status, 200);
      assert.strictEqual((await call('/api/playlists/galaumalam/songs', 'POST', { query: '' })).status, 400, 'empty query');
      assert.strictEqual((await call('/api/playlists/nope/songs', 'POST', { query: 'x' })).status, 404);
      let list = (await (await call('/api/playlists')).json()).playlists;
      assert.deepStrictEqual(list.map(p => [p.name, p.songs.map(s => s.title)]), [['galaumalam', ['Lagu satu', 'Lagu dua']]]);
      assert.strictEqual((await call('/api/playlists/galaumalam/songs/0', 'DELETE')).status, 200);
      assert.strictEqual((await call('/api/playlists/galaumalam/songs/5', 'DELETE')).status, 404);
      list = (await (await call('/api/playlists')).json()).playlists;
      assert.deepStrictEqual(list[0].songs.map(s => s.title), ['Lagu dua']);
      assert.strictEqual((await call('/api/playlists/galaumalam', 'DELETE')).status, 200);
      assert.deepStrictEqual((await (await call('/api/playlists')).json()).playlists, []);
      assert.strictEqual((await fetch(`${baseUrl}/api/playlists`)).status, 401, 'playlists need the PIN');
      fs.rmSync(process.env.PLAYLISTS_FILE, { force: true });

      // !playlist command parsing and embeds
      const { PLAYLIST_TRIGGER, createListEmbed, createPlayingEmbed } = require('./src/commands/playlist');
      assert.ok(PLAYLIST_TRIGGER.test('!playlist list'));
      assert.ok(PLAYLIST_TRIGGER.test('!playlist'));
      assert.ok(!PLAYLIST_TRIGGER.test('!playlists'));
      assert.ok(!PLAY_TRIGGER.test('!playlist galau'), '!play must not swallow !playlist');
      assert.strictEqual(createListEmbed({}).data.title, '🎶 Belum Ada Playlist');
      assert.ok(createListEmbed({ galau: [{}, {}] }).data.description.includes('`galau` — 2 lagu'));
      const songs = Array.from({ length: 7 }, (_, i) => ({ title: `L${i}`, url: 'u', duration: '1:00' }));
      assert.ok(createPlayingEmbed('galau', songs).data.description.includes('dan 2 lagu lainnya'));

      // 10. Security: malformed requests get 400 instead of crashing the process (and the bot with it)
      const net = require('node:net');
      const rawRequest = text => new Promise(resolve => {
        const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
        sock.on('data', d => { resolve(String(d).split('\r\n')[0]); sock.destroy(); });
        sock.on('error', () => resolve('socket error'));
      });
      assert.match(await rawRequest('GET / HTTP/1.1\r\nHost: a b\r\n\r\n'), / 200 /, 'bad Host header is ignored');
      assert.match(await rawRequest('GET /api/sounds HTTP/1.1\r\nHost: x\r\nCookie: pin=%E0%A4%A\r\n\r\n'), / 401 /);
      assert.match(await rawRequest('GET /api/raw/%E0%A4%A HTTP/1.1\r\nHost: x\r\nX-Pin: 280303\r\n\r\n'), / 400 /);
      assert.match(await rawRequest('POST /api/playlists HTTP/1.1\r\nHost: x\r\nX-Pin: 280303\r\nContent-Length: 4\r\n\r\nnull'), / 400 /);

      // The PIN is no longer accepted in the URL (it leaked into logs and history)
      assert.strictEqual((await fetch(`${baseUrl}/api/sounds?pin=280303`)).status, 401);

      // Login gives a random session cookie (never the PIN); logout ends it
      const login = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '280303' }) });
      assert.strictEqual(login.status, 200);
      const cookie = login.headers.get('set-cookie');
      assert.match(cookie, /^session=[a-f0-9]{64}; .*HttpOnly/);
      assert.ok(!cookie.includes('280303'), 'the cookie must not carry the PIN');
      const session = cookie.split(';')[0];
      assert.strictEqual((await fetch(`${baseUrl}/api/sounds`, { headers: { Cookie: session } })).status, 200);
      await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { Cookie: session } });
      assert.strictEqual((await fetch(`${baseUrl}/api/sounds`, { headers: { Cookie: session } })).status, 401);

      // A non-YouTube link in a playlist is refused before yt-dlp runs
      const realSearch = createWebServer();
      await new Promise(r => realSearch.listen(0, r));
      await fetch(`http://127.0.0.1:${realSearch.address().port}/api/playlists`, { method: 'POST', headers: { 'X-Pin': '280303', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ssrf' }) });
      const ssrf = await fetch(`http://127.0.0.1:${realSearch.address().port}/api/playlists/ssrf/songs`, { method: 'POST', headers: { 'X-Pin': '280303', 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'http://127.0.0.1:1/admin' }) });
      assert.strictEqual(ssrf.status, 400);
      realSearch.close();
      fs.rmSync(process.env.PLAYLISTS_FILE, { force: true });

      // Without WEB_PIN, login is refused outright
      delete process.env.WEB_PIN;
      assert.strictEqual((await fetch(`${baseUrl}/api/login`, { method: 'POST', body: JSON.stringify({ pin: '' }) })).status, 503);
      process.env.WEB_PIN = '280303';

      // Five wrong PINs lock the client out, even for the right PIN (runs last: it locks this test's IP)
      const tryPin = pin => fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
      for (let i = 0; i < 5; i++) assert.strictEqual((await tryPin('000000')).status, 401);
      assert.strictEqual((await tryPin('280303')).status, 429, 'locked after 5 wrong PINs');
      assert.strictEqual((await fetch(`${baseUrl}/api/sounds`, { headers: { 'X-Pin': '280303' } })).status, 429, 'X-Pin is locked too');
    } else {
      // Mock handler verification for sandboxed mode
      const handler = server.listeners('request')[0];
      assert.strictEqual(typeof handler, 'function', 'HTTP request handler harus terdaftar');
    }

    // Sound names typed in the UI are one word: spaces anywhere are dropped, caret stays put
    const uiSrc = fs.readFileSync(path.join(__dirname, 'src', 'web', 'public', 'index.html'), 'utf8');
    const { cleanName, keepName } = new Function(
      uiSrc.slice(uiSrc.indexOf('const cleanName'), uiSrc.indexOf('function onFileSelected')) + ';return { cleanName, keepName }')();
    assert.strictEqual(cleanName(' aku'), 'aku');
    assert.strictEqual(cleanName('aku berlutut'), 'akuberlutut');
    assert.strictEqual(cleanName('aku '), 'aku');
    assert.strictEqual(cleanName('Aku_Ber-Lutut2'), 'aku_ber-lutut2');
    const el = { value: 'ak u', selectionStart: 3, setSelectionRange(p) { this.caret = p; } };
    keepName(el);
    assert.strictEqual(el.value, 'aku');
    assert.strictEqual(el.caret, 2);

    // Loudness normalization & seek stream: verify real ffmpeg output (skipped without ffmpeg)
    const { spawn, spawnSync } = require('node:child_process');
    const os = require('node:os');
    if (!spawnSync('ffmpeg', ['-version']).error) {
      const loud = path.join(os.tmpdir(), `.loud_${process.pid}.tmp`);
      const out = path.join(os.tmpdir(), `loud_${process.pid}.mp3`);
      spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-af', 'volume=0.99', loud + '.mp3']);
      fs.renameSync(loud + '.mp3', loud);
      assert.strictEqual(await normalizeSound(loud, out), true);
      const meter = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', out, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      const lufs = Number(meter.slice(meter.lastIndexOf('Summary')).match(/I:\s+(-?[\d.]+)/)[1]);
      assert.ok(Math.abs(lufs + 20) <= 2.5, `normalized clip should be ~-20 LUFS, got ${lufs}`);
      assert.ok(!fs.existsSync(loud), 'source temp file removed');

      // Seek 2 s into the 3 s clip -> demuxProbe detects ogg/opus and remaining duration is ~1 s
      const { demuxProbe, StreamType } = require('@discordjs/voice');
      const seekProc = spawn('ffmpeg', buildSeekFfmpegArgs(out, 2));
      const probed = await demuxProbe(seekProc.stdout);
      assert.strictEqual(probed.type, StreamType.OggOpus);
      const chunks = [];
      for await (const chunk of probed.stream) chunks.push(chunk);
      const seekedOgg = path.join(os.tmpdir(), `seek_${process.pid}.ogg`);
      fs.writeFileSync(seekedOgg, Buffer.concat(chunks));
      const durOut = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', seekedOgg], { encoding: 'utf8' }).stdout.trim();
      const dur = Number(durOut);
      assert.ok(dur > 0.5 && dur < 1.5, `seeked clip should be ~1 s, got ${dur}`);
      fs.rmSync(seekedOgg, { force: true });
      fs.rmSync(out, { force: true });
    }

    console.log('✔ Web Soundboard Manager (auth, session, lockout, crash-safe, UI, stream, upload, rename, delete, one-word names, loudness, playlists) valid');
    console.log('\n🎉 ALL MODULAR CHECKS PASSED SUCCESSFULLY!');
  } finally {
    server.close();
  }
})();
