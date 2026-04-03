const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { Innertube } = require('youtubei.js');

const app = express();
app.use(cors());

// ─── CONFIG ─────────────────────────────────────────
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours
const MAX_VIDEO_DURATION = 420;        // 7 min max for video

// ─── CACHE ──────────────────────────────────────────
// Stores { url, ts } so we don't hit YouTube on every play
const urlCache = new Map();

function cacheSet(key, url) {
    urlCache.set(key, { url, ts: Date.now() });
    // Clean up old entries so map doesn't grow forever
    if (urlCache.size > 300) {
        const now = Date.now();
        for (const [k, v] of urlCache) {
            if (now - v.ts > CACHE_TTL) urlCache.delete(k);
        }
    }
}

function cacheGet(key) {
    const entry = urlCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) {
        urlCache.delete(key);
        return null;
    }
    return entry.url;
}

// ─── INNERTUBE SINGLETON ────────────────────────────
// We create ONE instance at startup and reuse it forever.
// This is the key difference from your old code — no cold boot per request!
let yt = null;

async function getYT() {
    if (!yt) {
        console.log('🔧 Initializing Innertube...');
        yt = await Innertube.create({
            cache: true,
            generate_session_locally: true,
        });
        console.log('✅ Innertube ready!');
    }
    return yt;
}

// ─── HELPER: PICK BEST AUDIO FORMAT ─────────────────
// Returns the highest quality audio-only stream URL
function pickAudioUrl(streamingData) {
    const formats = [
        ...(streamingData.adaptive_formats || []),
        ...(streamingData.formats || []),
    ];

    // Audio only formats, sorted by bitrate descending
    const audioOnly = formats
        .filter(f =>
            f.has_audio &&
            !f.has_video &&
            f.url &&
            !f.url.includes('manifest') &&
            !f.url.includes('playlist')
        )
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (audioOnly.length > 0) return audioOnly[0].url;

    // Fallback: any format with audio
    const withAudio = formats
        .filter(f => f.has_audio && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    return withAudio[0]?.url || null;
}

// ─── HELPER: PICK BEST VIDEO FORMAT ─────────────────
// Returns a combined (audio+video) stream ≤480p
// We avoid DASH (separate streams) because merging needs FFmpeg
function pickVideoUrl(streamingData) {
    const formats = streamingData.formats || [];

    // Combined formats (has both audio and video), max 480p
    const combined = formats
        .filter(f =>
            f.has_audio &&
            f.has_video &&
            f.url &&
            (f.height || 0) <= 480 &&
            !f.url.includes('manifest')
        )
        .sort((a, b) => (b.height || 0) - (a.height || 0));

    return combined[0]?.url || null;
}

// ─── HELPER: PIPE PROXY ──────────────────────────────
// This is the magic sauce — since the stream URL is tied to
// YOUR server's IP (Render), we proxy it through the server.
// Zero buffering, just a passthrough pipe.
function proxyStream(sourceUrl, req, res) {
    try {
        const parsed = new URL(sourceUrl);
        const client = parsed.protocol === 'https:' ? https : http;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com',
        };

        // Forward Range header so seeking works!
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers,
        };

        const upstream = client.get(options, (ytRes) => {
            res.status(ytRes.statusCode);

            // Forward headers browser needs for playback
            ['content-type', 'content-length', 'content-range', 'accept-ranges']
                .forEach(h => {
                    if (ytRes.headers[h]) res.setHeader(h, ytRes.headers[h]);
                });

            res.setHeader('Access-Control-Allow-Origin', '*');

            // YouTube → Render → User  (pure pipe, no buffering)
            ytRes.pipe(res);
            ytRes.on('error', () => { try { res.end(); } catch (e) {} });
        });

        upstream.on('error', (err) => {
            console.error('[proxy] Upstream error:', err.message);
            if (!res.headersSent) res.status(502).json({ error: 'Stream failed' });
        });

        res.on('close', () => { try { upstream.destroy(); } catch (e) {} });

    } catch (err) {
        console.error('[proxy] Error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Proxy error' });
    }
}

