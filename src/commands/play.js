const path = require('node:path');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { searchYouTube } = require('../youtube');
const {
  playMusic,
  skipAudio,
  shuffleQueue,
  setLoopMode,
  removeFromQueue,
  getQueue,
} = require('../voiceManager');

const PLAY_TRIGGER = /^!(?:play|p)(?:\s|$)/i;
const SKIP_TRIGGER = /^!skip(?:\s|$)/i;
const QUEUE_TRIGGER = /^!(?:queue|q)(?:\s|$)/i;
const SHUFFLE_TRIGGER = /^!shuffle(?:\s|$)/i;
const LOOP_TRIGGER = /^!loop(?:\s|$)/i;
const REMOVE_TRIGGER = /^!(?:remove|rm)(?:\s|$)/i;

const LOOP_LABELS = { off: 'Mati', track: 'Lagu ini', queue: 'Antrean' };
const LOOP_ALIASES = {
  track: 'track', song: 'track', lagu: 'track', one: 'track', '1': 'track',
  queue: 'queue', all: 'queue', antrean: 'queue',
  off: 'off', mati: 'off', stop: 'off', '0': 'off',
};

function parseLoopMode(arg) {
  const clean = (arg || '').trim().toLowerCase();
  if (!clean) return null;
  return LOOP_ALIASES[clean];
}

function sendEmbed(channel, color, description) {
  return channel.send({ embeds: [new EmbedBuilder().setColor(color).setDescription(description)] }).catch(() => {});
}

async function requireVoice(message) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await sendEmbed(message.channel, 0xED4245, '⚠️ Masuk voice channel terlebih dahulu!');
    return null;
  }
  return voiceChannel;
}

// Every !play, /play and !playlist starts a yt-dlp process (several seconds of CPU), so one person
// can trigger them at most once per second. Returns the seconds left to wait, or 0 (and starts the wait).
// ponytail: per user and in memory; add a global cap on yt-dlp processes if several people spam together
const COOLDOWN_MS = 1000;
const lastUse = new Map(); // userId -> time of the last allowed use

function cooldownLeft(userId, now = Date.now()) {
  const left = (lastUse.get(userId) || 0) + COOLDOWN_MS - now;
  if (left > 0) return Math.ceil(left / 1000);
  if (lastUse.size > 5000) lastUse.clear(); // bound memory
  lastUse.set(userId, now);
  return 0;
}

function cooldownEmbed(seconds) {
  return new EmbedBuilder().setColor(0xED4245).setDescription(`⏳ Tunggu ${seconds} detik sebelum memutar lagu lagi.`);
}

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

  const embed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('📋 Antrean Musik')
    .setDescription(lines.join('\n'));
  if (queueData.loopMode && queueData.loopMode !== 'off') {
    embed.setFooter({ text: `🔁 Loop: ${LOOP_LABELS[queueData.loopMode]}` });
  }
  return embed;
}

async function handleMessage(message) {
  const content = message.content.trim();

  // 1. Perintah !skip
  if (SKIP_TRIGGER.test(content)) {
    if (!await requireVoice(message)) return true;
    skipAudio(message.guild.id);
    await sendEmbed(message.channel, 0xF1C40F, '⏭️ Lagu berhasil dilewati!');
    return true;
  }

  // 2. Perintah !queue atau !q
  if (QUEUE_TRIGGER.test(content)) {
    const queueData = getQueue(message.guild.id);
    await message.channel.send({ embeds: [createQueueEmbed(queueData)] }).catch(() => {});
    return true;
  }

  // 3. Perintah !shuffle
  if (SHUFFLE_TRIGGER.test(content)) {
    if (!await requireVoice(message)) return true;
    const count = shuffleQueue(message.guild.id);
    if (!count) {
      await sendEmbed(message.channel, 0xED4245, '⚠️ Minimal ada 2 lagu di antrean untuk diacak.');
      return true;
    }
    await sendEmbed(message.channel, 0xF1C40F, `🔀 ${count} lagu dalam antrean berhasil diacak.`);
    return true;
  }

  // 4. Perintah !loop [lagu|antrean|off]
  if (LOOP_TRIGGER.test(content)) {
    if (!await requireVoice(message)) return true;
    const arg = content.replace(/^!loop\s*/i, '');
    const parsed = parseLoopMode(arg);
    if (parsed === undefined) {
      await sendEmbed(message.channel, 0xF1C40F, '🔁 Gunakan: `!loop [lagu|antrean|off]`');
      return true;
    }
    const mode = setLoopMode(message.guild.id, parsed);
    await sendEmbed(message.channel, 0xF1C40F, `🔁 Loop: **${LOOP_LABELS[mode]}**`);
    return true;
  }

  // 5. Perintah !remove <no>
  if (REMOVE_TRIGGER.test(content)) {
    if (!await requireVoice(message)) return true;
    const arg = content.replace(/^!(?:remove|rm)\s*/i, '').trim();
    if (!/^\d+$/.test(arg) || Number(arg) < 1) {
      await sendEmbed(message.channel, 0xF1C40F, '🗑️ Gunakan: `!remove <nomor antrean>`');
      return true;
    }
    const num = Number(arg);
    const removed = removeFromQueue(message.guild.id, num);
    if (!removed) {
      await sendEmbed(message.channel, 0xED4245, `❌ Tidak ada lagu di nomor antrean \`#${num}\`.`);
      return true;
    }
    await sendEmbed(message.channel, 0xF1C40F, `🗑️ Dihapus dari antrean: ${formatQueueItem(removed)}`);
    return true;
  }

  // 6. Perintah !play atau !p
  if (!PLAY_TRIGGER.test(content)) return false;

  const query = content.replace(/^!(?:play|p)\s*/i, '').trim();
  if (!query) {
    await sendEmbed(message.channel, 0xF1C40F, '🎵 Gunakan: `!play <judul lagu atau URL YouTube>`');
    return true;
  }

  const voiceChannel = await requireVoice(message);
  if (!voiceChannel) return true;

  const wait = cooldownLeft(message.author.id);
  if (wait) {
    await message.channel.send({ embeds: [cooldownEmbed(wait)] }).catch(() => {});
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
      .setDescription(err.code === 'NOT_YOUTUBE' ? '❌ Hanya link YouTube yang bisa diputar.' : '❌ Video YouTube tidak ditemukan atau gagal diputar.');
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

    const wait = cooldownLeft(interaction.user.id);
    if (wait) {
      await interaction.reply({ embeds: [cooldownEmbed(wait)], ephemeral: true });
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
        .setDescription(err.code === 'NOT_YOUTUBE' ? '❌ Hanya link YouTube yang bisa diputar.' : '❌ Video YouTube tidak ditemukan atau gagal diputar.');
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
  cooldownLeft,
  cooldownEmbed,
  PLAY_TRIGGER,
  SKIP_TRIGGER,
  QUEUE_TRIGGER,
  SHUFFLE_TRIGGER,
  LOOP_TRIGGER,
  REMOVE_TRIGGER,
  LOOP_LABELS,
  parseLoopMode,
};
