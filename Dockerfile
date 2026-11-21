FROM node:22-alpine

# Install FFmpeg & yt-dlp (wajib untuk audio voice channel & streaming YouTube)
RUN apk add --no-cache ffmpeg yt-dlp

WORKDIR /app

# Salin manifest dependencies
COPY package*.json ./

# Install dependensi produksi
RUN npm install --omit=dev

# Salin kode aplikasi
COPY . .

# Jalankan bot
CMD ["npm", "start"]
