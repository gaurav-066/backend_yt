const express = require('express');
const { exec } = require('child_process');
const app = express();

app.get('/search', (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'No query' });

    const cmd = `yt-dlp "ytsearch3:${query}" --get-id --get-title --get-duration --no-playlist -q`;
    exec(cmd, { timeout: 15000 }, (err, stdout) => {
        if (err) return res.status(500).json({ error: err.message });
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
    if (!id) return res.status(400).json({ error: 'No id' });

    const cmd = `yt-dlp "https://youtube.com/watch?v=${id}" -f bestaudio -g`;
    exec(cmd, { timeout: 15000 }, (err, stdout) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ url: stdout.trim() });
    });
});

app.listen(process.env.PORT || 3000);
