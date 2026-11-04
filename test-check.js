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

console.log('\n🎉 ALL MODULAR CHECKS PASSED SUCCESSFULLY!');
