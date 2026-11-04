const { Client, GatewayIntentBits } = require('discord.js');
const { checkChannelOccupancy } = require('./src/voiceManager');
const donasi = require('./src/commands/donasi');
const help = require('./src/commands/help');
const soundboard = require('./src/commands/soundboard');
const control = require('./src/commands/control');

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
];

// Event: Saat bot berhasil login
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  const guildIds = process.env.GUILD_ID
    ? process.env.GUILD_ID.split(',').map(id => id.trim()).filter(Boolean)
    : [];

  try {
    if (guildIds.length > 0) {
      for (const gid of guildIds) {
        const guild = client.guilds.cache.get(gid);
        if (guild) {
          await guild.commands.set(slashCommands);
          console.log(`✅ Slash command terdaftar untuk Server ID: ${gid}`);
        } else {
          console.warn(`⚠️ GUILD_ID ${gid} belum ada di bot atau bot belum masuk ke server tersebut.`);
        }
      }
    } else {
      await client.application.commands.set(slashCommands);
      console.log('✅ Slash command terdaftar secara Global!');
    }
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

  // Cek perintah !help
  if (await help.handleMessage(message)) return;
});

// Event: Menangani perintah slash (/)
client.on('interactionCreate', async (interaction) => {
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
