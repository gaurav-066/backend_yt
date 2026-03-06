const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const app = express();

app.use(cors());

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'vybzz-yt-backend' });
});

app.get('/search', (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'No query' });

    // Sanitize: remove shell-dangerous characters
    const safe = query.replace(/[;"'`$\\|&<>]/g, '');
    const cmd = `yt-dlp "ytsearch1:${safe}" --get-id --get-title --get-duration --no-playlist -q`;
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
        if (err) return res.status(500).json({ error: 'Search failed' });
        if (!stdout || !stdout.trim()) return res.json({ results: [] });
        const lines = stdout.trim().split('\n');
        const results = [];
        for (let i = 0; i < lines.length - 2; i += 3) {
            results.push({
                title: lines[i],
                videoId: lines[i + 1],
                duration: lines[i + 2]
            });
        }
        res.json({ results });
    });
});

app.get('/stream', (req, res) => {
    const id = req.query.id;
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });

    const cmd = `yt-dlp "https://youtube.com/watch?v=${id}" -f bestaudio -g`;
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
        if (err) return res.status(500).json({ error: 'Stream failed' });
        if (!stdout || !stdout.trim()) return res.status(404).json({ error: 'No stream' });
        res.json({ url: stdout.trim() });
    });
});

app.listen(process.env.PORT || 3000);
