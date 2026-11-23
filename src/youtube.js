const { spawn } = require('node:child_process');

// YouTube's Opus track can be passed straight to Discord; anything else falls back to FFmpeg.
const AUDIO_FORMAT = 'bestaudio[acodec=opus]/bestaudio';

function searchYouTube(query) {
  return new Promise((resolve, reject) => {
    const trimmed = query.trim();
    if (!trimmed) {
      return reject(new Error('Query pencarian tidak boleh kosong.'));
    }

    const isUrl = /^https?:\/\//i.test(trimmed);
    const target = isUrl ? trimmed : `ytsearch1:${trimmed}`;

    // One full extraction (-j) gives the title and the resolved stream URLs together. The JSON is kept
    // on the queue item so playback starts with --load-info-json (~1 s) instead of extracting again (~7 s).
    const proc = spawn('yt-dlp', [
      '-j',
      '-f', AUDIO_FORMAT,
      '--no-playlist',
      '--no-warnings',
      target,
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      let info = null;
      try { info = JSON.parse(lines[lines.length - 1]); } catch {}

      if (code === 0 && info) {
        resolve({
          title: info.title || 'Unknown Title',
          duration: info.duration_string || 'Live / Unknown',
          url: info.id ? `https://www.youtube.com/watch?v=${info.id}` : target,
          // ponytail: ~600 KB of JSON per queued song; strip unused keys if long queues ever matter
          info: lines[lines.length - 1],
          resolvedAt: Date.now(),
        });
      } else {
        reject(new Error(stderr || 'Video YouTube tidak ditemukan.'));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

module.exports = {
  searchYouTube,
  AUDIO_FORMAT,
};
