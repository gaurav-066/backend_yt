const express = require('express');
const { exec, execSync } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// --- COOKIE SETUP ---
const COOKIE_FILE = path.join(__dirname, 'cookies.txt');
let hasCookies = false;

if (process.env.YT_COOKIES) {
    try {
        // yt-dlp is very smart at parsing Netscape format directly.
        // We write the raw string from ENV to a local file.
        fs.writeFileSync(COOKIE_FILE, process.env.YT_COOKIES);
        hasCookies = true;
        console.log('✅ cookies.txt generated from YT_COOKIES');
    } catch (err) {
        console.error('⚠️ Failed to write cookies.txt:', err.message);
    }
} else {
    console.warn('⚠️ No YT_COOKIES env var found.');
}

// Pre-cache EJS (Embedded JS) components for signature solving
try {
    console.log('🔄 Pre-caching yt-dlp EJS components...');
    // We run a dummy call to trigger the download/update of remote components
    execSync(`yt-dlp --remote-components ejs:github "https://youtube.com/watch?v=dQw4w9WgXcQ" --skip-download 2>&1 || true`, { timeout: 60000 });
    console.log('✅ EJS components ready.');
} catch (e) {
    console.log('⚠️ EJS cache skip:', e.message);
}

let activeProcesses = 0;
const MAX_CONCURRENT = 2; // Keep at 2 to stay within 512MB RAM
const MAX_VIDEO_DURATION = 420; // 7 minutes

function ytdlpExtract(query, format) {
    return new Promise((resolve, reject) => {
        if (activeProcesses >= MAX_CONCURRENT) {
            return reject(new Error('Server busy'));
        }

        activeProcesses++;

        const cookieArg = hasCookies ? `--cookies "${COOKIE_FILE}"` : '';
        // --remote-components ejs:github solves the "Precondition check failed" / po-token issue
        const command = `yt-dlp \
            --no-playlist \
            --quiet \
            --no-warnings \
            ${cookieArg} \
            --remote-components ejs:github \
            -f "${format}" \
            --print "%(title)s" \
            --print "%(id)s" \
            --print "%(duration)s" \
            --get-url \
            "ytsearch1:${query}"`;

        exec(command, { timeout: 45000 }, (error, stdout, stderr) => {
            activeProcesses--;

            if (error) {
                console.error(`yt-dlp error for "${query}": ${stderr}`);
                return reject(error);
            }

            const lines = stdout.trim().split('\n').filter(l => l.length > 0);

            // Output order: [Title, ID, Duration, URL]
            if (lines.length >= 4) {
                const duration = parseInt(lines[2]) || 0;
                const url = lines.slice(3).find(l => l.startsWith('http'));
                if (url) {
                    return resolve({ title: lines[0], videoId: lines[1], duration, url });
                }
            }
            reject(new Error('Format search failed or no URL found.'));
        });
    });
}

// ENDPOINT: Audio (Fallback for JioSaavn)
app.get('/play', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        const result = await ytdlpExtract(query, "bestaudio[ext=m4a]/bestaudio/best");
        res.json(result);
    } catch (err) {
        res.status(err.message === 'Server busy' ? 503 : 500).json({ error: err.message });
    }
});

// ENDPOINT: Video Background
app.get('/video', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        // Combined stream (360p) for background video - single URL, browser-compatible
        const result = await ytdlpExtract(query, "best[height<=360]/best[height<=480]/best");

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
    res.send(`VYBZZ YouTube Backend (v6.0 - yt-dlp + EJS Solver + Cookies) ${status}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
