const express = require('express');
const cors = require('cors');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const app = express();

app.use(cors());

let cookieArg = '';
if (process.env.YT_COOKIES) {
    fs.writeFileSync('/tmp/cookies.txt', process.env.YT_COOKIES);
    cookieArg = '--cookies /tmp/cookies.txt';
    console.log('Cookies loaded.');
}

// Pre-download EJS solver at startup so it doesn't download every request
try {
    execSync(`yt-dlp --remote-components ejs:github "https://youtube.com/watch?v=dQw4w9WgXcQ" --skip-download 2>&1 || true`, { timeout: 60000 });
    console.log('yt-dlp updated and EJS components cached.');
} catch(e) { console.log('EJS pre-cache skipped:', e.message); }

// In-memory cache for stream URLs (they last ~6 hours)
const cache = new Map();
setInterval(() => cache.clear(), 3600000); // Clear cache every hour

app.get('/', (req, res) => {
    res.json({ status: 'ok', cached: cache.size });
});

// FAST: Single combined endpoint - search + get stream URL in one yt-dlp call
app.get('/play', (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'No query' });

    // Check cache first
    const cacheKey = query.toLowerCase().trim();
    if (cache.has(cacheKey)) {
        console.log('Cache hit:', cacheKey);
        return res.json(cache.get(cacheKey));
    }

    const safe = query.replace(/[;"'`$\\|&<>]/g, '');
    // Single call: get title, URL, thumbnail, and duration all at once
    const cmd = `yt-dlp "ytsearch1:${safe}" -f bestaudio --get-url --get-title --get-id --get-duration --no-playlist -q ${cookieArg} --remote-components ejs:github`;
    exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) return res.status(500).json({ error: 'Failed', details: err.message, stderr });
        if (!stdout || !stdout.trim()) return res.json({ error: 'No results' });

        const lines = stdout.trim().split('\n');
        // Output order: title, id, url, duration
        if (lines.length < 4) return res.json({ error: 'Incomplete result' });

        const result = {
            title: lines[0],
            videoId: lines[1],
            url: lines[2],
            duration: lines[3],
            thumbnail: `https://i.ytimg.com/vi/${lines[1]}/hqdefault.jpg`
        };

        cache.set(cacheKey, result);
        res.json(result);
    });
});

// Keep old endpoints for compatibility
app.get('/search', (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'No query' });
    const safe = query.replace(/[;"'`$\\|&<>]/g, '');
    const cmd = `yt-dlp "ytsearch1:${safe}" --get-id --get-title --get-duration --no-playlist -q ${cookieArg} --remote-components ejs:github`;
    exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
        if (err) return res.status(500).json({ error: 'Search failed', details: err.message, stderr });
        if (!stdout || !stdout.trim()) return res.json({ results: [] });
        const lines = stdout.trim().split('\n');
        const results = [];
        for (let i = 0; i < lines.length - 2; i += 3) {
            results.push({ title: lines[i], videoId: lines[i+1], duration: lines[i+2] });
        }
        res.json({ results });
    });
});

app.get('/stream', (req, res) => {
    const id = req.query.id;
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
    const cmd = `yt-dlp "https://youtube.com/watch?v=${id}" -f bestaudio -g ${cookieArg} --remote-components ejs:github`;
    exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
        if (err) return res.status(500).json({ error: 'Stream failed', details: err.message, stderr });
        if (!stdout || !stdout.trim()) return res.status(404).json({ error: 'No stream' });
        res.json({ url: stdout.trim() });
    });
});

app.listen(process.env.PORT || 3000, () => {
    console.log('Server started on port', process.env.PORT || 3000);
});
