const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { getAvailableSounds, findSoundFile } = require('./soundboard');
const { playDonation, playSoundboard, stopAudio } = require('../voiceManager');

const PANEL_CHANNEL_NAME = 'bot-ptmabar';
const PANEL_TRIGGER = /^!panel(?:\s|$)/i;

const panelSlashCommand = new SlashCommandBuilder()
  .setName('panel')
  .setDescription(`Tampilkan interactive control panel di channel #${PANEL_CHANNEL_NAME}`);

function createPanelPayload() {
  const sounds = getAvailableSounds();

  const panelEmbed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('🎮 PT MABAR - Control Panel')
    .setDescription(
      'Gunakan tombol dan menu di bawah untuk mengontrol bot tanpa perlu mengetik perintah:\n\n' +
      '• 💰 **Kirim Donasi TTS**: Isi form pop-up untuk memutar suara donasi & alert.\n' +
      '• 🔊 **Soundboard**: Pilih sound di dropdown menu untuk diputar di Voice Channel.\n' +
      '• ⏹️ **Stop Audio**: Hentikan pemutaran audio & bersihkan antrean.\n' +
      '• 🔄 **Refresh**: Muat ulang daftar soundboard terbaru.'
    )
    .setFooter({ text: `Control Panel • #${PANEL_CHANNEL_NAME}` });

  const rows = [];

  // Dropdown Soundboard (maksimal 25 per menu sesuai limit Discord API)
  if (sounds.length > 0) {
    const chunk = sounds.slice(0, 25);
    const options = chunk.map(sound => ({
      label: sound,
      value: sound,
      description: `Putar soundboard "${sound}"`,
      emoji: '🔊',
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('panel_select_sound')
      .setPlaceholder('🔊 Pilih soundboard untuk diputar...')
      .addOptions(options);

    rows.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  // Tombol Aksi
  const btnDonasi = new ButtonBuilder()
    .setCustomId('panel_btn_donasi')
    .setLabel('Kirim Donasi TTS')
    .setEmoji('💰')
    .setStyle(ButtonStyle.Success);

  const btnStop = new ButtonBuilder()
    .setCustomId('panel_btn_stop')
    .setLabel('Stop Audio')
    .setEmoji('⏹️')
    .setStyle(ButtonStyle.Danger);

  const btnRefresh = new ButtonBuilder()
    .setCustomId('panel_btn_refresh')
    .setLabel('Refresh')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary);

  rows.push(new ActionRowBuilder().addComponents(btnDonasi, btnStop, btnRefresh));

  return {
    embeds: [panelEmbed],
    components: rows,
  };
}

async function handleMessage(message) {
  const content = message.content.trim();

  // Jika pesan dikirim di channel khusus #bot-ptmabar
  if (message.channel.name === PANEL_CHANNEL_NAME) {
    // Hapus pesan pengguna agar channel selalu bersih hanya ada panel bot
    await message.delete().catch(() => {});

    // Jika perintahnya adalah !panel, kirim pesan control panel
    if (PANEL_TRIGGER.test(content)) {
      await message.channel.send(createPanelPayload()).catch((err) => {
        console.error('❌ Gagal mengirim control panel:', err.message);
      });
    }
    return true;
  }

  // Jika perintah !panel dipanggil di luar channel #bot-ptmabar
  if (PANEL_TRIGGER.test(content)) {
    const errorEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setDescription(`⚠️ Control panel hanya dapat diinstal di channel \`#${PANEL_CHANNEL_NAME}\`!`);

    await message.channel.send({ embeds: [errorEmbed] }).catch((err) => {
      console.error('❌ Gagal mengirim error channel panel:', err.message);
    });
    return true;
  }

  return false;
}

async function handleInteraction(interaction) {
  // 1. Slash Command /panel
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    if (interaction.channel?.name !== PANEL_CHANNEL_NAME) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription(`⚠️ Control panel hanya dapat diinstal di channel \`#${PANEL_CHANNEL_NAME}\`!`);
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      return true;
    }

    await interaction.reply(createPanelPayload());
    return true;
  }

  // 2. Tombol: Donasi TTS (Buka Modal Form)
  if (interaction.isButton() && interaction.customId === 'panel_btn_donasi') {
    const modal = new ModalBuilder()
      .setCustomId('panel_modal_donasi')
      .setTitle('💰 Kirim Donasi TTS');

    const nominalInput = new TextInputBuilder()
      .setCustomId('donasi_nominal')
      .setLabel('Nominal Donasi (contoh: 10000 atau 10k)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('10000')
      .setRequired(true);

    const namaInput = new TextInputBuilder()
      .setCustomId('donasi_nama')
      .setLabel('Nama Pengirim')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Budi')
      .setRequired(true);

    const pesanInput = new TextInputBuilder()
      .setCustomId('donasi_pesan')
      .setLabel('Pesan Donasi')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Semangat mabar bang!')
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nominalInput),
      new ActionRowBuilder().addComponents(namaInput),
      new ActionRowBuilder().addComponents(pesanInput)
    );

    await interaction.showModal(modal);
    return true;
  }

  // 3. Submit Modal Donasi
  if (interaction.isModalSubmit() && interaction.customId === 'panel_modal_donasi') {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      const noVoiceEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription('⚠️ Masuk voice channel terlebih dahulu!');
      await interaction.reply({ embeds: [noVoiceEmbed], ephemeral: true });
      return true;
    }

    const nominal = interaction.fields.getTextInputValue('donasi_nominal');
    const nama = interaction.fields.getTextInputValue('donasi_nama');
    const pesan = interaction.fields.getTextInputValue('donasi_pesan');

    try {
      await playDonation(voiceChannel, nominal, nama, pesan);
      const successEmbed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setDescription(`✅ Donasi TTS dari **${nama}** (${nominal}) sedang diputar!`);
      await interaction.reply({ embeds: [successEmbed], ephemeral: true });
    } catch (err) {
      console.error('❌ Gagal memutar donasi dari modal panel:', err);
      const errEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription('❌ Terjadi kesalahan saat memutar donasi.');
      await interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }
    return true;
  }

  // 4. Select Menu: Putar Soundboard
  if (interaction.isStringSelectMenu() && interaction.customId === 'panel_select_sound') {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      const noVoiceEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription('⚠️ Masuk voice channel terlebih dahulu!');
      await interaction.reply({ embeds: [noVoiceEmbed], ephemeral: true });
      return true;
    }

    const soundName = interaction.values[0];
    const filePath = findSoundFile(soundName);
    if (!filePath) {
      const notFoundEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription(`⚠️ Sound \`${soundName}\` tidak ditemukan.`);
      await interaction.reply({ embeds: [notFoundEmbed], ephemeral: true });
      return true;
    }

    try {
      await playSoundboard(voiceChannel, filePath, 1);
      const playingEmbed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setDescription(`🔊 Memutar soundboard **${soundName}**`);
      await interaction.reply({ embeds: [playingEmbed], ephemeral: true });
    } catch (err) {
      console.error('❌ Gagal memutar soundboard dari panel:', err);
      const errEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription('❌ Terjadi kesalahan saat memutar soundboard.');
      await interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }
    return true;
  }

  // 5. Tombol: Stop Audio
  if (interaction.isButton() && interaction.customId === 'panel_btn_stop') {
    const guildId = interaction.guild?.id;
    if (guildId) {
      stopAudio(guildId);
    }
    const stopEmbed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setDescription('⏹️ Pemutaran audio dihentikan dan bot keluar.');
    await interaction.reply({ embeds: [stopEmbed], ephemeral: true });
    return true;
  }

  // 6. Tombol: Refresh Panel
  if (interaction.isButton() && interaction.customId === 'panel_btn_refresh') {
    await interaction.update(createPanelPayload()).catch((err) => {
      console.error('❌ Gagal refresh control panel:', err.message);
    });
    return true;
  }

  return false;
}

module.exports = {
  handleMessage,
  handleInteraction,
  createPanelPayload,
  panelSlashCommand,
  PANEL_CHANNEL_NAME,
  PANEL_TRIGGER,
};
