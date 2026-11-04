const { EmbedBuilder } = require('discord.js');
const { stopAudio } = require('../voiceManager');

async function handleMessage(message) {
  const content = message.content.trim().toLowerCase();
  if (content !== '!pt stop') return false;

  console.log(`[PT Stop] Dipanggil oleh ${message.author.tag} di guild ${message.guild?.id}`);

  if (!message.guild) return true;

  stopAudio(message.guild.id);

  const stopEmbed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setDescription('⏹️ Suara dihentikan dan antrean dibersihkan.');

  await message.channel.send({ embeds: [stopEmbed] }).catch((err) => {
    console.error('❌ Gagal mengirim pesan pt stop:', err.message);
  });

  return true;
}

module.exports = {
  handleMessage,
};
