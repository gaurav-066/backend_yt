const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

/* ───────── CONFIG ───────── */

const MAX_CONCURRENT = 2;
const MAX_VIDEO_DURATION = 420;
const CACHE_TTL = 3 * 60 * 60 * 1000;

const COOKIES_FILE = path.join(__dirname, "cookies.txt");

let active = 0;

/* ───────── LOAD COOKIES FROM ENV ───────── */

if (process.env.YT_COOKIES) {
  try {
    const cookies = process.env.YT_COOKIES.replace(/\\n/g, "\n");
    fs.writeFileSync(COOKIES_FILE, cookies);
    console.log("Cookies loaded");
  } catch (e) {
    console.error("Failed to write cookies:", e.message);
  }
}

/* ───────── CACHE ───────── */

const urlCache = new Map();

function cacheUrl(key, url) {
  urlCache.set(key, {
    url,
    ts: Date.now()
  });
}

function getCachedUrl(key) {

  const entry = urlCache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.ts > CACHE_TTL) {
    urlCache.delete(key);
    return null;
  }

  return entry.url;
}

/* ───────── VERIFY YT-DLP ───────── */

execFile("yt-dlp", ["--version"], (err, stdout) => {
  if (err) {
    console.error("yt-dlp not installed");
  } else {
    console.log("yt-dlp:", stdout.trim());
  }
});

/* ───────── SAFE JSON PARSER ───────── */

function parseYtJson(raw) {

  const start = raw.indexOf("{");

  if (start === -1) {
    throw new Error("Invalid yt-dlp output");
  }

  const json = raw.slice(start);

  return JSON.parse(json);
}

/* ───────── YT-DLP WRAPPER ───────── */

function ytdlp(args) {

  return new Promise((resolve, reject) => {

    const cookieArgs = fs.existsSync(COOKIES_FILE)
      ? ["--cookies", COOKIES_FILE]
      : [];

    const fullArgs = [

      ...cookieArgs,

      "--skip-download",
      "--dump-single-json",

      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--no-check-certificates",

      "--format-sort",
      "res,abr",

      "--remote-components",
      "ejs:github",

      ...args
    ];

    execFile(
      "yt-dlp",
      fullArgs,
      {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024
      },
      (err, stdout, stderr) => {

        if (err) {
          return reject(new Error(stderr || err.message));
        }

        resolve(stdout.trim());
      }
    );

  });

}

/* ───────── PREFETCH AUDIO ───────── */

