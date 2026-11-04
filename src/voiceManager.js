const fs = require('node:fs');
const path = require('node:path');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { splitText, getAudioResource } = require('./tts');

// Durasi timeout auto-leave (keduanya 5 menit)
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;  // 5 menit jika idle tidak ada donasi
const EMPTY_TIMEOUT_MS = 5 * 60 * 1000; // 5 menit jika voice channel kosong
const ALERT_PATH = path.join(__dirname, '..', 'assets', 'alert.mp3');

// Cache per-guild: { player, queue, isPlaying, idleTimer, emptyTimer }
const players = new Map();

function getGuildData(guildId) {
  let guildData = players.get(guildId);
  if (!guildData) {
    const player = createAudioPlayer();
    guildData = {
      player,
      queue: [],
      isPlaying: false,
      idleTimer: null,
      emptyTimer: null,
    };

    player.on(AudioPlayerStatus.Idle, () => {
      playNext(guildId);
    });

    player.on('error', (err) => {
      console.error(`[Player Error] Guild ${guildId}:`, err.message);
      playNext(guildId);
    });

    players.set(guildId, guildData);
  }
  return guildData;
}

function startIdleTimer(guildId) {
  const guildData = getGuildData(guildId);
  clearTimeout(guildData.idleTimer);
  guildData.idleTimer = setTimeout(() => {
    const connection = getVoiceConnection(guildId);
    if (connection) {
      console.log(`[Auto-Leave] Keluar dari voice channel di guild ${guildId} karena idle 5 menit.`);
      connection.destroy();
    }
    guildData.idleTimer = null;
  }, IDLE_TIMEOUT_MS);
}

function clearIdleTimer(guildId) {
  const guildData = getGuildData(guildId);
  if (guildData.idleTimer) {
    clearTimeout(guildData.idleTimer);
    guildData.idleTimer = null;
  }
}

function startEmptyTimer(guildId) {
  const guildData = getGuildData(guildId);
  if (guildData.emptyTimer) return;
  console.log(`[Auto-Leave] Channel kosong di guild ${guildId}. Countdown 5 menit dimulai.`);
  guildData.emptyTimer = setTimeout(() => {
    const connection = getVoiceConnection(guildId);
    if (connection) {
      console.log(`[Auto-Leave] Keluar dari voice channel di guild ${guildId} karena channel kosong selama 5 menit.`);
      connection.destroy();
    }
    guildData.emptyTimer = null;
  }, EMPTY_TIMEOUT_MS);
}

function clearEmptyTimer(guildId) {
  const guildData = getGuildData(guildId);
  if (guildData.emptyTimer) {
    clearTimeout(guildData.emptyTimer);
    guildData.emptyTimer = null;
    console.log(`[Auto-Leave] Ada member kembali di guild ${guildId}. Countdown 5 menit dibatalkan.`);
  }
}

function checkChannelOccupancy(guild) {
  const botChannel = guild.members.me?.voice?.channel;
  if (!botChannel) {
    clearIdleTimer(guild.id);
    clearEmptyTimer(guild.id);
    const guildData = players.get(guild.id);
    if (guildData) {
      guildData.isPlaying = false;
      guildData.queue = [];
      guildData.player.stop();
    }
    return;
  }

  // Hitung jumlah member manusia (bukan bot)
  const humanMembers = botChannel.members.filter(m => !m.user.bot);
  if (humanMembers.size === 0) {
    startEmptyTimer(guild.id);
  } else {
    clearEmptyTimer(guild.id);
  }
}

async function playNext(guildId) {
  const guildData = players.get(guildId);
  if (!guildData) return;

  if (guildData.queue.length === 0) {
    guildData.isPlaying = false;
    startIdleTimer(guildId);
    return;
  }

  guildData.isPlaying = true;
  const nextItem = guildData.queue.shift();

  try {
    let resource;
    if (typeof nextItem === 'string') {
      resource = await getAudioResource(nextItem);
    } else if (nextItem?.type === 'file') {
      resource = createAudioResource(nextItem.path);
    }
    if (resource) {
      guildData.player.play(resource);
    } else {
      playNext(guildId);
    }
  } catch (err) {
    console.error(`[Audio Error] Gagal memutar audio:`, err.message);
    playNext(guildId);
  }
}

async function getOrCreateConnection(voiceChannel) {
  let connection = getVoiceConnection(voiceChannel.guild.id);

  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });
  }

  // Wajib tunggu status koneksi benar-benar Ready (handshake UDP & enkripsi voice selesai)
  if (connection.state.status !== VoiceConnectionStatus.Ready) {
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      console.error(`[Voice Error] Gagal mencapai status Ready di guild ${voiceChannel.guild.id}:`, err);
      connection.destroy();
      throw err;
    }
  }

  return connection;
}

async function playDonation(voiceChannel, speechText) {
  const connection = await getOrCreateConnection(voiceChannel);
  const guildData = getGuildData(voiceChannel.guild.id);
  clearIdleTimer(voiceChannel.guild.id);

  connection.subscribe(guildData.player);

  // 1. Putar bunyi efek bel/kasir (Cha-ching!) jika file alert.mp3 ada
  if (fs.existsSync(ALERT_PATH)) {
    console.log('[Donasi] Memutar efek suara pembuka alert.mp3');
    guildData.queue.push({ type: 'file', path: ALERT_PATH });
  } else {
    console.warn('[Donasi] File alert.mp3 tidak ditemukan di:', ALERT_PATH);
  }

  // 2. Masukkan teks donasi TTS ke antrean
  const chunks = splitText(speechText);
  guildData.queue.push(...chunks);

  if (!guildData.isPlaying) {
    playNext(voiceChannel.guild.id);
  }

  checkChannelOccupancy(voiceChannel.guild);
}

async function playSoundboard(voiceChannel, filePath, repeat = 1) {
  const connection = await getOrCreateConnection(voiceChannel);
  const guildData = getGuildData(voiceChannel.guild.id);
  clearIdleTimer(voiceChannel.guild.id);

  connection.subscribe(guildData.player);

  const times = Math.min(Math.max(parseInt(repeat, 10) || 1, 1), 10);
  for (let i = 0; i < times; i++) {
    guildData.queue.push({ type: 'file', path: filePath });
  }

  if (!guildData.isPlaying) {
    playNext(voiceChannel.guild.id);
  }

  checkChannelOccupancy(voiceChannel.guild);
}

function stopAudio(guildId) {
  const guildData = players.get(guildId);
  if (!guildData) return false;

  guildData.queue = [];
  guildData.isPlaying = false;
  guildData.player.stop(true);
  startIdleTimer(guildId);
  return true;
}

module.exports = {
  playDonation,
  playSoundboard,
  stopAudio,
  checkChannelOccupancy,
  IDLE_TIMEOUT_MS,
  EMPTY_TIMEOUT_MS,
  ALERT_PATH,
};
