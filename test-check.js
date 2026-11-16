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
assert.strictEqual(SOUNDS_PER_PAGE, 12, 'Soundboard memuat 12 sound per halaman (3 baris x 4 tombol)');

// Page 0 (Halaman 1)
const page0 = createPanelPayload(0);
assert.ok(page0.embeds && page0.embeds.length === 1);
assert.strictEqual(page0.embeds[0].data.title, '🎮 PT MABAR - Soundboard');
assert.strictEqual(page0.embeds[0].data.description, 'Klik tombol di bawah untuk langsung memutar sound di Voice Channel.');
assert.ok(page0.embeds[0].data.footer.text.includes('Halaman 1/2'));
assert.strictEqual(page0.components.length, 4, 'Harus ada 4 baris (3 baris sound + 1 baris navigasi/kontrol)');

const page0Buttons = page0.components.flatMap(row => row.components);
const soundBtnsPage0 = page0Buttons.filter(b => b.data.custom_id.startsWith('sb_play_'));
assert.strictEqual(soundBtnsPage0.length, 12, 'Halaman 1 harus memuat 12 sound');
assert.strictEqual(soundBtnsPage0[0].data.label, 'adit', 'Label harus bersih tanpa karakter braille atau spasi aneh');

const prevBtnPage0 = page0Buttons.find(b => b.data.label === '◀ Prev');
const nextBtnPage0 = page0Buttons.find(b => b.data.label === 'Next ▶');
assert.strictEqual(Boolean(prevBtnPage0.data.disabled), true, 'Prev harus disabled di halaman pertama');
assert.strictEqual(Boolean(nextBtnPage0.data.disabled), false, 'Next harus enabled di halaman pertama');

// Page 1 (Halaman 2)
const page1 = createPanelPayload(1);
assert.ok(page1.embeds[0].data.footer.text.includes('Halaman 2/2'));
assert.strictEqual(page1.embeds[0].data.title, '🎮 PT MABAR - Soundboard');

const page1Buttons = page1.components.flatMap(row => row.components);
const soundBtnsPage1 = page1Buttons.filter(b => b.data.custom_id.startsWith('sb_play_'));
const expectedRemaining = sounds.length - 12;
assert.strictEqual(soundBtnsPage1.length, expectedRemaining, `Halaman 2 harus memuat sisa ${expectedRemaining} sound`);

const nextBtnPage1 = page1Buttons.find(b => b.data.label === 'Next ▶');
assert.strictEqual(Boolean(nextBtnPage1.data.disabled), true, 'Next harus disabled di halaman terakhir');

// Verifikasi tombol Stop & Refresh
assert.ok(page0Buttons.find(b => b.data.custom_id === 'sb_ctrl_stop'), 'Tombol Stop harus ada');
assert.ok(page0Buttons.find(b => b.data.custom_id.startsWith('sb_ctrl_refresh')), 'Tombol Refresh harus ada');
console.log('✔ Simple Soundboard Panel (Clean embed, 4 buttons/row, pagination, channel flexibility, override audio) valid');

console.log('\n🎉 ALL MODULAR CHECKS PASSED SUCCESSFULLY!');
