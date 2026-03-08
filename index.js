const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

/* CONFIG */

const MAX_CONCURRENT = 2;
const MAX_VIDEO_DURATION = 420;
const CACHE_TTL = 3 * 60 * 60 * 1000;

const COOKIES_FILE = path.join(__dirname, "cookies.txt");

let active = 0;

/* LOAD COOKIES FROM ENV */

if (process.env.YT_COOKIES) {
  try {
    const cookies = process.env.YT_COOKIES.replace(/\\n/g, "\n");
    fs.writeFileSync(COOKIES_FILE, cookies);
    console.log("Cookies loaded");
  } catch (err) {
    console.error("Cookie load failed:", err.message);
  }
}

/* CACHE */

const urlCache = new Map();

function cacheUrl(key, url) {
  urlCache.set(key, { url, ts: Date.now() });
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

/* VERIFY YT-DLP */

execFile("yt-dlp", ["--version"], (err, stdout) => {
  if (err) console.error("yt-dlp not found");
  else console.log("yt-dlp:", stdout.trim());
});

/* SAFE JSON PARSER */

function safeParse(raw) {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("Invalid yt-dlp output");
  return JSON.parse(raw.slice(start));
}

/* YT-DLP WRAPPER */

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

      "--format-sort",
      "res,abr",

      ...args
    ];

    execFile(
      "yt-dlp",
      fullArgs,
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
  });
}

/* PREFETCH AUDIO */

async function prefetchAudio(videoId) {
  try {
    const key = `${videoId}:audio`;
    if (getCachedUrl(key)) return;

    const raw = await ytdlp([`https://www.youtube.com/watch?v=${videoId}`]);
    const info = safeParse(raw);

    const formats = info.formats || [];

    const audio = formats
      .filter(f =>
        f.acodec !== "none" &&
        (!f.vcodec || f.vcodec === "none") &&
        f.url
      )
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    if (audio.length > 0) {
      cacheUrl(key, audio[0].url);
    }

  } catch (err) {
    console.log("Prefetch skipped:", err.message);
  }
}

/* VIDEO SEARCH */

app.get("/video", async (req, res) => {

  const query = req.query.q;
  const id = req.query.id;

  if (!query && !id)
    return res.status(400).json({ error: "query required" });

  if (active >= MAX_CONCURRENT)
    return res.status(503).json({ error: "server busy" });

  active++;

  try {

    let raw;

    if (id)
      raw = await ytdlp([`https://www.youtube.com/watch?v=${id}`]);
    else
      raw = await ytdlp([`ytsearch1:${query}`]);

    const info = safeParse(raw);

    if (!info || !info.id)
      return res.status(500).json({ error: "invalid yt response" });

    if (info.duration && info.duration > MAX_VIDEO_DURATION)
      return res.status(204).end();

    const formats = info.formats || [];

    const mp4 = formats
      .filter(f =>
        f.acodec !== "none" &&
        f.vcodec !== "none" &&
        f.ext === "mp4" &&
        f.url
      )
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    let streamUrl = mp4.length ? mp4[0].url : info.url;

    if (!streamUrl)
      return res.status(500).json({ error: "no stream found" });

    const cacheKey = `${info.id}:video`;

    cacheUrl(cacheKey, streamUrl);

    const host = `${req.protocol}://${req.get("host")}`;

    res.json({
      videoId: info.id,
      title: info.title,
      duration: info.duration,
      url: `${host}/stream/${info.id}?t=video`
    });

    if (query) setTimeout(() => prefetchAudio(info.id), 0);

  } catch (err) {

    console.error(err.message);

    res.status(500).json({ error: err.message });

  } finally {

    active--;

  }

});

/* AUDIO */

app.get("/audio", async (req, res) => {

  const id = req.query.id;

  if (!id)
    return res.status(400).json({ error: "video id required" });

  try {

    const raw = await ytdlp([`https://www.youtube.com/watch?v=${id}`]);
    const info = safeParse(raw);

    const formats = info.formats || [];

    const audio = formats
      .filter(f =>
        f.acodec !== "none" &&
        (!f.vcodec || f.vcodec === "none") &&
        f.url
      )
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    if (!audio.length)
      return res.status(500).json({ error: "no audio found" });

    const cacheKey = `${id}:audio`;

    cacheUrl(cacheKey, audio[0].url);

    const host = `${req.protocol}://${req.get("host")}`;

    res.json({
      videoId: id,
      title: info.title,
      duration: info.duration,
      url: `${host}/stream/${id}?t=audio`
    });

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});

/* STREAM PROXY */

app.get("/stream/:id", (req, res) => {

  const id = req.params.id;
  const type = req.query.t || "video";

  const source = getCachedUrl(`${id}:${type}`);

  if (!source)
    return res.status(410).json({ error: "expired" });

  const parsed = new URL(source);

  const client = parsed.protocol === "https:" ? https : http;

  const headers = { "User-Agent": "Mozilla/5.0" };

  if (req.headers.range)
    headers.Range = req.headers.range;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + parsed.search,
    headers
  };

  const upstream = client.get(options, yt => {

    res.status(yt.statusCode);

    ["content-type","content-length","content-range","accept-ranges"]
      .forEach(h => {
        if (yt.headers[h]) res.setHeader(h, yt.headers[h]);
      });

    res.setHeader("Access-Control-Allow-Origin","*");

    yt.pipe(res);

  });

  upstream.on("error", () => {
    if (!res.headersSent)
      res.status(500).json({ error: "stream error" });
  });

});

/* HEALTH */

app.get("/", (req,res)=>{
  res.send(`backend alive | cache:${urlCache.size}`);
});

/* START SERVER */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("YT backend running on port", PORT);
});
