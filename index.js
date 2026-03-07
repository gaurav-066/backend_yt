const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');

const app = express();
app.use(cors());

// Limit concurrent processes to avoid OOM
let activeProcesses = 0;
const MAX_CONCURRENT = 2;
const MAX_VIDEO_DURATION = 420; // 7 minutes - skip video for longer songs

/**
 * Extract info using yt-dlp with OOM protections
 */
function ytdlpExtract(query, format) {
    return new Promise((resolve, reject) => {
        if (activeProcesses >= MAX_CONCURRENT) {
            return reject(new Error('Server busy'));
        }

        activeProcesses++;

        // Use --print for structured output and --get-url for the stream URL
        // Do NOT use --flat-playlist with --get-url (they conflict)
        const command = `yt-dlp --no-playlist --quiet --no-warnings -f "${format}" --print "%(title)s" --print "%(id)s" --print "%(duration)s" --get-url "ytsearch1:${query}"`;

        exec(command, { timeout: 25000 }, (error, stdout, stderr) => {
            activeProcesses--;

            if (error) {
                console.error(`yt-dlp error for "${query}": ${stderr}`);
                return reject(error);
            }

            const lines = stdout.trim().split('\n').filter(l => l.length > 0);

            // For combined formats: [Title, ID, Duration, URL]
            // For separate video+audio: [Title, ID, Duration, VideoURL, AudioURL]
            if (lines.length >= 4) {
                const duration = parseInt(lines[2]) || 0;
                // Get the first URL that starts with http (stream URL)
                const url = lines.slice(3).find(l => l.startsWith('http'));
                if (url) {
                    resolve({ title: lines[0], videoId: lines[1], duration, url });
                } else {
                    reject(new Error('No stream URL found'));
                }
            } else {
                reject(new Error('Unexpected yt-dlp output'));
            }
        });
    });
}

// ENDPOINT: Audio Search (Fallback for JioSaavn)
app.get('/play', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        // bestaudio only - single stream, low memory
        const result = await ytdlpExtract(query, "bestaudio[ext=m4a]/bestaudio/best");
        res.json(result);
    } catch (err) {
        const code = err.message === 'Server busy' ? 503 : 500;
        res.status(code).json({ error: err.message });
    }
});

// ENDPOINT: Video Background (Smart loop)
// Uses a SINGLE combined stream (best[height<=360]) to avoid muxing issues
app.get('/video', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        // IMPORTANT: Use "best[height<=360]" not "bestvideo+bestaudio"
        // Combined format gives us ONE direct URL that browsers can play directly
        const result = await ytdlpExtract(query, "best[height<=360]/best[height<=480]/best");

        // Skip videos that are too long (prevent OOM on subsequent requests)
        if (result.duration > MAX_VIDEO_DURATION) {
            console.log(`Skipping video: "${query}" too long (${result.duration}s)`);
            return res.status(204).end();
        }

        res.json(result);
    } catch (err) {
        const code = err.message === 'Server busy' ? 503 : 500;
        res.status(code).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    res.send('VYBZZ YouTube Backend (v2.1 - Smart Loop + OOM Protection)');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