// ─── /search ENDPOINT ────────────────────────────────
// Just returns search results (no streaming), useful for search screen
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        const youtube = await getYT();
        const results = await youtube.search(query, { type: 'video' });

        const videos = results.videos.slice(0, 10).map(v => ({
            id: v.id,
            title: v.title?.text || '',
            artist: v.author?.name || '',
            duration: v.duration?.seconds || 0,
            thumbnail: v.best_thumbnail?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        }));

        res.json(videos);

    } catch (err) {
        console.error('/search error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── /play ENDPOINT ──────────────────────────────────
// Search + get audio stream URL in one shot
// Returns a proxy URL that the app actually plays
app.get('/play', async (req, res) => {
    const query = req.query.q;
    const videoId = req.query.id; // can pass video ID directly too
    if (!query && !videoId) return res.status(400).json({ error: 'Query or ID required' });

    try {
        const youtube = await getYT();

        let id = videoId;
        let title = query;
        let artist = '';
        let duration = 0;
        let thumbnail = '';

        // If no ID given, search first to get it
        if (!id) {
            const results = await youtube.search(query, { type: 'video' });
            const top = results.videos[0];
            if (!top) return res.status(404).json({ error: 'No results found' });

            id = top.id;
            title = top.title?.text || query;
            artist = top.author?.name || '';
            duration = top.duration?.seconds || 0;
            thumbnail = top.best_thumbnail?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        }

        // Check cache first — avoid hitting YouTube again
        const cacheKey = `${id}:audio`;
        let streamUrl = cacheGet(cacheKey);

        if (!streamUrl) {
            // Not cached — fetch fresh stream info
            const info = await youtube.getInfo(id);
            streamUrl = pickAudioUrl(info.streaming_data);

            if (!streamUrl) return res.status(500).json({ error: 'No audio stream found' });

            cacheSet(cacheKey, streamUrl);
        }

        const host = `https://${req.get('host')}`;

        res.json({
            videoId: id,
            title,
            artist,
            duration,
            thumbnail: thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            url: `${host}/stream/${id}?t=audio`,  // proxy URL
        });

    } catch (err) {
        console.error('/play error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── /video ENDPOINT ─────────────────────────────────
// Same as /play but returns a combined video+audio stream
app.get('/video', async (req, res) => {
    const query = req.query.q;
    const videoId = req.query.id;
    if (!query && !videoId) return res.status(400).json({ error: 'Query or ID required' });

    try {
        const youtube = await getYT();

        let id = videoId;
        let title = query;
        let duration = 0;
        let thumbnail = '';

        if (!id) {
            const results = await youtube.search(query, { type: 'video' });
            const top = results.videos[0];
            if (!top) return res.status(404).json({ error: 'No results found' });

            id = top.id;
            title = top.title?.text || query;
            duration = top.duration?.seconds || 0;
            thumbnail = top.best_thumbnail?.url || '';

            // Skip very long videos
            if (duration > MAX_VIDEO_DURATION) {
                return res.status(204).end();
            }
        }

        const cacheKey = `${id}:video`;
        let streamUrl = cacheGet(cacheKey);

        if (!streamUrl) {
            const info = await youtube.getInfo(id);

            // Skip long videos (when fetched by ID directly)
            if (info.basic_info?.duration > MAX_VIDEO_DURATION) {
                return res.status(204).end();
            }

            streamUrl = pickVideoUrl(info.streaming_data);
            if (!streamUrl) return res.status(500).json({ error: 'No video stream found' });

            cacheSet(cacheKey, streamUrl);
        }

        const host = `https://${req.get('host')}`;

        res.json({
            videoId: id,
            title,
            duration,
            thumbnail: thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            url: `${host}/stream/${id}?t=video`,
        });

    } catch (err) {
        console.error('/video error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── /stream/:videoId ENDPOINT ───────────────────────
// The proxy — Render fetches from YouTube (same IP that got the URL)
// and pipes it straight to the user. Supports Range for seeking.
app.get('/stream/:videoId', (req, res) => {
    const { videoId } = req.params;
    const type = req.query.t || 'audio';
    const cacheKey = `${videoId}:${type}`;

    const sourceUrl = cacheGet(cacheKey);
    if (!sourceUrl) {
        return res.status(410).json({
            error: 'Stream expired — call /play or /video again to refresh'
        });
    }

    proxyStream(sourceUrl, req, res);
});

// ─── HEALTH CHECK ────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        cached: urlCache.size,
        innertube: yt ? 'ready' : 'not initialized yet',
        endpoints: {
            search: '/search?q=song name',
            play:   '/play?q=song name  OR  /play?id=videoId',
            video:  '/video?q=song name  OR  /video?id=videoId',
            stream: '/stream/:videoId?t=audio|video',
        }
    });
});

// ─── START ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    // Pre-warm Innertube so first request isn't slow
    await getYT();
});
