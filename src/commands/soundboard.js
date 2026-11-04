const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder } = require('discord.js');
const { playSoundboard } = require('../voiceManager');

const SOUNDS_DIR = path.join(__dirname, '..', '..', 'sounds');

function getAvailableSounds() {
  if (!fs.existsSync(SOUNDS_DIR)) return [];
  return fs.readdirSync(SOUNDS_DIR)
    .filter(file => file.toLowerCase().endsWith('.mp3'))
    .map(file => path.basename(file, path.extname(file)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function findSoundFile(name) {
  if (!fs.existsSync(SOUNDS_DIR)) return null;
  const target = name.toLowerCase().trim();
  const files = fs.readdirSync(SOUNDS_DIR);
  const match = files.find(file => path.basename(file, path.extname(file)).toLowerCase() === target);
  return match ? path.join(SOUNDS_DIR, match) : null;
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,       // deletion
        dp[i][j - 1] + 1,       // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[m][n];
}

function findClosestSound(query, soundList) {
  const q = query.toLowerCase().trim();
  if (!q || soundList.length === 0) return null;

  // 1. Substring match (contoh: 'respect' cocok ke 'gakrespect')
  const substringMatch = soundList.find(s => {
    const lower = s.toLowerCase();
    return lower.includes(q) || q.includes(lower);
  });
  if (substringMatch) return substringMatch;

  // 2. Levenshtein distance (toleransi typo hingga ~50% panjang kata)
  let bestMatch = null;
  let minDistance = Infinity;

  for (const s of soundList) {
    const dist = levenshteinDistance(q, s.toLowerCase());
    const maxLen = Math.max(q.length, s.length);
    if (dist <= Math.floor(maxLen * 0.5) && dist < minDistance) {
      minDistance = dist;
      bestMatch = s;
    }
  }

  return bestMatch;
}

async function handleMessage(message) {
  const content = message.content.trim();
  if (!/^!sb(?:\s|$)/i.test(content)) return false;

  const parts = content.split(/\s+/).slice(1); // Potong '!sb'

  // Kasus 1: !sb list
  if (parts.length > 0 && parts[0].toLowerCase() === 'list') {
    const sounds = getAvailableSounds();
    const embed = new EmbedBuilder().setColor(0xF1C40F);

    if (sounds.length === 0) {
      embed.setTitle('🔊 Daftar Soundboard')
        .setDescription('Belum ada file audio di folder `sounds/`.');
    } else {
      embed.setTitle('🔊 Daftar Soundboard')
        .setDescription(sounds.map(s => `• \`${s}\``).join('\n'))
        .setFooter({ text: 'Gunakan: !sb <nama> [repeat]' });
    }

    await message.channel.send({ embeds: [embed] }).catch((err) => {
      console.error('❌ Gagal mengirim list soundboard:', err.message);
    });
    return true;
  }

  // Kasus 2: Hanya ketik !sb tanpa argumen
  if (parts.length === 0) {
    const hintEmbed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setDescription('!sb <nama> [repeat]\nKetik `!sb list` untuk melihat daftar sound.');

    await message.channel.send({ embeds: [hintEmbed] }).catch((err) => {
      console.error('❌ Gagal mengirim hint soundboard:', err.message);
    });
    return true;
  }

  // Kasus 3: !sb <nama> [repeat]
  const soundName = parts[0];
  const repeat = parts[1] ? parseInt(parts[1], 10) || 1 : 1;

  const filePath = findSoundFile(soundName);
  if (!filePath) {
    const available = getAvailableSounds();
    const suggestion = findClosestSound(soundName, available);

    const description = suggestion
      ? `Sound \`${soundName}\` tidak ditemukan.\nMungkin maksud kamu: \`!sb ${suggestion}\`?\n\nKetik \`!sb list\` untuk melihat daftar sound.`
      : `Sound \`${soundName}\` tidak ditemukan.\nKetik \`!sb list\` untuk melihat daftar sound.`;

    const notFoundEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setDescription(description);

    await message.channel.send({ embeds: [notFoundEmbed] }).catch((err) => {
      console.error('❌ Gagal mengirim pesan soundboard not found:', err.message);
    });
    return true;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    const noVoiceEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setDescription('⚠️ Masuk voice channel terlebih dahulu!');

    await message.channel.send({ embeds: [noVoiceEmbed] }).catch((err) => {
      console.error('❌ Gagal mengirim pesan no voice:', err.message);
    });
    return true;
  }

  try {
    await playSoundboard(voiceChannel, filePath, repeat);
  } catch (err) {
    console.error('❌ Error memutar soundboard:', err);
  }

  return true;
}

module.exports = {
  handleMessage,
  getAvailableSounds,
  findSoundFile,
  findClosestSound,
  levenshteinDistance,
};
