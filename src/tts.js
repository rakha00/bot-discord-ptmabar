const { createAudioResource } = require('@discordjs/voice');
const { Readable } = require('node:stream');

/**
 * Memecah teks menjadi potongan maksimal per limit karakter (Google TTS max ~200 chars).
 */
function splitText(text, limit = 200) {
  if (text.length <= limit) return [text];
  const words = text.split(/\s+/);
  const chunks = [];
  let current = '';

  for (const word of words) {
    if ((current + ' ' + word).trim().length > limit) {
      if (current) chunks.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

/**
 * Mengambil audio stream dari Google Translate TTS publik (Bahasa Indonesia).
 */
async function getAudioResource(text) {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=id&client=tw-ob&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!res.ok) {
    throw new Error(`Google TTS request failed with status: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return createAudioResource(Readable.from(Buffer.from(arrayBuffer)));
}

module.exports = {
  splitText,
  getAudioResource,
};
