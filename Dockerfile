FROM nikolaik/python-nodejs:python3.11-nodejs20

# Install ffmpeg and curl
RUN apt-get update && apt-get install -y ffmpeg curl unzip && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Deno (required for yt-dlp signature solver)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_DIR="/root/.deno"
ENV PATH="${DENO_DIR}/bin:${PATH}"

# Install latest yt-dlp binary directly from GitHub
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

# Memory limit for Node process
ENV NODE_OPTIONS="--max-old-space-size=400"

EXPOSE 3000

CMD ["node", "index.js"]
