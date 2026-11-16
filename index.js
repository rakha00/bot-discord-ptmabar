const { Client, GatewayIntentBits } = require('discord.js');
const { checkChannelOccupancy } = require('./src/voiceManager');
const donasi = require('./src/commands/donasi');
const help = require('./src/commands/help');
const soundboard = require('./src/commands/soundboard');
const control = require('./src/commands/control');
const panel = require('./src/commands/panel');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const slashCommands = [
  donasi.donasiSlashCommand,
  help.helpSlashCommand,
  panel.panelSlashCommand,
];

// Event: Saat bot berhasil login
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  try {
    await client.application.commands.set(slashCommands);
    console.log('✅ Slash command terdaftar secara Global!');
  } catch (err) {
    console.error('❌ Gagal mendaftarkan slash command:', err);
  }
});

// Event: Deteksi keluar/masuk voice channel (Auto-Leave)
client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;
  checkChannelOccupancy(guild);
});

// Event: Menangani perintah chat prefix (!)
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Cek perintah !pt (kontrol bot seperti !pt stop)
  if (await control.handleMessage(message)) return;

  // Cek perintah !donasi
  if (await donasi.handleMessage(message)) return;

  // Cek perintah !sb (soundboard)
  if (await soundboard.handleMessage(message)) return;

  // Cek perintah !panel (interactive control panel di #bot-ptmabar)
  if (await panel.handleMessage(message)) return;

  // Cek perintah !help
  if (await help.handleMessage(message)) return;
});

// Event: Menangani perintah slash (/) dan interaksi UI komponen
client.on('interactionCreate', async (interaction) => {
  // Tangani interaksi panel (slash /panel, tombol, dropdown select, modal)
  if (await panel.handleInteraction(interaction)) return;

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'donasi') {
    return donasi.handleInteraction(interaction);
  }
  if (interaction.commandName === 'help') {
    return help.handleInteraction(interaction);
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN belum diisi di file .env!');
  process.exit(1);
}

client.login(token);
