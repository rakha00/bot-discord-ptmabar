const fs = require('node:fs');
const path = require('node:path');

// ponytail: one JSON file next to the sounds, so it rides on the existing persistent volume;
// move to its own volume or a database if playlists ever outgrow a single file.
// PLAYLISTS_FILE in the environment points tests at a scratch file.
const playlistsFile = () => process.env.PLAYLISTS_FILE || path.join(__dirname, '..', 'sounds', '.playlists.json');

// { galau: [{ title, url, duration }, ...], ... }
function loadPlaylists() {
  try {
    return JSON.parse(fs.readFileSync(playlistsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function savePlaylists(playlists) {
  const file = playlistsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(playlists, null, 2));
  fs.renameSync(`${file}.tmp`, file); // atomic, so a crash mid-write cannot corrupt the file
}

module.exports = { loadPlaylists, savePlaylists };
