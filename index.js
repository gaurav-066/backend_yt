const express = require('express');
const cors = require('cors');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const app = express();

app.use(cors());

// Write cookies to file if provided in ENV
let cookieArg = '';
if (process.env.YT_COOKIES) {
        fs.writeFileSync('/tmp/cookies.txt', process.env.YT_COOKIES);
        cookieArg = '--cookies /tmp/cookies.txt';
        console.log('Cookies loaded from environment variable.');
}

// Pre-cache EJS components without updating yt-dlp version
try {
        execSync(`yt-dlp --remote-components ejs:github "https://youtube.com/watch?v=dQw4w9WgXcQ" --skip-download 2>&1 || true`, { timeout: 60000 });
        console.log('EJS components pre-cached.');
} catch (e) { console.log('EJS cache error:', e.message); }

app.get('/', (req, res) => {
        res.json({ status: 'ok', service: 'vybzz-yt-backend' });
});

app.get('/search', (req, res) => {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: 'No query' });

            const safe = query.replace(/[;"'`$\\|&<>]/g, '');
        const cmd = `yt-dlp "ytsearch1:${safe}" --get-id --get-title --get-duration --no-playlist -q ${cookieArg} --remote-components ejs:github`;
        exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
                    if (err) return res.status(500).json({ error: 'Search failed', details: err.message, stderr: stderr });
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

            const cmd = `yt-dlp "https://youtube.com/watch?v=${id}" -f bestaudio -g ${cookieArg} --remote-components ejs:github`;
        exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
                    if (err) return res.status(500).json({ error: 'Stream failed', details: err.message, stderr: stderr });
                    if (!stdout || !stdout.trim()) return res.status(404).json({ error: 'No stream' });
                    res.json({ url: stdout.trim() });
        });
});

app.listen(process.env.PORT || 3000, () => {
        console.log('Server started on port', process.env.PORT || 3000);
});
