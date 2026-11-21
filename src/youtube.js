const { spawn } = require('node:child_process');

function searchYouTube(query) {
  return new Promise((resolve, reject) => {
    const trimmed = query.trim();
    if (!trimmed) {
      return reject(new Error('Query pencarian tidak boleh kosong.'));
    }

    const isUrl = /^https?:\/\//i.test(trimmed);
    const target = isUrl ? trimmed : `ytsearch1:${trimmed}`;

    const proc = spawn('yt-dlp', [
      '--no-playlist',
      '--no-warnings',
      '--print', '%(title)s|||%(duration_string)s|||%(id)s',
      target,
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const lastLine = lines[lines.length - 1];
        const [title, duration, id] = lastLine.split('|||');

        resolve({
          title: title || 'Unknown Title',
          duration: duration || 'Live / Unknown',
          url: id ? `https://www.youtube.com/watch?v=${id}` : target,
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
};
