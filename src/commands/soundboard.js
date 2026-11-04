const fs = require('node:fs');
const path = require('node:path');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');
const { playSoundboard } = require('../voiceManager');

const SOUNDS_DIR = path.join(__dirname, '..', '..', 'sounds');
const ITEMS_PER_PAGE = 15;

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

function createSoundListEmbed(sounds, page, totalPages) {
  const start = page * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const pageItems = sounds.slice(start, end);

  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('🔊 Daftar Soundboard')
    .setDescription(pageItems.map(s => `• \`${s}\``).join('\n'))
    .setFooter({ text: 'Gunakan: !sb <nama> [repeat]' });
}

function createPaginationRow(page, totalPages, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('sb_prev')
      .setLabel('◀ Prev')
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(disabled || page === 0),
    new ButtonBuilder()
      .setCustomId('sb_next')
      .setLabel('Next ▶')
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(disabled || page >= totalPages - 1)
  );
}

async function handleMessage(message) {
  const content = message.content.trim();
  if (!/^!sb(?:\s|$)/i.test(content)) return false;

  const parts = content.split(/\s+/).slice(1); // Potong '!sb'

  // Kasus 1: !sb list (dengan pagination tombol)
  if (parts.length > 0 && parts[0].toLowerCase() === 'list') {
    const sounds = getAvailableSounds();

    if (sounds.length === 0) {
      const emptyEmbed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🔊 Daftar Soundboard')
        .setDescription('Belum ada file audio di folder `sounds/`.');

      await message.channel.send({ embeds: [emptyEmbed] }).catch((err) => {
        console.error('❌ Gagal mengirim list soundboard:', err.message);
      });
      return true;
    }

    let currentPage = 0;
    const totalPages = Math.ceil(sounds.length / ITEMS_PER_PAGE);

    const embed = createSoundListEmbed(sounds, currentPage, totalPages);
    const row = totalPages > 1 ? createPaginationRow(currentPage, totalPages) : null;

    const sentMessage = await message.channel.send({
      embeds: [embed],
      components: row ? [row] : [],
    }).catch((err) => {
      console.error('❌ Gagal mengirim list soundboard:', err.message);
    });

    if (!sentMessage || totalPages <= 1) return true;

    const collector = sentMessage.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 120_000, // 2 menit
    });

    collector.on('collect', async (interaction) => {
      if (interaction.customId === 'sb_prev') {
        if (currentPage > 0) currentPage--;
      } else if (interaction.customId === 'sb_next') {
        if (currentPage < totalPages - 1) currentPage++;
      }

      await interaction.update({
        embeds: [createSoundListEmbed(sounds, currentPage, totalPages)],
        components: [createPaginationRow(currentPage, totalPages)],
      }).catch(() => {});
    });

    collector.on('end', async () => {
      await sentMessage.edit({
        components: [createPaginationRow(currentPage, totalPages, true)],
      }).catch(() => {});
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
    console.error('❌ Error memputar soundboard:', err);
  }

  return true;
}

module.exports = {
  handleMessage,
  getAvailableSounds,
  findSoundFile,
  findClosestSound,
  levenshteinDistance,
  createSoundListEmbed,
  ITEMS_PER_PAGE,
};
