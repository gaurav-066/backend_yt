FROM node:18-slim

# Install python3 (needed by yt-dlp) and curl (to download yt-dlp)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Verify yt-dlp works DURING BUILD (if this fails, the build fails — no surprises at runtime)
RUN yt-dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV NODE_OPTIONS="--max-old-space-size=400"

EXPOSE 3000

CMD ["node", "index.js"]
