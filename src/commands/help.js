const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

const helpSlashCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Tampilkan daftar perintah dan fitur bot');

function createHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('📖 Bantuan Bot PT Mabar')
    .setDescription([
      '**Daftar Command:**',
      '• `!donasi <nominal> <nama> <pesan>` — Putar suara donasi di voice channel',
      '• `!sb <nama> [repeat]` — Putar suara soundboard',
      '• `!sb list` — Tampilkan daftar suara soundboard',
      '• `!pt stop` — Hentikan suara dan bersihkan antrean',
      '• `!help` — Tampilkan pesan bantuan ini',
    ].join('\n'));
}

async function handleMessage(message) {
  const content = message.content.trim().toLowerCase();
  if (content !== '!help') return false;

  console.log(`[Help Command] Dipanggil oleh ${message.author.tag} di #${message.channel.name || message.channel.id}`);
  await message.channel.send({ embeds: [createHelpEmbed()] }).catch((err) => {
    console.error('❌ Gagal mengirim pesan help:', err.message);
  });
  return true;
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'help') return;

  await interaction.reply({ embeds: [createHelpEmbed()], ephemeral: true }).catch((err) => {
    console.error('Error handling /help:', err);
  });
}

module.exports = {
  helpSlashCommand,
  handleMessage,
  handleInteraction,
};
