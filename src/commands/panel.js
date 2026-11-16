const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getAvailableSounds, findSoundFile } = require('./soundboard');
const { playSoundboard, stopAudio } = require('../voiceManager');

const PANEL_CHANNEL_NAME = 'bot-ptmabar';
const PANEL_TRIGGER = /^!panel(?:\s|$)/i;
const SOUNDS_PER_PAGE = 20;

const panelSlashCommand = new SlashCommandBuilder()
  .setName('panel')
  .setDescription(`Tampilkan soundboard control panel di channel #${PANEL_CHANNEL_NAME}`);

function createPanelPayload(page = 0) {
  const sounds = getAvailableSounds();
  const totalSounds = sounds.length;
  const needsPagination = totalSounds > 23;

  let pageSounds = sounds;
  let totalPages = 1;

  if (needsPagination) {
    totalPages = Math.ceil(totalSounds / SOUNDS_PER_PAGE);
    page = Math.max(0, Math.min(page, totalPages - 1));
    const start = page * SOUNDS_PER_PAGE;
    pageSounds = sounds.slice(start, start + SOUNDS_PER_PAGE);
  }

  const panelEmbed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('🎮 PT MABAR - Soundboard Panel')
    .setDescription(
      'Klik tombol di bawah untuk langsung memutar sound di Voice Channel.\n' +
      '*Pastikan kamu sudah bergabung ke dalam Voice Channel.*'
    )
    .setFooter({
      text: needsPagination
        ? `Halaman ${page + 1}/${totalPages} • #${PANEL_CHANNEL_NAME}`
        : `Total ${totalSounds} Sound • #${PANEL_CHANNEL_NAME}`,
    });

  const rows = [];

  if (!needsPagination) {
    // Mode Single Page (<= 23 sound): Muat semua sound + Stop + Refresh dalam 5 baris (maks 25 tombol)
    let currentRow = new ActionRowBuilder();
    let countInRow = 0;

    for (const sound of pageSounds) {
      if (countInRow === 5) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
        countInRow = 0;
      }
      currentRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`sb_play_${sound}`)
          .setLabel(sound)
          .setStyle(ButtonStyle.Secondary)
      );
      countInRow++;
    }

    if (countInRow >= 4) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }

    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId('sb_ctrl_stop')
        .setLabel('Stop')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('sb_ctrl_refresh')
        .setLabel('Refresh')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Primary)
    );
    rows.push(currentRow);
  } else {
    // Mode Pagination (> 23 sound): 4 baris sound (maks 20) + 1 baris navigasi & kontrol
    for (let i = 0; i < pageSounds.length; i += 5) {
      const slice = pageSounds.slice(i, i + 5);
      const row = new ActionRowBuilder().addComponents(
        slice.map(sound =>
          new ButtonBuilder()
            .setCustomId(`sb_play_${sound}`)
            .setLabel(sound)
            .setStyle(ButtonStyle.Secondary)
        )
      );
      rows.push(row);
    }

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sb_page_${page - 1}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('sb_ctrl_stop')
        .setLabel('Stop')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`sb_page_${page + 1}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId('sb_ctrl_refresh')
        .setLabel('Refresh')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary)
    );
    rows.push(navRow);
  }

  return {
    embeds: [panelEmbed],
    components: rows,
  };
}

async function handleMessage(message) {
  const content = message.content.trim();

  // Jika pesan dikirim di channel khusus #bot-ptmabar
  if (message.channel.name === PANEL_CHANNEL_NAME) {
    // Selalu hapus chat apapun di channel ini agar channel tetap bersih
    await message.delete().catch(() => {});

    // Jika yang diketik adalah !panel, kirim pesan soundboard panel
    if (PANEL_TRIGGER.test(content)) {
      await message.channel.send(createPanelPayload()).catch((err) => {
        console.error('❌ Gagal mengirim soundboard panel:', err.message);
      });
    }
    return true;
  }

  // Jika perintah !panel dipanggil di luar channel #bot-ptmabar
  if (PANEL_TRIGGER.test(content)) {
    const errorEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setDescription(`⚠️ Soundboard panel hanya dapat diinstal di channel \`#${PANEL_CHANNEL_NAME}\`!`);

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
        .setDescription(`⚠️ Soundboard panel hanya dapat diinstal di channel \`#${PANEL_CHANNEL_NAME}\`!`);
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      return true;
    }

    await interaction.reply(createPanelPayload());
    return true;
  }

  // Hanya proses interaksi tombol
  if (!interaction.isButton()) return false;

  const customId = interaction.customId;

  // 2. Tombol Navigasi Halaman (jika sound > 23)
  if (customId.startsWith('sb_page_')) {
    const targetPage = parseInt(customId.replace('sb_page_', ''), 10) || 0;
    await interaction.update(createPanelPayload(targetPage)).catch(() => {});
    return true;
  }

  // 3. Tombol Refresh Panel
  if (customId === 'sb_ctrl_refresh') {
    await interaction.update(createPanelPayload()).catch(() => {});
    return true;
  }

  // 4. Tombol Stop Audio (Senyap: deferUpdate tanpa pesan balasan apapun)
  if (customId === 'sb_ctrl_stop') {
    await interaction.deferUpdate().catch(() => {});
    const guildId = interaction.guild?.id;
    if (guildId) {
      stopAudio(guildId);
    }
    return true;
  }

  // 5. Tombol Play Soundboard (Senyap: deferUpdate tanpa pesan balasan apapun)
  if (customId.startsWith('sb_play_')) {
    await interaction.deferUpdate().catch(() => {});

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return true; // Senyap jika pengguna belum di voice

    const soundName = customId.replace('sb_play_', '');
    const filePath = findSoundFile(soundName);
    if (!filePath) return true; // Senyap jika file tidak ada

    try {
      await playSoundboard(voiceChannel, filePath, 1);
    } catch (err) {
      console.error('❌ Gagal memutar soundboard:', err);
    }
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
  SOUNDS_PER_PAGE,
};
