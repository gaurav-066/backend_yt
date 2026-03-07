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
 * Common extractor function with OOM protections
 * Now also returns duration so frontend can do smart looping
 */
async function extract(query, format, isAudio) {
    return new Promise((resolve, reject) => {
        if (activeProcesses >= MAX_CONCURRENT) {
            return reject(new Error('Server busy'));
        }

        activeProcesses++;

        const cmdFormat = format || (isAudio ? "bestaudio[ext=m4a]/bestaudio/best" : "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]/best");

        // --print duration gives us the video length for smart decisions
        const command = `yt-dlp --no-playlist --flat-playlist --quiet --no-warnings -f "${cmdFormat}" --print "title" --print "id" --print "duration" --get-url "ytsearch1:${query}"`;

        exec(command, { timeout: 20000 }, (error, stdout, stderr) => {
            activeProcesses--;

            if (error) {
                console.error(`yt-dlp error: ${stderr}`);
                return reject(error);
            }

            const lines = stdout.trim().split('\n');
            // Expected lines: [Title, ID, Duration, URL(s)]
            if (lines.length >= 4) {
                const duration = parseInt(lines[2]) || 0;
                resolve({
                    title: lines[0],
                    videoId: lines[1],
                    duration: duration,
                    url: lines[3]  // First URL (video or combined)
                });
            } else if (lines.length >= 1 && lines[0].startsWith('http')) {
                resolve({ url: lines[0], duration: 0 });
            } else {
                reject(new Error('No results'));
            }
        });
    });
}

// ENDPOINT: Audio Search (Fallback for main search)
app.get('/play', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        const result = await extract(query, "bestaudio[ext=m4a]/bestaudio/best", true);
        res.json(result);
    } catch (err) {
        res.status(err.message === 'Server busy' ? 503 : 500).json({ error: err.message });
    }
});

// ENDPOINT: Video Background Search
// Returns duration so frontend can loop the middle 2 mins
app.get('/video', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        // First do a quick duration check with minimal format
        const result = await extract(query, "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]/best", false);

        // If video is too long, skip it to prevent OOM
        if (result.duration > MAX_VIDEO_DURATION) {
            console.log(`Skipping video for "${query}" - too long (${result.duration}s)`);
            return res.status(204).json({ skipped: true, reason: 'Video too long', duration: result.duration });
        }

        res.json(result);
    } catch (err) {
        res.status(err.message === 'Server busy' ? 503 : 500).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    res.send('VYBZZ YouTube Backend (v2.1 - Smart Loop + OOM Protection)');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