async function prefetchAudio(videoId) {

  try {

    const key = `${videoId}:audio`;

    if (getCachedUrl(key)) return;

    const raw = await ytdlp([
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    const info = parseYtJson(raw);

    let streamUrl = null;

    const audioFormats = info.formats
      .filter(f =>
        f.acodec !== "none" &&
        (f.vcodec === "none" || !f.vcodec) &&
        !f.url.includes("manifest") &&
        !f.url.includes("playlist")
      )
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    if (audioFormats.length > 0) {
      streamUrl = audioFormats[0].url;
    }

    if (!streamUrl) {
      streamUrl = info.url;
    }

    if (streamUrl) {
      cacheUrl(key, streamUrl);
    }

  } catch (err) {

    console.error("Prefetch audio failed:", err.message);

  }

}

/* ───────── VIDEO ENDPOINT ───────── */

app.get("/video", async (req, res) => {

  const query = req.query.q;
  const videoIdParam = req.query.id;

  if (!query && !videoIdParam) {
    return res.status(400).json({ error: "Query or videoId required" });
  }

  if (active >= MAX_CONCURRENT) {
    return res.status(503).json({ error: "Server busy" });
  }

  active++;

  try {

    let raw;

    if (videoIdParam) {

      raw = await ytdlp([
        `https://www.youtube.com/watch?v=${videoIdParam}`
      ]);

    } else {

      raw = await ytdlp([
        `ytsearch1:${query}`
      ]);

    }

    const info = parseYtJson(raw);

    if (info.duration && info.duration > MAX_VIDEO_DURATION) {
      return res.status(204).end();
    }

    const videoId = info.id;

    let streamUrl = null;

    const mp4 = info.formats
      .filter(f =>
        f.acodec !== "none" &&
        f.vcodec !== "none" &&
        f.ext === "mp4" &&
        (f.height || 0) <= 480 &&
        !f.url.includes("manifest")
      )
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    if (mp4.length > 0) {
      streamUrl = mp4[0].url;
    }

    if (!streamUrl) {
      streamUrl = info.url;
    }

    if (!streamUrl) {
      throw new Error("No stream URL");
    }

    const cacheKey = `${videoId}:video`;

    cacheUrl(cacheKey, streamUrl);

    const host = `${req.protocol}://${req.get("host")}`;

    res.json({
      videoId,
      title: info.title,
      duration: info.duration,
      url: `${host}/stream/${videoId}?t=video`
    });

    if (query && videoId) {
      setTimeout(() => prefetchAudio(videoId), 0);
    }

  } catch (err) {

    console.error(err);
    res.status(500).json({ error: err.message });

  } finally {

    active--;

  }

});

/* ───────── AUDIO ENDPOINT ───────── */

app.get("/audio", async (req, res) => {

  const videoId = req.query.id;

  if (!videoId) {
    return res.status(400).json({ error: "videoId required" });
  }

  if (active >= MAX_CONCURRENT) {
    return res.status(503).json({ error: "Server busy" });
  }

  active++;

  try {

    const raw = await ytdlp([
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    const info = parseYtJson(raw);

    let streamUrl = null;

    const audioFormats = info.formats
      .filter(f =>
        f.acodec !== "none" &&
        (f.vcodec === "none" || !f.vcodec) &&
        !f.url.includes("manifest")
      )
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    if (audioFormats.length > 0) {
      streamUrl = audioFormats[0].url;
    }

    if (!streamUrl) {
      streamUrl = info.url;
    }

    if (!streamUrl) {
      throw new Error("No audio stream");
    }

    const cacheKey = `${videoId}:audio`;

    cacheUrl(cacheKey, streamUrl);

    const host = `${req.protocol}://${req.get("host")}`;

    res.json({
      videoId,
      title: info.title,
      duration: info.duration,
      url: `${host}/stream/${videoId}?t=audio`
    });

  } catch (err) {

    console.error(err);
    res.status(500).json({ error: err.message });

  } finally {

    active--;

  }

});

/* ───────── STREAM PROXY ───────── */

app.get("/stream/:videoId", (req, res) => {

  const videoId = req.params.videoId;
  const type = req.query.t || "video";

  const cacheKey = `${videoId}:${type}`;
  const sourceUrl = getCachedUrl(cacheKey);

  if (!sourceUrl) {
    return res.status(410).json({ error: "Stream expired" });
  }

  const parsed = new URL(sourceUrl);

  const client = parsed.protocol === "https:" ? https : http;

  const headers = {
    "User-Agent": "Mozilla/5.0"
  };

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + parsed.search,
    headers
  };

  const upstream = client.get(options, ytRes => {

    res.status(ytRes.statusCode);

    [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges"
    ].forEach(h => {

      if (ytRes.headers[h]) {
        res.setHeader(h, ytRes.headers[h]);
      }

    });

    res.setHeader("Access-Control-Allow-Origin", "*");

    ytRes.pipe(res);

  });

  upstream.on("error", err => {

    console.error("Stream error:", err.message);

    if (!res.headersSent) {
      res.status(500).json({ error: "Stream failed" });
    }

  });

  res.on("close", () => {
    upstream.destroy();
  });

});

/* ───────── HEALTH CHECK ───────── */

app.get("/", (req, res) => {

  res.send(
    `YT Backend Running | cache=${urlCache.size} | active=${active}/${MAX_CONCURRENT}`
  );

});

/* ───────── SERVER START ───────── */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log("YT backend running on port", PORT);

});
