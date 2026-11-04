# Panduan Pengembang & AI Agent (AGENTS.md)

Dokumen ini adalah pedoman arsitektur, konvensi kode, dan aturan desain untuk pengembang dan AI Agent yang memelihara atau menambahkan fitur pada bot ini.

---

## 1. Ringkasan Proyek & Tech Stack

* **Runtime:** Node.js v22+ / v24+ (menggunakan opsi bawaan `--env-file-if-exists=.env`).
* **Framework:** Discord.js v14 (`discord.js`, `@discordjs/voice`).
* **Audio Engine:** FFmpeg + `opusscript` + `libsodium-wrappers`.
* **TTS Engine:** Google Translate TTS Publik (`tl=id`, `client=tw-ob`, tanpa API key).
* **Containerization:** Docker (`node:22-alpine` + `apk add ffmpeg`) & Docker Compose dengan volume mount `./sounds:/app/sounds`.

---

## 2. Struktur Proyek

```text
bot-discord/
├── src/
│   ├── commands/
│   │   ├── donasi.js      # Logika !donasi & /donasi
│   │   ├── soundboard.js  # Logika !sb <nama> [repeat] & !sb list
│   │   ├── control.js     # Logika kontrol bot (!pt stop)
│   │   └── help.js        # Logika !help & /help
│   ├── tts.js             # Client Google TTS & pemecah teks <= 200 karakter
│   └── voiceManager.js    # Pengelola voice connection, antrean audio, & timer auto-leave
├── sounds/                # Direktori file lokal .mp3 soundboard (nama file = nama command)
├── index.js               # Entry point utama (hanya registrasi event & inisialisasi)
├── Dockerfile             # Alpine Linux + FFmpeg
├── docker-compose.yml     # Auto-restart & volume mount sounds/
├── package.json           # Dependensi & scripts (start, test)
├── test-check.js          # Unit test berbasis assert bawaan Node.js
└── AGENTS.md              # Dokumen ini
```

---

## 3. Konvensi & Aturan Desain (PENTING)

Setiap AI Agent yang memodifikasi codebase ini **WAJIB** mematuhi aturan berikut:

### A. Format Pesan: Selalu Gunakan "Text Block" (Discord Embed)
* **Semua respon teks** (hint, error, bantuan, stop, list) **wajib menggunakan `EmbedBuilder`** dari `discord.js`.
* **Warna Standar:**
  * Kuning Emas (`0xF1C40F`) untuk info, hint, dan bantuan umum.
  * Merah (`0xED4245`) untuk error (misal sound tidak ditemukan / belum masuk voice).
* Jangan mengirim chat plain text tanpa embed, kecuali sudah disetujui secara eksplisit.

### B. "Silent Success" pada Pemutaran Suara
* Saat perintah pemutaran suara (`!donasi` lengkap, atau `!sb <nama>`) berhasil dieksekusi, **bot dilarang mengirim chat balasan apapun**. Bot hanya memutar suara di Voice Channel secara senyap tanpa meninggalkan jejak chat.

### C. Satu Antrean Suara Terpadu (Shared Queue)
* Semua pemutaran audio (baik TTS donasi maupun soundboard) **wajib melalui `voiceManager.js`**.
* Jangan membuat `AudioPlayer` terpisah per fitur. Setiap server (guild) hanya memiliki **satu player bersama** agar audio mengantre dengan rapi jika ada yang trigger donasi dan soundboard bersamaan.

### D. Aturan Auto-Leave
* Bot keluar otomatis setelah **5 menit** dalam dua kondisi:
  1. **Idle:** Tidak ada audio baru yang diputar selama 5 menit (`IDLE_TIMEOUT_MS = 5 * 60 * 1000`).
  2. **Channel Kosong:** Tidak ada manusia (hanya tersisa bot) di voice channel selama 5 menit (`EMPTY_TIMEOUT_MS = 5 * 60 * 1000`).
* Event `voiceStateUpdate` memantau keluar/masuknya member manusia secara real-time.

### E. Batasan Fitur
* **Soundboard Repeat:** Wajib dibatasi antara `1` sampai `10` kali menggunakan `Math.min(Math.max(repeat, 1), 10)`.
* **Penyimpanan Sound:** Cukup letakkan file `.mp3` ke folder `sounds/`. Bot akan membaca nama file tanpa ekstensi sebagai trigger command (case-insensitive).

---

## 4. Panduan Menambahkan Command Baru

Jika diminta membuat command baru (misal `!prank` atau `!donasijawa`):

1. **Buat file baru di `src/commands/<nama_command>.js`**:
   * Ekspor fungsi `handleMessage(message)` yang mengembalikan `true` jika pesan ditangani, atau `false` jika tidak cocok.
   * Gunakan `EmbedBuilder` untuk setiap balasan teks.
   * Panggil `playDonation` atau `playSoundboard` dari `../voiceManager` jika memutar suara.

2. **Daftarkan di `index.js`**:
   * Import modul di bagian atas.
   * Panggil di dalam event listener `messageCreate`:
     ```javascript
     if (await newCommand.handleMessage(message)) return;
     ```

3. **Perbarui Menu Bantuan di `src/commands/help.js`**:
   * Tambahkan baris command baru di deskripsi `createHelpEmbed()`.

4. **Tulis Unit Test di `test-check.js`**:
   * Tambahkan assert verifikasi regex/logika baru.
   * Jalankan `npm test` dan pastikan semua lulus sebelum menyelesaikan tugas.

---

## 5. Verifikasi & Pengujian

* Jalankan tes lokal:
  ```bash
  npm test
  ```
* Uji coba jalankan bot:
  ```bash
  npm start
  ```
* Rebuild container Docker setelah perubahan kode:
  ```bash
  docker-compose up -d --build
  ```
