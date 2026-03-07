const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');

const app = express();
app.use(cors());

// You said you have cookies in an ENV variable on Render!
// We parse them into the ytdl agent so it bypasses bot detection.
let ytdlAgent = null;
if (process.env.YT_COOKIES) {
    try {
        let cookies = [];
        const rawCookies = process.env.YT_COOKIES.trim();

        if (rawCookies.startsWith('[')) {
            // Parse as JSON array
            cookies = JSON.parse(rawCookies);
        } else {
            // Parse as Netscape HTTP Cookie File string
            cookies = rawCookies.split('\n')
                .filter(line => line && !line.trim().startsWith('#'))
                .map(line => {
                    const parts = line.split('\t');
                    if (parts.length < 7) return null;
                    return {
                        domain: parts[0],
                        path: parts[2],
                        secure: parts[3] === 'TRUE',
                        expirationDate: parseInt(parts[4], 10) || 0,
                        name: parts[5],
                        value: parts[6].replace(/\r$/, '')
                    };
                })
                .filter(c => c !== null);
        }

        ytdlAgent = ytdl.createAgent(cookies);
        console.log(`✅ YT Cookies loaded from ENV! (${cookies.length} parsed)`);
    } catch (e) {
        console.warn('⚠️ YT_COOKIES env var exists but failed to parse:', e.message);
    }
} else {
    console.warn('⚠️ No YT_COOKIES env var found. Proceeding without authentication.');
}

// Memory / Crash Protection
let activeProcesses = 0;
const MAX_CONCURRENT = 3;
const MAX_VIDEO_DURATION = 420; // 7 minutes

app.get('/play', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    if (activeProcesses >= MAX_CONCURRENT) {
        return res.status(503).json({ error: 'Server busy, retry later' });
    }

    activeProcesses++;
    try {
        const searchResult = await ytSearch(query);
        const videos = searchResult.videos;
        if (!videos.length) throw new Error('No video found');

        const video = videos[0];

        // Pass the agent (cookies) to getInfo
        const fetchOptions = ytdlAgent ? { agent: ytdlAgent } : {};
        const info = await ytdl.getInfo(video.url, fetchOptions);

        const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });

        res.json({
            videoId: video.videoId,
            title: video.title,
            duration: video.seconds || 0,
            url: audioFormat.url
        });
    } catch (err) {
        console.error('ytdl-core /play error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        activeProcesses--;
    }
});

app.get('/video', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    if (activeProcesses >= MAX_CONCURRENT) {
        return res.status(503).json({ error: 'Server busy, retry later' });
    }

    activeProcesses++;
    try {
        const searchResult = await ytSearch(query);
        const videos = searchResult.videos;
        if (!videos.length) throw new Error('No video found');

        const video = videos[0];

        if (video.seconds > MAX_VIDEO_DURATION) {
            console.log(`Skipping video: "${query}" too long (${video.seconds}s)`);
            res.status(204).end();
            return;
        }

        // Pass the agent (cookies) to getInfo
        const fetchOptions = ytdlAgent ? { agent: ytdlAgent } : {};
        const info = await ytdl.getInfo(video.url, fetchOptions);

        // Single combined stream for the background video (around 360p-480p)
        const videoFormat = ytdl.chooseFormat(info.formats, {
            quality: '18',
            filter: 'audioandvideo'
        });

        res.json({
            videoId: video.videoId,
            title: video.title,
            duration: video.seconds || 0,
            url: videoFormat.url
        });
    } catch (err) {
        console.error('ytdl-core /video error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        activeProcesses--;
    }
});

app.get('/', (req, res) => {
    const status = ytdlAgent ? '(Cookies Active 🍪)' : '(No Cookies)';
    res.send(`VYBZZ YouTube Backend (v4.1 - ytdl-core + OOM Guard) ${status}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
