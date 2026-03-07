FROM node:18-slim

# Install Python3 + pip + yt-dlp
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    pip3 install --break-system-packages yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Memory limit for 512MB Render tier
ENV NODE_OPTIONS="--max-old-space-size=400"

EXPOSE 3000

CMD ["node", "index.js"]
