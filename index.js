const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// Path to the yt-dlp binary (downloaded during build)
const YTDLP_BIN = path.join(__dirname, 'yt-dlp');

// ─── CONFIG ─────────────────────────────────────────
const MAX_CONCURRENT = 2;
const MAX_VIDEO_DURATION = 420;  // 7 minutes max for background video
const CACHE_TTL = 3 * 60 * 60 * 1000;  // 3 hours (YouTube URLs expire ~6h)
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

// ─── COOKIE SETUP ───────────────────────────────────
if (process.env.YT_COOKIES) {
    try {
        fs.writeFileSync(COOKIES_FILE, process.env.YT_COOKIES);
        console.log('✅ Cookies written to cookies.txt');
    } catch (e) {
        console.warn('⚠️ Failed to write cookies:', e.message);
    }
} else {
    console.log('ℹ️  No YT_COOKIES env var — running without cookies');
}

// ─── VERIFY YT-DLP ON STARTUP ──────────────────────
execFile(YTDLP_BIN, ['--version'], { timeout: 5000 }, (err, stdout) => {
    if (err) {
        console.error('❌ yt-dlp is NOT installed or not in PATH!');
    } else {
        console.log('✅ yt-dlp version:', stdout.trim());
    }
});

// ─── STREAM URL CACHE ──────────────────────────────
// Key: "videoId:audio" or "videoId:video"  →  Value: { url, ts }
const urlCache = new Map();

function cacheUrl(key, url) {
    urlCache.set(key, { url, ts: Date.now() });
    // Prevent unbounded growth
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

// ─── CONCURRENCY GUARD ─────────────────────────────
let active = 0;

// ─── YT-DLP WRAPPER ────────────────────────────────
function ytdlp(args) {
    return new Promise((resolve, reject) => {
        const cookieArgs = fs.existsSync(COOKIES_FILE)
            ? ['--cookies', COOKIES_FILE]
            : [];

        const allArgs = [
            ...cookieArgs,
            '--no-warnings',
            '--no-check-certificates',
            '--no-playlist',
            '--extractor-args', 'youtube:player_client=default',
            ...args
        ];

        console.log(`[yt-dlp] Running: yt-dlp ${args.join(' ')}`);
        const startTime = Date.now();

        execFile(YTDLP_BIN, allArgs, {
            timeout: 40000,   // 40 seconds max
            maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        }, (err, stdout, stderr) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            if (err) {
                // Extract the most useful error line
                const lines = (stderr || err.message || '').split('\n');
                const errorLine = lines.find(l => l.includes('ERROR')) || lines[0] || err.message;
                console.error(`[yt-dlp] Failed in ${elapsed}s: ${errorLine}`);
                reject(new Error(errorLine));
            } else {
                console.log(`[yt-dlp] Done in ${elapsed}s (${stdout.length} bytes)`);
                resolve(stdout.trim());
            }
        });
    });
}

// ─── /play ENDPOINT ────────────────────────────────
// Searches YouTube, extracts the best audio URL, caches it,
// and returns a proxy stream URL to the browser.
app.get('/play', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });
    if (active >= MAX_CONCURRENT) {
        return res.status(503).json({ error: 'Server busy, try again in a few seconds' });
    }

    active++;
    try {
        // Search YouTube + extract best audio format info as JSON
        const raw = await ytdlp([
            `ytsearch1:${query}`,
            '-f', 'bestaudio',
            '-j'
        ]);

        const info = JSON.parse(raw);
        const videoId = info.id;

        // Get the direct stream URL (may be at top level or in requested_formats)
        const streamUrl = info.url
            || (info.requested_formats && info.requested_formats[0] && info.requested_formats[0].url);

        if (!streamUrl) {
            throw new Error('yt-dlp returned no audio stream URL');
        }

        // Cache the real YouTube URL (only Render's IP can use it)
        const cacheKey = `${videoId}:audio`;
        cacheUrl(cacheKey, streamUrl);

        // Build our proxy URL that the browser will actually use
        const host = `https://${req.get('host')}`;

        res.json({
            videoId,
            title: info.title || query,
            artist: info.channel || info.uploader || '',
            duration: info.duration || 0,
            thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            url: `${host}/stream/${videoId}?t=audio`
        });

    } catch (err) {
        console.error('/play error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        active--;
    }
});

