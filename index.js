const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());

// --- COOKIE SETUP ---
// yt-dlp reads netscape format cookies directly from a text file.
// We write the YT_COOKIES env var to a file on server start.
let hasCookies = false;
if (process.env.YT_COOKIES) {
    try {
        fs.writeFileSync('cookies.txt', process.env.YT_COOKIES);
        hasCookies = true;
        console.log('✅ cookies.txt successfully generated from YT_COOKIES env var!');
    } catch (err) {
        console.error('⚠️ Failed to write cookies.txt:', err.message);
    }
} else {
    console.warn('⚠️ No YT_COOKIES env var found. yt-dlp will run unauthenticated.');
}

let activeProcesses = 0;
const MAX_CONCURRENT = 2; // Strict limit to prevent RAM OOM
const MAX_VIDEO_DURATION = 420; // 7 minutes

function ytdlpExtract(query, format) {
    return new Promise((resolve, reject) => {
        if (activeProcesses >= MAX_CONCURRENT) {
            return reject(new Error('Server busy'));
        }

        activeProcesses++;

        const cookieArg = hasCookies ? '--cookies cookies.txt' : '';
        const command = `yt-dlp \
            --no-playlist \
            --quiet \
            --no-warnings \
            ${cookieArg} \
            -f "${format}" \
            --print "%(title)s" \
            --print "%(id)s" \
            --print "%(duration)s" \
            --get-url \
            "ytsearch1:${query}"`;

        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
            activeProcesses--;

            if (error) {
                console.error(`yt-dlp error for "${query}": ${stderr}`);
                return reject(error);
            }

            const lines = stdout.trim().split('\n').filter(l => l.length > 0);

            if (lines.length >= 4) {
                const duration = parseInt(lines[2]) || 0;
                const url = lines.slice(3).find(l => l.startsWith('http'));
                if (url) {
                    return resolve({ title: lines[0], videoId: lines[1], duration, url });
                }
            }
            reject(new Error('Could not parse yt-dlp output: ' + lines.join(' | ')));
        });
    });
}

// ENDPOINT: Audio fallback
app.get('/play', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        const result = await ytdlpExtract(query, 'bestaudio[ext=m4a]/bestaudio/best');
        res.json(result);
    } catch (err) {
        res.status(err.message === 'Server busy' ? 503 : 500).json({ error: err.message });
    }
});

// ENDPOINT: Video background
app.get('/video', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        const result = await ytdlpExtract(query, 'best[height<=360]/best[height<=480]/best');

        if (result.duration > MAX_VIDEO_DURATION) {
            console.log(`Skipping: "${query}" too long (${result.duration}s)`);
            return res.status(204).end();
        }

        res.json(result);
    } catch (err) {
        res.status(err.message === 'Server busy' ? 503 : 500).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    const status = hasCookies ? '(Cookies Active 🍪)' : '(No Cookies)';
    res.send(`VYBZZ YouTube Backend (v5.0 - yt-dlp + Cookies + OOM Guard) ${status}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
