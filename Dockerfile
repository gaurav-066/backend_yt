FROM node:18-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl unzip && \
        pip3 install --break-system-packages yt-dlp && \
            curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh && \
                apt-get clean && rm -rf /var/lib/apt/lists/*

                WORKDIR /app
                COPY package.json ./
                RUN npm install
                COPY index.js ./

                EXPOSE 3000
                CMD ["node", "index.js"]
                
