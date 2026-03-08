const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

/* ───────── CONFIG ───────── */

const MAX_CONCURRENT = 2;
const MAX_VIDEO_DURATION = 420;
const CACHE_TTL = 3 * 60 * 60 * 1000;
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

/* ───────── COOKIE SETUP ───────── */

if (process.env.YT_COOKIES) {
    try {
        fs.writeFileSync(COOKIES_FILE, process.env.YT_COOKIES);
        console.log("Cookies loaded");
    } catch (e) {
        console.warn("Cookie load failed");
    }
}

/* ───────── VERIFY YT-DLP ───────── */

execFile('yt-dlp', ['--version'], (err, stdout) => {
    if (err) console.error("yt-dlp missing");
    else console.log("yt-dlp:", stdout.trim());
});

/* ───────── CACHE ───────── */

const urlCache = new Map();

function cacheUrl(key, url) {
    urlCache.set(key, { url, ts: Date.now() });

    if (urlCache.size > 200) {
        const now = Date.now();
        for (const [k, v] of urlCache) {
            if (now - v.ts > CACHE_TTL) urlCache.delete(k);
        }
    }
}

function getCachedUrl(key) {
    const entry = urlCache.get(key);

    if (!entry) return null;

    if (Date.now() - entry.ts > CACHE_TTL) {
        urlCache.delete(key);
        return null;
    }

    return entry.url;
}

/* ───────── CONCURRENCY LIMIT ───────── */

let active = 0;

/* ───────── YT-DLP WRAPPER ───────── */

function ytdlp(args) {

    return new Promise((resolve, reject) => {

        const cookieArgs = fs.existsSync(COOKIES_FILE)
            ? ['--cookies', COOKIES_FILE]
            : [];

        const fullArgs = [
            ...cookieArgs,
            '--no-warnings',
            '--no-playlist',
            '--no-check-certificates',
            '--remote-components', 'ejs:github',
            ...args
        ];

        execFile(
            'yt-dlp',
            fullArgs,
            { timeout: 40000, maxBuffer: 2 * 1024 * 1024 },
            (err, stdout, stderr) => {

                if (err) {
                    const msg = stderr || err.message;
                    return reject(new Error(msg));
                }

                resolve(stdout.trim());
            }
        );
    });
}

/* ───────── VIDEO ENDPOINT ───────── */

app.get('/video', async (req, res) => {

    const query = req.query.q;
    const videoIdParam = req.query.id;

    if (!query && !videoIdParam)
        return res.status(400).json({ error: "Query or videoId required" });

    if (active >= MAX_CONCURRENT)
        return res.status(503).json({ error: "Server busy" });

    active++;

    try {

        let raw;

        /* FAST MODE (videoId) */

        if (videoIdParam) {

            raw = await ytdlp([
                `https://www.youtube.com/watch?v=${videoIdParam}`,
                "-j"
            ]);

        }

        /* SEARCH MODE */

        else {

            raw = await ytdlp([
                `ytsearch1:${query}`,
                "-j"
            ]);

        }

        const info = JSON.parse(raw);

        if (info.duration && info.duration > MAX_VIDEO_DURATION)
            return res.status(204).end();

        const videoId = info.id;

        let streamUrl = null;

        if (info.formats && info.formats.length > 0) {

            const mp4 = info.formats
                .filter(f =>
                    f.acodec !== "none" &&
                    f.vcodec !== "none" &&
                    f.ext === "mp4" &&
                    (f.height || 0) <= 480 &&
                    !f.url.includes("manifest")
                )
                .sort((a, b) => (b.height || 0) - (a.height || 0));

            if (mp4.length > 0)
                streamUrl = mp4[0].url;
        }

        if (!streamUrl)
            streamUrl = info.url;

        if (!streamUrl)
            throw new Error("No stream URL");

        const cacheKey = `${videoId}:video`;

        cacheUrl(cacheKey, streamUrl);

        const host = `https://${req.get("host")}`;

        res.json({
            videoId,
            title: info.title,
            duration: info.duration,
            url: `${host}/stream/${videoId}?t=video`
        });

    }
    catch (err) {

        console.error(err);

        res.status(500).json({ error: err.message });

    }
    finally {

        active--;

    }

});

/* ───────── STREAM ENDPOINT ───────── */

app.get('/stream/:videoId', (req, res) => {

    const videoId = req.params.videoId;

    const type = req.query.t || "video";

    const cacheKey = `${videoId}:${type}`;

    const sourceUrl = getCachedUrl(cacheKey);

    if (!sourceUrl)
        return res.status(410).json({ error: "Stream expired" });

    const parsed = new URL(sourceUrl);

    const client = parsed.protocol === "https:" ? https : http;

    const headers = {
        "User-Agent": "Mozilla/5.0"
    };

    if (req.headers.range)
        headers.Range = req.headers.range;

    const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        headers
    };

    const upstream = client.get(options, ytRes => {

        res.status(ytRes.statusCode);

        ["content-type", "content-length", "content-range", "accept-ranges"]
            .forEach(h => {
                if (ytRes.headers[h])
                    res.setHeader(h, ytRes.headers[h]);
            });

        res.setHeader("Access-Control-Allow-Origin", "*");

        ytRes.pipe(res);

    });

    upstream.on("error", err => {

        console.error(err);

        if (!res.headersSent)
            res.status(500).json({ error: "Stream error" });

    });

});

/* ───────── HEALTH CHECK ───────── */

app.get('/', (req, res) => {

    res.send(`YT Backend Running | cache=${urlCache.size} | load=${active}`);

});

/* ───────── SERVER START ───────── */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log("Server running on", PORT);

});
