const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { playDonation } = require('../voiceManager');

const donasiSlashCommand = new SlashCommandBuilder()
  .setName('donasi')
  .setDescription('Putar suara donasi TTS ala Saweria/YouTube')
  .addStringOption(option =>
    option
      .setName('nominal')
      .setDescription('Jumlah donasi (contoh: 10000 atau 10k)')
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('nama')
      .setDescription('Nama pengirim donasi')
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('pesan')
      .setDescription('Pesan donasi')
      .setRequired(true)
  );

const DONASI_TRIGGER = /^!donasi(?:\s|$)/i;
const DONASI_REGEX = /^!donasi\s+(\S+)\s+(\S+)\s+(.+)$/is;

async function handleMessage(message) {
  const content = message.content.trim();
  if (!DONASI_TRIGGER.test(content)) return false;

  console.log(`[Chat Detected] "${content}" dari ${message.author.tag}`);

  const match = content.match(DONASI_REGEX);
  if (!match) {
    // Parameter tidak lengkap (hanya !donasi atau kurang dari 3 argumen)
    console.log(`[Hint Triggered] Mengirim hint ke #${message.channel.name || message.channel.id}`);
    const hintEmbed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setDescription('!donasi <nominal> <nama> <pesan>');

    await message.channel.send({ embeds: [hintEmbed] }).catch((err) => {
      console.error('❌ Gagal mengirim pesan hint:', err.message);
    });
    return true;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) return true; // Silent: pengirim tidak di voice channel

  const [, nominal, nama, pesan] = match;
  const speechText = `${nominal} dari ${nama} ${pesan}`;

  try {
    await playDonation(voiceChannel, speechText);
  } catch (err) {
    console.error('Error memproses donasi dari teks:', err);
  }
  return true;
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'donasi') return;

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    const errorEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setDescription('⚠️ Masuk voice channel terlebih dahulu!');

    return interaction.reply({
      embeds: [errorEmbed],
      ephemeral: true,
    });
  }

  const nominal = interaction.options.getString('nominal');
  const nama = interaction.options.getString('nama');
  const pesan = interaction.options.getString('pesan');
  const speechText = `${nominal} dari ${nama} ${pesan}`;

  // Silent acknowledge
  await interaction.deferReply({ ephemeral: true });
  await interaction.deleteReply().catch(() => {});

  try {
    await playDonation(voiceChannel, speechText);
  } catch (error) {
    console.error('Error handling /donasi:', error);
  }
}

module.exports = {
  donasiSlashCommand,
  handleMessage,
  handleInteraction,
  DONASI_TRIGGER,
  DONASI_REGEX,
};
