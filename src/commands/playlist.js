const { EmbedBuilder } = require('discord.js');
const { loadPlaylists } = require('../playlists');
const { playMusic } = require('../voiceManager');
const { cooldownLeft, cooldownEmbed } = require('./play');

const PLAYLIST_TRIGGER = /^!playlist(?:\s|$)/i;

function createListEmbed(playlists) {
  const names = Object.keys(playlists).sort();
  if (names.length === 0) {
    return new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle('🎶 Belum Ada Playlist')
      .setDescription('Buat playlist lewat web Soundboard Manager, lalu putar dengan `!playlist <nama>`.');
  }
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('🎶 Daftar Playlist')
    .setDescription([
      ...names.map(n => `• \`${n}\` — ${playlists[n].length} lagu`),
      '',
      'Putar dengan `!playlist <nama>`.',
    ].join('\n'));
}

function createPlayingEmbed(name, songs) {
  const preview = songs.slice(0, 5).map((s, i) => `\`${i + 1}.\` [${s.title}](${s.url}) (\`${s.duration}\`)`);
  if (songs.length > 5) preview.push(`*...dan ${songs.length - 5} lagu lainnya.*`);
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle(`🎶 Playlist ${name}`)
    .setDescription([`${songs.length} lagu ditambahkan ke antrean.`, '', ...preview].join('\n'));
}

function errorEmbed(text) {
  return new EmbedBuilder().setColor(0xED4245).setDescription(text);
}

async function handleMessage(message) {
  const content = message.content.trim();
  if (!PLAYLIST_TRIGGER.test(content)) return false;

  const arg = content.replace(/^!playlist\s*/i, '').trim().toLowerCase();
  const playlists = loadPlaylists();
  const send = embed => message.channel.send({ embeds: [embed] }).catch(() => {});

  if (!arg || arg === 'list') {
    await send(createListEmbed(playlists));
    return true;
  }

  const songs = playlists[arg];
  if (!songs) {
    const names = Object.keys(playlists).sort();
    await send(errorEmbed(names.length
      ? `❌ Playlist \`${arg}\` tidak ditemukan. Tersedia: ${names.map(n => `\`${n}\``).join(', ')}`
      : `❌ Playlist \`${arg}\` tidak ditemukan. Belum ada playlist; buat lewat web Soundboard Manager.`));
    return true;
  }
  if (songs.length === 0) {
    await send(errorEmbed(`⚠️ Playlist \`${arg}\` masih kosong. Tambahkan lagu lewat web Soundboard Manager.`));
    return true;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await send(errorEmbed('⚠️ Masuk voice channel terlebih dahulu!'));
    return true;
  }

  const wait = cooldownLeft(message.author.id);
  if (wait) {
    await send(cooldownEmbed(wait));
    return true;
  }

  try {
    // Songs are stored with their URL; each one is extracted when it is about to play.
    for (const song of songs) await playMusic(voiceChannel, song);
    await send(createPlayingEmbed(arg, songs));
  } catch (err) {
    console.error('❌ Gagal memutar playlist:', err.message);
    await send(errorEmbed('❌ Playlist gagal diputar. Coba lagi sebentar.'));
  }
  return true;
}

module.exports = {
  handleMessage,
  createListEmbed,
  createPlayingEmbed,
  PLAYLIST_TRIGGER,
};
