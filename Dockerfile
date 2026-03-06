FROM node:18-slim
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    pip3 install --break-system-packages yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install
COPY index.js ./
EXPOSE 3000
CMD ["node", "index.js"]
