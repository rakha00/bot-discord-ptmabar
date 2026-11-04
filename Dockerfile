FROM node:22-alpine

# Install FFmpeg (wajib untuk pemutaran audio di voice channel Discord)
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Salin manifest dependencies
COPY package*.json ./

# Install dependensi produksi
RUN npm install --omit=dev

# Salin kode aplikasi
COPY . .

# Jalankan bot
CMD ["npm", "start"]
