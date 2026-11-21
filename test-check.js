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

// 6. Test Launchpad Component, Pagination & Channel Restriction
const {
  panelSlashCommand,
  createPanelPayload,
  PANEL_CHANNEL_NAME,
  PANEL_TRIGGER,
  SOUNDS_PER_PAGE,
} = require('./src/commands/panel');

assert.strictEqual(panelSlashCommand.name, 'panel');
assert.strictEqual(PANEL_CHANNEL_NAME, 'bot-ptmabar', 'Channel control panel harus wajib bot-ptmabar');
assert.strictEqual(PANEL_TRIGGER.test('!panel'), true);
assert.strictEqual(PANEL_TRIGGER.test('!panel now'), true);
assert.strictEqual(PANEL_TRIGGER.test('panel'), false);
assert.strictEqual(PANEL_TRIGGER.test('!panelku'), false);
assert.strictEqual(SOUNDS_PER_PAGE, 20, 'Soundboard memuat 20 sound per halaman (tampilan 4x5)');

// Page 0 (Halaman 1)
const page0 = createPanelPayload(0);
assert.ok(page0.embeds && page0.embeds.length === 1);
assert.strictEqual(page0.embeds[0].data.title, '🎮 PT MABAR - Soundboard');
assert.strictEqual(page0.embeds[0].data.description, 'Klik tombol di bawah untuk langsung memutar sound di Voice Channel.');
assert.ok(page0.embeds[0].data.footer.text.includes('Halaman 1/2'));
assert.strictEqual(page0.components.length, 5, 'Harus ada 5 baris (4 baris sound + 1 baris navigasi/kontrol)');

// Verifikasi 4 baris pertama masing-masing tepat 5 tombol sound (tampilan 4x5)
for (let i = 0; i < 4; i++) {
  assert.strictEqual(page0.components[i].components.length, 5, `Baris ${i + 1} harus tepat 5 tombol`);
}

// Baris ke-5: Prev, Stop, Next, Refresh (4 tombol)
const navRowPage0 = page0.components[4];
assert.strictEqual(navRowPage0.components.length, 4, 'Baris kontrol harus sejajar 4 tombol: Prev, Stop, Next, Refresh');

const page0Buttons = page0.components.flatMap(row => row.components);
const soundBtnsPage0 = page0Buttons.filter(b => b.data.custom_id.startsWith('sb_play_'));
assert.strictEqual(soundBtnsPage0.length, 20, 'Halaman 1 harus memuat 20 sound');

const prevBtnPage0 = navRowPage0.components.find(b => b.data.label === '◀ Prev');
const stopBtnPage0 = navRowPage0.components.find(b => b.data.label === 'Stop');
const nextBtnPage0 = navRowPage0.components.find(b => b.data.label === 'Next ▶');
const refreshBtnPage0 = navRowPage0.components.find(b => b.data.label === 'Refresh');
assert.ok(prevBtnPage0 && stopBtnPage0 && nextBtnPage0 && refreshBtnPage0, 'Semua 4 tombol kontrol harus ada di baris bawah');
assert.strictEqual(Boolean(prevBtnPage0.data.disabled), true, 'Prev harus disabled di halaman pertama');
assert.strictEqual(Boolean(nextBtnPage0.data.disabled), false, 'Next harus enabled di halaman pertama');

// Page 1 (Halaman 2)
const page1 = createPanelPayload(1);
assert.ok(page1.embeds[0].data.footer.text.includes('Halaman 2/2'));
assert.strictEqual(page1.embeds[0].data.title, '🎮 PT MABAR - Soundboard');
assert.strictEqual(page1.components.length, 2, 'Halaman 2 harus 2 baris (1 baris sisa sound + 1 baris kontrol)');

const page1Buttons = page1.components.flatMap(row => row.components);
const soundBtnsPage1 = page1Buttons.filter(b => b.data.custom_id.startsWith('sb_play_'));
const expectedRemaining = sounds.length - 20;
assert.strictEqual(soundBtnsPage1.length, expectedRemaining, `Halaman 2 harus memuat sisa ${expectedRemaining} sound`);

const nextBtnPage1 = page1.components[1].components.find(b => b.data.label === 'Next ▶');
assert.strictEqual(Boolean(nextBtnPage1.data.disabled), true, 'Next harus disabled di halaman terakhir');
console.log('✔ Simple Soundboard Panel (4x5 sound grid + bottom row controls, clean embed, voice switch, channel lock) valid');

// 7. Test YouTube Music Commands & Helpers
const {
  playSlashCommand,
  skipSlashCommand,
  createNowPlayingEmbed,
  PLAY_TRIGGER,
  SKIP_TRIGGER,
} = require('./src/commands/play');
const { searchYouTube } = require('./src/youtube');
const { playMusic, skipAudio } = require('./src/voiceManager');

assert.strictEqual(playSlashCommand.name, 'play');
assert.strictEqual(playSlashCommand.options.length, 1);
assert.strictEqual(playSlashCommand.options[0].name, 'query');
assert.strictEqual(skipSlashCommand.name, 'skip');

assert.strictEqual(PLAY_TRIGGER.test('!play rick roll'), true);
assert.strictEqual(PLAY_TRIGGER.test('!p dj viral'), true);
assert.strictEqual(PLAY_TRIGGER.test('!play'), true);
assert.strictEqual(PLAY_TRIGGER.test('play lagu'), false);

assert.strictEqual(SKIP_TRIGGER.test('!skip'), true);
assert.strictEqual(SKIP_TRIGGER.test('!skip now'), true);
assert.strictEqual(SKIP_TRIGGER.test('skip'), false);

const mockVideo = { title: 'Lagu Santai', url: 'https://youtube.com/watch?v=123', duration: '3:45' };
const nowPlayingEmbed = createNowPlayingEmbed(mockVideo, 1, true);
assert.strictEqual(nowPlayingEmbed.data.title, '▶️ Sedang Memutar Musik');
assert.ok(nowPlayingEmbed.data.description.includes('Lagu Santai'));

const queuedEmbed = createNowPlayingEmbed(mockVideo, 3, false);
assert.strictEqual(queuedEmbed.data.title, '📋 Ditambahkan ke Antrean');
assert.ok(queuedEmbed.data.description.includes('Posisi antrean: #3'));

assert.strictEqual(typeof searchYouTube, 'function');
assert.strictEqual(typeof playMusic, 'function');
assert.strictEqual(typeof skipAudio, 'function');
console.log('✔ YouTube Music playback, skip logic & embed schemas valid');

console.log('\n🎉 ALL MODULAR CHECKS PASSED SUCCESSFULLY!');
