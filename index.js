const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');

const app = express();
app.use(cors());

let activeProcesses = 0;
const MAX_CONCURRENT = 2;
const MAX_VIDEO_DURATION = 420; // 7 minutes

/**
 * Extract info using yt-dlp.
 * Uses --extractor-args "youtube:player_client=android" to bypass bot detection.
 */
function ytdlpExtract(query, format) {
    return new Promise((resolve, reject) => {
        if (activeProcesses >= MAX_CONCURRENT) {
            return reject(new Error('Server busy'));
        }

        activeProcesses++;

        // android player client bypasses the "Sign in to confirm" bot check
        const command = `yt-dlp \
            --no-playlist \
            --quiet \
            --no-warnings \
            --extractor-args "youtube:player_client=android" \
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

            // Expected: [Title, ID, Duration, URL]
            if (lines.length >= 4) {
                const duration = parseInt(lines[2]) || 0;
                // Find the first real stream URL
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

// ENDPOINT: Video background (returns duration for smart 2-min middle loop)
app.get('/video', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        // Single combined stream (video+audio) so browser can play directly
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
    res.send('VYBZZ YouTube Backend (v2.2 - yt-dlp android client)');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
