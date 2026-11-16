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
const SOUNDS_PER_PAGE = 11; // 11 sound + 1 tombol Stop = tepat 4 baris x 3 tombol
const BUTTONS_PER_ROW = 3;
const TARGET_LABEL_LEN = 13; // Panjang karakter seragam menggunakan non-breaking space

const panelSlashCommand = new SlashCommandBuilder()
  .setName('panel')
  .setDescription(`Tampilkan soundboard control panel di channel #${PANEL_CHANNEL_NAME}`);

// Helper: Meratakan panjang teks dengan non-breaking space (\u00A0) agar lebar tombol seragam
function padLabel(str, targetLen = TARGET_LABEL_LEN) {
  const diff = targetLen - str.length;
  if (diff <= 0) return str;
  const left = Math.floor(diff / 2);
  const right = diff - left;
  return '\u00A0'.repeat(left) + str + '\u00A0'.repeat(right);
}

function createPanelPayload(page = 0) {
  const sounds = getAvailableSounds();
  const totalSounds = sounds.length;
  const totalPages = Math.max(1, Math.ceil(totalSounds / SOUNDS_PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  const start = currentPage * SOUNDS_PER_PAGE;
  const pageSounds = sounds.slice(start, start + SOUNDS_PER_PAGE);

  const panelEmbed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('🎮 PT MABAR - Soundboard')
    .setDescription('Klik tombol di bawah untuk langsung memutar sound di Voice Channel.');

  if (totalPages > 1) {
    panelEmbed.setFooter({ text: `Halaman ${currentPage + 1}/${totalPages}` });
  }

  const rows = [];

  // Baris 1 - 3: Masing-masing tepat 3 tombol sound (total 9 sound)
  for (let r = 0; r < 3; r++) {
    const slice = pageSounds.slice(r * BUTTONS_PER_ROW, (r + 1) * BUTTONS_PER_ROW);
    if (slice.length > 0) {
      const row = new ActionRowBuilder().addComponents(
        slice.map(sound =>
          new ButtonBuilder()
            .setCustomId(`sb_play_${sound}`)
            .setLabel(padLabel(sound))
            .setStyle(ButtonStyle.Secondary)
        )
      );
      rows.push(row);
    }
  }

  // Baris 4: Sisa sound halaman ini + Tombol Stop (tepat 3 tombol)
  const remainingSounds = pageSounds.slice(9, 11);
  const row4 = new ActionRowBuilder();
  for (const sound of remainingSounds) {
    row4.addComponents(
      new ButtonBuilder()
        .setCustomId(`sb_play_${sound}`)
        .setLabel(padLabel(sound))
        .setStyle(ButtonStyle.Secondary)
    );
  }
  row4.addComponents(
    new ButtonBuilder()
      .setCustomId('sb_ctrl_stop')
      .setLabel(padLabel('⏹️ Stop'))
      .setStyle(ButtonStyle.Danger)
  );
  rows.push(row4);

  // Baris 5: Navigasi (Prev, Refresh, Next) - tepat 3 tombol
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sb_page_${currentPage - 1}`)
      .setLabel(padLabel('◀ Prev', 8))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(`sb_ctrl_refresh_${currentPage}`)
      .setLabel(padLabel('🔄 Refresh', 8))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sb_page_${currentPage + 1}`)
      .setLabel(padLabel('Next ▶', 8))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage >= totalPages - 1)
  );
  rows.push(navRow);

  return {
    embeds: [panelEmbed],
    components: rows,
  };
}

async function handleMessage(message) {
  const content = message.content.trim();

  // 1. Jika perintah !panel dipanggil di luar channel #bot-ptmabar
  if (PANEL_TRIGGER.test(content) && message.channel.name !== PANEL_CHANNEL_NAME) {
    const errorEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setDescription(`⚠️ Soundboard panel hanya dapat diinstal di channel \`#${PANEL_CHANNEL_NAME}\`!`);

    await message.channel.send({ embeds: [errorEmbed] }).catch((err) => {
      console.error('❌ Gagal mengirim error channel panel:', err.message);
    });
    return true;
  }

  // 2. Jika di channel khusus #bot-ptmabar
  if (message.channel.name === PANEL_CHANNEL_NAME) {
    // Hapus chat apapun agar channel tetap bersih
    await message.delete().catch(() => {});

    // Jika yang diketik adalah !panel, kirim pesan soundboard panel
    if (PANEL_TRIGGER.test(content)) {
      await message.channel.send(createPanelPayload(0)).catch((err) => {
        console.error('❌ Gagal mengirim soundboard panel:', err.message);
      });
    }
    return true;
  }

  return false;
}

async function handleInteraction(interaction) {
  // 1. Slash Command /panel (Wajib di channel #bot-ptmabar)
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

  // 5. Tombol Play Soundboard (Senyap, Otomatis Berpindah Voice Channel, & Langsung Override)
  if (customId.startsWith('sb_play_')) {
    await interaction.deferUpdate().catch(() => {});

    // Voice channel pengguna yang mengklik tombol
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return true;

    const soundName = customId.replace('sb_play_', '');
    const filePath = findSoundFile(soundName);
    if (!filePath) return true;

    try {
      // playSoundboard otomatis memindahkan bot ke voiceChannel pengguna & melakukan override
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
