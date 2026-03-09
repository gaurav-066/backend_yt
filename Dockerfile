FROM node:18-slim

# Install python3, pip, curl, unzip
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip curl unzip && \
    pip3 install --break-system-packages yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Deno (required for YouTube signature solving / EJS plugin)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_DIR="/root/.deno"
ENV PATH="${DENO_DIR}/bin:${PATH}"

RUN yt-dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV NODE_OPTIONS="--max-old-space-size=400"

EXPOSE 3000

CMD ["node", "index.js"]
