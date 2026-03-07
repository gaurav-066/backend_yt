FROM node:18-slim

# Install python and ffmpeg for yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --break-system-packages yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Set environment variables for memory management
ENV NODE_OPTIONS="--max-old-space-size=400"

EXPOSE 3000

CMD ["node", "index.js"]
