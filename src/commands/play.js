const path = require('node:path');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { searchYouTube } = require('../youtube');
const { playMusic, skipAudio, getQueue } = require('../voiceManager');

const PLAY_TRIGGER = /^!(?:play|p)(?:\s|$)/i;
const SKIP_TRIGGER = /^!skip(?:\s|$)/i;
const QUEUE_TRIGGER = /^!(?:queue|q)(?:\s|$)/i;

const playSlashCommand = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Putar musik dari YouTube di voice channel')
  .addStringOption(option =>
    option
      .setName('query')
      .setDescription('Judul lagu atau URL YouTube')
      .setRequired(true)
  );

const skipSlashCommand = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Lewati lagu yang sedang diputar');

const queueSlashCommand = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Lihat daftar antrean lagu yang sedang diputar');

function createNowPlayingEmbed(video, position, isPlayingNow) {
  if (isPlayingNow) {
    return new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle('▶️ Sedang Memutar Musik')
      .setDescription(`**[${video.title}](${video.url})**\n⏱️ Durasi: \`${video.duration}\``);
  }

  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('📋 Ditambahkan ke Antrean')
    .setDescription(`**[${video.title}](${video.url})**\n⏱️ Durasi: \`${video.duration}\` • Posisi antrean: #${position}`);
}

function formatQueueItem(item) {
  const title = item.title || (item.type === 'file' ? path.basename(item.path, path.extname(item.path)) : 'Audio TTS');
  const dur = item.duration ? ` (\`${item.duration}\`)` : '';
  return item.url ? `[${title}](${item.url})${dur}` : `\`${title}\`${dur}`;
}

function createQueueEmbed(queueData) {
  const { current, queue } = queueData;
  if (!current && (!queue || queue.length === 0)) {
    return new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle('📋 Antrean Musik Kosong')
      .setDescription('Tidak ada lagu yang sedang diputar atau mengantre.\nGunakan `!play <judul/url>` untuk memutar lagu.');
  }

  const lines = [];
  if (current) {
    lines.push(`**▶️ Sedang Diputar:**\n${formatQueueItem(current)}\n`);
  }

  if (queue && queue.length > 0) {
    lines.push('**Daftar Antrean Berikutnya:**');
    const displayItems = queue.slice(0, 10);
    displayItems.forEach((item, index) => {
      lines.push(`\`${index + 1}.\` ${formatQueueItem(item)}`);
    });

    if (queue.length > 10) {
      lines.push(`\n*...dan ${queue.length - 10} lagu lainnya.*`);
    }
  }

  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('📋 Antrean Musik')
    .setDescription(lines.join('\n'));
}

async function handleMessage(message) {
  const content = message.content.trim();

  // 1. Perintah !skip
  if (SKIP_TRIGGER.test(content)) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription('⚠️ Masuk voice channel terlebih dahulu!');
      await message.channel.send({ embeds: [errorEmbed] }).catch(() => {});
      return true;
    }

    skipAudio(message.guild.id);
    const skipEmbed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setDescription('⏭️ Lagu berhasil dilewati!');
    await message.channel.send({ embeds: [skipEmbed] }).catch(() => {});
    return true;
  }

  // 2. Perintah !queue atau !q
  if (QUEUE_TRIGGER.test(content)) {
    const queueData = getQueue(message.guild.id);
    const embed = createQueueEmbed(queueData);
    await message.channel.send({ embeds: [embed] }).catch(() => {});
    return true;
  }

  // 3. Perintah !play atau !p
  if (!PLAY_TRIGGER.test(content)) return false;

  const query = content.replace(/^!(?:play|p)\s*/i, '').trim();
  if (!query) {
    const hintEmbed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setDescription('🎵 Gunakan: `!play <judul lagu atau URL YouTube>`');
    await message.channel.send({ embeds: [hintEmbed] }).catch(() => {});
    return true;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    const errorEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setDescription('⚠️ Masuk voice channel terlebih dahulu!');
    await message.channel.send({ embeds: [errorEmbed] }).catch(() => {});
    return true;
  }

  try {
    const video = await searchYouTube(query);
    const result = await playMusic(voiceChannel, video);
    const embed = createNowPlayingEmbed(video, result.position, result.isPlayingNow);
    await message.channel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error('❌ Gagal memutar musik YouTube:', err.message);
    const errEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setDescription('❌ Video YouTube tidak ditemukan atau gagal diputar.');
    await message.channel.send({ embeds: [errEmbed] }).catch(() => {});
  }

  return true;
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return false;

  // 1. Slash Command /play
  if (interaction.commandName === 'play') {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription('⚠️ Masuk voice channel terlebih dahulu!');
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      return true;
    }

    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

    try {
      const video = await searchYouTube(query);
      const result = await playMusic(voiceChannel, video);
      const embed = createNowPlayingEmbed(video, result.position, result.isPlayingNow);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Gagal memutar musik YouTube (/play):', err.message);
      const errEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription('❌ Video YouTube tidak ditemukan atau gagal diputar.');
      await interaction.editReply({ embeds: [errEmbed] });
    }
    return true;
  }

  // 2. Slash Command /skip
  if (interaction.commandName === 'skip') {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription('⚠️ Masuk voice channel terlebih dahulu!');
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      return true;
    }

    skipAudio(interaction.guild.id);
    const skipEmbed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setDescription('⏭️ Lagu berhasil dilewati!');
    await interaction.reply({ embeds: [skipEmbed] });
    return true;
  }

  // 3. Slash Command /queue
  if (interaction.commandName === 'queue') {
    const queueData = getQueue(interaction.guild.id);
    const embed = createQueueEmbed(queueData);
    await interaction.reply({ embeds: [embed] });
    return true;
  }

  return false;
}

module.exports = {
  playSlashCommand,
  skipSlashCommand,
  queueSlashCommand,
  handleMessage,
  handleInteraction,
  createNowPlayingEmbed,
  createQueueEmbed,
  PLAY_TRIGGER,
  SKIP_TRIGGER,
  QUEUE_TRIGGER,
};
