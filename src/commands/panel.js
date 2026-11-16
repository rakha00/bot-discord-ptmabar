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
const SOUNDS_PER_PAGE = 12; // 3 baris x 4 tombol per halaman
const BUTTONS_PER_ROW = 4;

const panelSlashCommand = new SlashCommandBuilder()
  .setName('panel')
  .setDescription(`Tampilkan soundboard launchpad di channel #${PANEL_CHANNEL_NAME}`);

// Helper: Meratakan panjang teks dengan spasi tak kasat mata (Braille blank) agar tombol sejajar sempurna
function padLabel(str, targetLen) {
  const diff = targetLen - str.length;
  if (diff <= 0) return str;
  const padLeft = Math.floor(diff / 2);
  const padRight = diff - padLeft;
  return '\u2800'.repeat(padLeft) + str + '\u2800'.repeat(padRight);
}

function createPanelPayload(page = 0) {
  const sounds = getAvailableSounds();
  const totalSounds = sounds.length;
  const totalPages = Math.max(1, Math.ceil(totalSounds / SOUNDS_PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  const start = currentPage * SOUNDS_PER_PAGE;
  const pageSounds = sounds.slice(start, start + SOUNDS_PER_PAGE);

  // Cari panjang karakter terpanjang agar semua tombol memiliki lebar seragam
  const targetLen = Math.max(...sounds.map(s => s.length), 11);

  const panelEmbed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('🎮 PT MABAR - Soundboard Launchpad')
    .setDescription(
      'Klik tombol di bawah untuk langsung memutar sound di Voice Channel.\n' +
      '*Jika ada sound lain yang sedang diputar, otomatis langsung ditimpa (override).*'
    )
    .setFooter({
      text: `Halaman ${currentPage + 1}/${totalPages} • Total ${totalSounds} Sound • #${PANEL_CHANNEL_NAME}`,
    });

  const rows = [];

  // 1. Baris Tombol Sound: Tepat 4 tombol per baris (sejajar rapi dalam 4 kolom simetris)
  for (let r = 0; r < 3; r++) {
    const rowSounds = pageSounds.slice(r * BUTTONS_PER_ROW, (r + 1) * BUTTONS_PER_ROW);
    if (rowSounds.length === 0 && r > 0) break;

    const row = new ActionRowBuilder();

    // Tambahkan tombol sound yang ada
    for (const sound of rowSounds) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`sb_play_${sound}`)
          .setLabel(padLabel(sound, targetLen))
          .setStyle(ButtonStyle.Secondary)
      );
    }

    // Isi slot kosong dengan tombol placeholder non-aktif agar kolom selalu sejajar 4x4
    while (row.components.length < BUTTONS_PER_ROW) {
      const emptyIndex = row.components.length;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`sb_empty_${currentPage}_${r}_${emptyIndex}`)
          .setLabel('\u2800'.repeat(targetLen))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      );
    }

    rows.push(row);
  }

  // 2. Baris Navigasi & Kontrol: Tepat 4 tombol sejajar (Prev, Stop, Next, Refresh)
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sb_page_${currentPage - 1}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId('sb_ctrl_stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`sb_page_${currentPage + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`sb_ctrl_refresh_${currentPage}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
  rows.push(navRow);

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

    // Jika yang diketik adalah !panel, kirim pesan soundboard launchpad
    if (PANEL_TRIGGER.test(content)) {
      await message.channel.send(createPanelPayload(0)).catch((err) => {
        console.error('❌ Gagal mengirim soundboard launchpad:', err.message);
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

    await interaction.reply(createPanelPayload(0));
    return true;
  }

  // Hanya proses interaksi tombol
  if (!interaction.isButton()) return false;

  const customId = interaction.customId;

  // Abaikan tombol slot kosong
  if (customId.startsWith('sb_empty_')) {
    await interaction.deferUpdate().catch(() => {});
    return true;
  }

  // 2. Tombol Navigasi Halaman
  if (customId.startsWith('sb_page_')) {
    const targetPage = parseInt(customId.replace('sb_page_', ''), 10) || 0;
    await interaction.update(createPanelPayload(targetPage)).catch(() => {});
    return true;
  }

  // 3. Tombol Refresh Panel
  if (customId.startsWith('sb_ctrl_refresh')) {
    const parts = customId.split('_');
    const page = parts.length > 3 ? parseInt(parts[3], 10) || 0 : 0;
    await interaction.update(createPanelPayload(page)).catch(() => {});
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

  // 5. Tombol Play Soundboard (Senyap & Langsung Override)
  if (customId.startsWith('sb_play_')) {
    await interaction.deferUpdate().catch(() => {});

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return true;

    const soundName = customId.replace('sb_play_', '');
    const filePath = findSoundFile(soundName);
    if (!filePath) return true;

    try {
      // override = true (menimpa audio yang sedang berjalan)
      await playSoundboard(voiceChannel, filePath, 1, true);
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
  BUTTONS_PER_ROW,
  padLabel,
};
