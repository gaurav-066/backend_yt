const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');

const app = express();
app.use(cors());

// Limit concurrent processes to avoid OOM with ytdl-core
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
        const info = await ytdl.getInfo(video.url);

        // Best audio with ytdl-core
        const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });

        res.json({
            videoId: video.videoId,
            title: video.title,
            duration: video.seconds || 0,
            url: audioFormat.url
        });
    } catch (err) {
        console.error('ytdl-core error:', err);
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

        const info = await ytdl.getInfo(video.url);

        // Single combined stream for the background video (around 360p-480p)
        const videoFormat = ytdl.chooseFormat(info.formats, {
            quality: '18', // 18 is usually 360p combined mp4. If missing, it falls back
            filter: 'audioandvideo'
        });

        res.json({
            videoId: video.videoId,
            title: video.title,
            duration: video.seconds || 0,
            url: videoFormat.url
        });
    } catch (err) {
        console.error('ytdl-core error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        activeProcesses--;
    }
});

app.get('/', (req, res) => {
    res.send('VYBZZ YouTube Backend (v4.0 - ytdl-core + concurrency limit)');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
