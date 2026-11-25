const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  demuxProbe,
} = require('@discordjs/voice');
const { splitText, getAudioResource } = require('./tts');
const { AUDIO_FORMAT, searchYouTube } = require('./youtube');

const INFO_MAX_AGE_MS = 5 * 60 * 60 * 1000; // YouTube stream URLs expire after ~6 h

// Durasi timeout auto-leave (keduanya 5 menit)
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;  // 5 menit jika idle tidak ada donasi
const EMPTY_TIMEOUT_MS = 5 * 60 * 1000; // 5 menit jika voice channel kosong
const ALERT_PATH = path.join(__dirname, '..', 'assets', 'alert.mp3');

// Cache per-guild: { player, queue, current, isPlaying, idleTimer, emptyTimer, currentProc }
const players = new Map();

function getGuildData(guildId) {
  let guildData = players.get(guildId);
  if (!guildData) {
    const player = createAudioPlayer();
    guildData = {
      player,
      queue: [],
      current: null,
      currentResource: null,
      isPlaying: false,
      idleTimer: null,
      emptyTimer: null,
      currentProc: null,
    };

    player.on(AudioPlayerStatus.Idle, () => {
      if (guildData.currentProc) {
        guildData.currentProc.kill();
        guildData.currentProc = null;
      }
      guildData.currentResource = null;
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
      guildData.current = null;
      guildData.currentResource = null;
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

// Songs queued without a saved extraction (playlist songs) are extracted in the background while
// the song before them plays, so they still start in about a second. One at a time.
function prefetchNext(guildData) {
  const next = guildData.queue.find(item => item?.type === 'youtube');
  if (!next || next.prefetching || (next.info && Date.now() - next.resolvedAt < INFO_MAX_AGE_MS)) return;
  next.prefetching = true;
  searchYouTube(next.url)
    .then(video => { next.info = video.info; next.resolvedAt = video.resolvedAt; })
    .catch(err => console.warn('[Prefetch] Gagal menyiapkan lagu berikutnya:', err.message))
    .finally(() => { next.prefetching = false; });
}

function getStreamInfo(rawInfo) {
  if (!rawInfo) return null;
  try {
    const info = JSON.parse(rawInfo);
    if (info.is_live) return null;
    const url = info.url || info.requested_formats?.[0]?.url;
    return url ? { url, userAgent: info.http_headers?.['User-Agent'], ...(info.duration ? { duration: info.duration } : {}) } : null;
  } catch {
    return null;
  }
}

function buildSeekFfmpegArgs(streamUrl, seekSec, userAgent) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (/^https?:\/\//i.test(streamUrl)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  if (userAgent) args.push('-user_agent', userAgent);
  args.push(
    '-ss', String(seekSec),
    '-i', streamUrl,
    '-vn',
    '-f', 'ogg',
    '-c:a', 'libopus',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  );
  return args;
}

async function playNext(guildId) {
  const guildData = players.get(guildId);
  if (!guildData) return;

  guildData.currentResource = null;

  if (guildData.queue.length === 0) {
    guildData.isPlaying = false;
    guildData.current = null;
    startIdleTimer(guildId);
    return;
  }

  guildData.isPlaying = true;
  const nextItem = guildData.queue.shift();
  guildData.current = nextItem;

  try {
    let resource;
    if (typeof nextItem === 'string') {
      resource = await getAudioResource(nextItem);
    } else if (nextItem?.type === 'file') {
      resource = createAudioResource(nextItem.path);
    } else if (nextItem?.type === 'youtube') {
      if (guildData.currentProc) {
        guildData.currentProc.kill();
        guildData.currentProc = null;
      }

      const seekSec = nextItem.seekMs ? Math.floor(nextItem.seekMs / 1000) : 0;
      const hasFreshInfo = nextItem.info && Date.now() - nextItem.resolvedAt < INFO_MAX_AGE_MS;
      if (seekSec >= 1 && !hasFreshInfo) {
        const video = await searchYouTube(nextItem.url);
        if (guildData.current !== nextItem) return; // superseded while resolving stream URL
        nextItem.info = video.info;
        nextItem.resolvedAt = video.resolvedAt;
      }

      const stream = seekSec >= 1 ? getStreamInfo(nextItem.info) : null;
      if (stream?.duration && seekSec >= stream.duration) {
        return playNext(guildId);
      }

      const spawnYtDlp = () => {
        // Reuse the extraction saved at search time while its stream URLs are still valid (they expire
        // after ~6 h); otherwise extract again from the video URL.
        let source = ['--no-playlist', nextItem.url];
        let infoFile = null;
        if (nextItem.info && Date.now() - nextItem.resolvedAt < INFO_MAX_AGE_MS) {
          infoFile = path.join(os.tmpdir(), `yt-${process.pid}-${Date.now()}.json`);
          fs.writeFileSync(infoFile, nextItem.info);
          source = ['--load-info-json', infoFile];
        }
        // An Opus (WebM) stream is passed straight to Discord by demuxProbe, skipping the FFmpeg decode
        // and opusscript re-encode. Other formats still go through FFmpeg.
        const yt = spawn('yt-dlp', ['-f', AUDIO_FORMAT, '--no-warnings', '-o', '-', ...source]);
        yt.on('error', (err) => console.error('[yt-dlp Stream Error]:', err.message));
        if (infoFile) yt.on('close', () => fs.rm(infoFile, { force: true }, () => {}));
        return yt;
      };

      let proc;
      let usedSeek = false;
      if (stream) {
        // Direct HTTP Range seek with ffmpeg avoids downloading the whole prefix through a pipe.
        usedSeek = true;
        proc = spawn('ffmpeg', buildSeekFfmpegArgs(stream.url, seekSec, stream.userAgent));
        proc.on('error', (err) => console.error('[FFmpeg Seek Error]:', err.message));
      } else {
        proc = spawnYtDlp();
      }

      guildData.currentProc = proc;
      let probed;
      try {
        probed = await demuxProbe(proc.stdout);
      } catch (err) {
        if (guildData.currentProc !== proc) return; // killed by skip/stop/soundboard; they already moved on
        if (!usedSeek) throw err;
        // If ffmpeg cannot range-seek this stream URL, fall back to yt-dlp from 0:00 instead of dropping the song.
        console.warn('[FFmpeg Seek Fallback] Memutar ulang dari awal:', err.message);
        proc.kill();
        proc = spawnYtDlp();
        guildData.currentProc = proc;
        try {
          probed = await demuxProbe(proc.stdout);
        } catch (fallbackErr) {
          if (guildData.currentProc !== proc) return;
          throw fallbackErr;
        }
      }
      if (guildData.currentProc !== proc) return; // superseded while probing
      resource = createAudioResource(probed.stream, { inputType: probed.type });
      prefetchNext(guildData);
    }
    if (resource) {
      guildData.currentResource = resource;
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
  } else if (connection.joinConfig.channelId !== voiceChannel.id) {
    // Otomatis berpindah ke voice channel pengguna yang baru mengklik tombol
    console.log(`[Voice Switch] Berpindah ke voice channel "${voiceChannel.name || voiceChannel.id}"`);
    connection.rejoin({
      channelId: voiceChannel.id,
      selfDeaf: true,
      selfMute: false,
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

// Soundboards and donations cut in right away, ahead of everything else. Only soundboards are
// throwaway: one still waiting is dropped (so spamming !sb does not pile up), and an interrupted
// soundboard is not replayed. Whatever else was interrupted (a song, a donation's TTS) goes back
// to the front (a YouTube song resumes from its last played position) and the rest of the queue is kept.
function queueWithInterrupt(queue, current, items, playbackDurationMs = 0) {
  const resumed = current && current.type === 'youtube' && playbackDurationMs > 0
    ? { ...current, seekMs: (current.seekMs || 0) + playbackDurationMs }
    : current;
  return [
    ...items,
    ...(resumed && !resumed.soundboard ? [resumed] : []),
    ...queue.filter(item => !item?.soundboard),
  ];
}

async function interruptWith(voiceChannel, items) {
  const connection = await getOrCreateConnection(voiceChannel);
  const guildData = getGuildData(voiceChannel.guild.id);
  clearIdleTimer(voiceChannel.guild.id);

  connection.subscribe(guildData.player);

  if (guildData.currentProc) {
    guildData.currentProc.kill();
    guildData.currentProc = null;
  }
  const elapsedMs = guildData.currentResource?.playbackDuration || 0;
  guildData.currentResource = null;
  guildData.queue = queueWithInterrupt(guildData.queue, guildData.current, items, elapsedMs);
  guildData.current = null;

  if (guildData.player.state.status !== AudioPlayerStatus.Idle) {
    guildData.player.stop(true);
  } else {
    playNext(voiceChannel.guild.id);
  }

  checkChannelOccupancy(voiceChannel.guild);
}

async function playDonation(voiceChannel, speechText) {
  const items = [];
  // 1. Putar bunyi efek bel/kasir (Cha-ching!) jika file alert.mp3 ada
  if (fs.existsSync(ALERT_PATH)) {
    console.log('[Donasi] Memutar efek suara pembuka alert.mp3');
    items.push({ type: 'file', path: ALERT_PATH });
  } else {
    console.warn('[Donasi] File alert.mp3 tidak ditemukan di:', ALERT_PATH);
  }
  // 2. Teks donasi TTS
  items.push(...splitText(speechText));

  await interruptWith(voiceChannel, items);
}

async function playSoundboard(voiceChannel, filePath, repeat = 1) {
  const times = Math.min(Math.max(parseInt(repeat, 10) || 1, 1), 10);
  await interruptWith(voiceChannel, Array.from({ length: times }, () => ({ type: 'file', path: filePath, soundboard: true })));
}

async function playMusic(voiceChannel, videoInfo) {
  const connection = await getOrCreateConnection(voiceChannel);
  const guildData = getGuildData(voiceChannel.guild.id);
  clearIdleTimer(voiceChannel.guild.id);

  connection.subscribe(guildData.player);

  const item = {
    type: 'youtube',
    title: videoInfo.title,
    url: videoInfo.url,
    duration: videoInfo.duration,
    info: videoInfo.info,
    resolvedAt: videoInfo.resolvedAt,
  };

  const isAlreadyPlaying = guildData.isPlaying;
  guildData.queue.push(item);
  if (isAlreadyPlaying) {
    prefetchNext(guildData);
  } else {
    playNext(voiceChannel.guild.id);
  }

  checkChannelOccupancy(voiceChannel.guild);

  return {
    isPlayingNow: !isAlreadyPlaying,
    position: isAlreadyPlaying ? guildData.queue.length : 1,
  };
}

function skipAudio(guildId) {
  const guildData = players.get(guildId);
  if (!guildData) return false;

  if (guildData.currentProc) {
    guildData.currentProc.kill();
    guildData.currentProc = null;
  }

  guildData.currentResource = null;
  guildData.player.stop(true);
  return true;
}

function stopAudio(guildId) {
  const guildData = players.get(guildId);
  if (!guildData) return false;

  if (guildData.currentProc) {
    guildData.currentProc.kill();
    guildData.currentProc = null;
  }

  guildData.queue = [];
  guildData.current = null;
  guildData.currentResource = null;
  guildData.isPlaying = false;
  guildData.player.stop(true);
  startIdleTimer(guildId);
  return true;
}

function getQueue(guildId) {
  const guildData = players.get(guildId);
  if (!guildData) return { isPlaying: false, current: null, queue: [] };
  return {
    isPlaying: guildData.isPlaying,
    current: guildData.current || null,
    queue: [...guildData.queue],
  };
}

module.exports = {
  playDonation,
  playSoundboard,
  queueWithInterrupt,
  getStreamInfo,
  buildSeekFfmpegArgs,
  playMusic,
  skipAudio,
  stopAudio,
  getQueue,
  checkChannelOccupancy,
  IDLE_TIMEOUT_MS,
  EMPTY_TIMEOUT_MS,
  ALERT_PATH,
};
