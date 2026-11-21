const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { searchYouTube } = require('../youtube');
const { playMusic, skipAudio } = require('../voiceManager');

const PLAY_TRIGGER = /^!(?:play|p)(?:\s|$)/i;
const SKIP_TRIGGER = /^!skip(?:\s|$)/i;

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

  // 2. Perintah !play atau !p
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

  return false;
}

module.exports = {
  playSlashCommand,
  skipSlashCommand,
  handleMessage,
  handleInteraction,
  createNowPlayingEmbed,
  PLAY_TRIGGER,
  SKIP_TRIGGER,
};