// ─── /video ENDPOINT ───────────────────────────────
// Same as /play but picks a low-res combined video+audio format
// for background video in the fullscreen player.
app.get('/video', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });
    if (active >= MAX_CONCURRENT) {
        return res.status(503).json({ error: 'Server busy, try again in a few seconds' });
    }

    active++;
    try {
        const raw = await ytdlp([
            `ytsearch1:${query}`,
            '-f', 'best[height<=480]/best',
            '-j'
        ]);

        const info = JSON.parse(raw);

        // Skip videos that are too long (saves bandwidth)
        if (info.duration && info.duration > MAX_VIDEO_DURATION) {
            console.log(`[/video] Skipping "${query}" — too long (${info.duration}s)`);
            return res.status(204).end();
        }

        const videoId = info.id;
        const streamUrl = info.url
            || (info.requested_formats && info.requested_formats[0] && info.requested_formats[0].url);

        if (!streamUrl) {
            throw new Error('yt-dlp returned no video stream URL');
        }

        const cacheKey = `${videoId}:video`;
        cacheUrl(cacheKey, streamUrl);

        const host = `https://${req.get('host')}`;

        res.json({
            videoId,
            title: info.title || query,
            duration: info.duration || 0,
            url: `${host}/stream/${videoId}?t=video`
        });

    } catch (err) {
        console.error('/video error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        active--;
    }
});

// ─── /stream/:videoId ENDPOINT (Pipe Proxy) ────────
// This is the magic: Render fetches from googlevideo.com (same IP
// that extracted the URL) and pipes it straight to the browser.
// Zero buffering, zero RAM usage — just a passthrough.
// Supports HTTP Range requests so seeking works in the player.
app.get('/stream/:videoId', (req, res) => {
    const { videoId } = req.params;
    const type = req.query.t || 'audio';
    const cacheKey = `${videoId}:${type}`;

    const sourceUrl = getCachedUrl(cacheKey);
    if (!sourceUrl) {
        return res.status(410).json({
            error: 'Stream expired or not found — the app will re-search automatically'
        });
    }

    try {
        const parsed = new URL(sourceUrl);
        const client = parsed.protocol === 'https:' ? https : http;

        // Build request headers
        const reqHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        // Forward Range header — essential for seeking in <audio>/<video>
        if (req.headers.range) {
            reqHeaders['Range'] = req.headers.range;
        }

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers: reqHeaders
        };

        const upstream = client.get(options, (ytRes) => {
            // Forward status: 200 = full file, 206 = partial (seek)
            res.status(ytRes.statusCode);

            // Forward headers the browser needs for playback
            const headersToForward = [
                'content-type',
                'content-length',
                'content-range',
                'accept-ranges'
            ];
            headersToForward.forEach(h => {
                if (ytRes.headers[h]) res.setHeader(h, ytRes.headers[h]);
            });

            // Allow CORS on the stream itself
            res.setHeader('Access-Control-Allow-Origin', '*');

            // Pipe: YouTube → Render → Browser (zero buffering)
            ytRes.pipe(res);

            ytRes.on('error', () => {
                try { res.end(); } catch (e) { /* already closed */ }
            });
        });

        upstream.on('error', (err) => {
            console.error(`[stream] Upstream error for ${cacheKey}:`, err.message);
            if (!res.headersSent) {
                res.status(502).json({ error: 'YouTube stream failed — try again' });
            }
        });

        // Clean up if the browser disconnects mid-stream
        res.on('close', () => {
            try { upstream.destroy(); } catch (e) { /* already destroyed */ }
        });

    } catch (err) {
        console.error('[stream] Error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal stream error' });
        }
    }
});

// ─── HEALTH CHECK ──────────────────────────────────
app.get('/', (req, res) => {
    const cookies = fs.existsSync(COOKIES_FILE) ? '🍪' : '❌';
    const cached = urlCache.size;
    res.send(`VYBZZ YT Backend v5.0 | yt-dlp + pipe proxy | Cookies: ${cookies} | Cached: ${cached} | Load: ${active}/${MAX_CONCURRENT}`);
});

// ─── START SERVER ──────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 VYBZZ Backend v5.0 running on port ${PORT}`);
});
