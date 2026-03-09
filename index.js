const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

// ── CONFIG ──────────────────────────────────────────────────────────────────
const MAX_CONCURRENT    = 2;
const CACHE_TTL         = 90 * 60 * 1000;   // 90 min (safe margin before YT URLs expire)
const MAX_VIDEO_DURATION = 420;              // 7 min — skip long videos on /video
const COOKIES_FILE      = path.join(__dirname, "cookies.txt");

// ── WRITE COOKIES FROM ENV ──────────────────────────────────────────────────
if (process.env.YT_COOKIES) {
  try {
    // Normalize escaped newlines that env vars often mangle
    fs.writeFileSync(COOKIES_FILE, process.env.YT_COOKIES.replace(/\\n/g, "\n"));
    console.log("Cookies written.");
  } catch (e) {
    console.warn("Cookie write failed:", e.message);
  }
} else {
  console.log("No YT_COOKIES env var — running without cookies.");
}

// ── VERIFY yt-dlp ───────────────────────────────────────────────────────────
execFile("yt-dlp", ["--version"], { timeout: 5000 }, (err, stdout) => {
  if (err) console.error("yt-dlp NOT found:", err.message);
  else     console.log("yt-dlp:", stdout.trim());
});

// ── CACHE ───────────────────────────────────────────────────────────────────
// Key: "<videoId>:audio" or "<videoId>:video"
const urlCache = new Map();

function cacheSet(key, url) {
  urlCache.set(key, { url, ts: Date.now() });
  if (urlCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of urlCache)
      if (now - v.ts > CACHE_TTL) urlCache.delete(k);
  }
}

function cacheGet(key) {
  const entry = urlCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { urlCache.delete(key); return null; }
  return entry.url;
}

// ── CONCURRENCY ─────────────────────────────────────────────────────────────
let active = 0;

// ── yt-dlp WRAPPER ──────────────────────────────────────────────────────────
function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const cookieArgs = fs.existsSync(COOKIES_FILE)
      ? ["--cookies", COOKIES_FILE]
      : [];

    const fullArgs = [
      ...cookieArgs,
      "--no-warnings",
      "--no-check-certificates",
      "--no-playlist",
      "-j",            // dump JSON, no download
      ...args
    ];

    console.log("[yt-dlp]", args.join(" "));

    execFile("yt-dlp", fullArgs, {
      timeout:   45000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: "1" }
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").split("\n")
          .find(l => l.includes("ERROR") || l.trim()) || err.message;
        console.error("[yt-dlp] Error:", msg);
        return reject(new Error(msg));
      }

      // Find the JSON object — sometimes yt-dlp prepends garbage lines
      const start = stdout.indexOf("{");
      if (start === -1) return reject(new Error("yt-dlp returned no JSON"));

      try {
        resolve(JSON.parse(stdout.slice(start)));
      } catch (e) {
        reject(new Error("yt-dlp JSON parse failed: " + e.message));
      }
    });
  });
}

// ── PICK AUDIO URL ──────────────────────────────────────────────────────────
// Returns the best direct audio URL from yt-dlp format list.
function pickAudio(info) {
  const formats = info.formats || [];

  // 1. Audio-only formats, sorted best quality first
  const audioOnly = formats
    .filter(f =>
      f.url &&
      f.acodec && f.acodec !== "none" &&
      (!f.vcodec || f.vcodec === "none") &&
      !f.url.includes("manifest") &&
      !f.url.includes("m3u8")
    )
    .sort((a, b) => (b.abr || 0) - (a.abr || 0));

  if (audioOnly.length) return audioOnly[0].url;

  // 2. Any format with audio (combined), best bitrate first
  const withAudio = formats
    .filter(f =>
      f.url &&
      f.acodec && f.acodec !== "none" &&
      !f.url.includes("manifest") &&
      !f.url.includes("m3u8")
    )
    .sort((a, b) => (b.abr || 0) - (a.abr || 0));

  if (withAudio.length) return withAudio[0].url;

  // 3. Top-level fallback
  return info.url || null;
}

// ── PICK VIDEO URL ──────────────────────────────────────────────────────────
// Returns a combined video+audio direct URL ≤480p (preferring H.264).
function pickVideo(info) {
  const formats = info.formats || [];

  const combined = formats.filter(f =>
    f.url &&
    f.acodec && f.acodec !== "none" &&
    f.vcodec && f.vcodec !== "none" &&
    (f.height || 999) <= 480 &&
    !f.url.includes("manifest") &&
    !f.url.includes("m3u8")
  );

  // Prefer H.264 (avc) for widest device compatibility
  const h264 = combined
    .filter(f => (f.vcodec || "").includes("avc"))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (h264.length) return h264[0].url;

  // Any combined ≤480p
  const any480 = combined.sort((a, b) => (b.height || 0) - (a.height || 0));
  if (any480.length) return any480[0].url;

  // Last resort
  return info.url || null;
}

// ── RETRY HELPER ─────────────────────────────────────────────────────────────
// Retries fn up to `attempts` times with exponential backoff.
async function withRetry(fn, attempts = 3, delayMs = 1500) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === attempts - 1) throw e;
      console.warn(`[retry] Attempt ${i + 1} failed: ${e.message} — retrying in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
}

// ── /play — Search + return audio stream ─────────────────────────────────────
app.get("/play", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Query required" });
  if (active >= MAX_CONCURRENT) return res.status(503).json({ error: "Server busy, retry in a few seconds" });

  active++;
  try {
    const info = await withRetry(() => ytdlp([`ytsearch1:${query}`]));
    const streamUrl = pickAudio(info);
    if (!streamUrl) throw new Error("No audio stream found");

    const cacheKey = `${info.id}:audio`;
    cacheSet(cacheKey, streamUrl);

    const host = `https://${req.get("host")}`;
    res.json({
      videoId:   info.id,
      title:     info.title     || query,
      artist:    info.channel   || info.uploader || "",
      duration:  info.duration  || 0,
      thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
      url:       `${host}/stream/${info.id}?t=audio`
    });
  } catch (e) {
    console.error("/play error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    active--;
  }
});

// ── /video — Search + return video stream ────────────────────────────────────
app.get("/video", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Query required" });
  if (active >= MAX_CONCURRENT) return res.status(503).json({ error: "Server busy, retry in a few seconds" });

  active++;
  try {
    const info = await withRetry(() => ytdlp([`ytsearch1:${query}`]));

    // Skip videos that are too long
    if (info.duration && info.duration > MAX_VIDEO_DURATION) {
      console.log(`[/video] Skipping "${info.title}" — too long (${info.duration}s)`);
      return res.status(204).end();
    }

    const streamUrl = pickVideo(info);
    if (!streamUrl) throw new Error("No video stream found");

    const cacheKey = `${info.id}:video`;
    cacheSet(cacheKey, streamUrl);

    const host = `https://${req.get("host")}`;
    res.json({
      videoId:  info.id,
      title:    info.title    || query,
      duration: info.duration || 0,
      url:      `${host}/stream/${info.id}?t=video`
    });
  } catch (e) {
    console.error("/video error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    active--;
  }
});

// ── /stream/:videoId — Pipe proxy ────────────────────────────────────────────
// Fetches from googlevideo.com using Render's IP (same one that extracted
// the signed URL) and pipes bytes straight to the browser.
// Supports Range headers so seeking works.
app.get("/stream/:videoId", (req, res) => {
  const { videoId } = req.params;
  const type = req.query.t || "audio";
  const cacheKey = `${videoId}:${type}`;

  const sourceUrl = cacheGet(cacheKey);
  if (!sourceUrl) {
    return res.status(410).json({ error: "Stream expired — search again" });
  }

  try {
    const parsed = new URL(sourceUrl);
    const client = parsed.protocol === "https:" ? https : http;

    const upstreamHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
    };
    if (req.headers.range) upstreamHeaders["Range"] = req.headers.range;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers:  upstreamHeaders
    };

    const upstream = client.get(options, (ytRes) => {
      res.status(ytRes.statusCode);
      ["content-type", "content-length", "content-range", "accept-ranges"].forEach(h => {
        if (ytRes.headers[h]) res.setHeader(h, ytRes.headers[h]);
      });
      res.setHeader("Access-Control-Allow-Origin", "*");
      ytRes.pipe(res);
      ytRes.on("error", () => { try { res.end(); } catch (_) {} });
    });

    upstream.on("error", (e) => {
      console.error(`[stream] Upstream error (${cacheKey}):`, e.message);
      if (!res.headersSent) res.status(502).json({ error: "Stream failed — try again" });
    });

    res.on("close", () => { try { upstream.destroy(); } catch (_) {} });

  } catch (e) {
    console.error("[stream] Error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Internal stream error" });
  }
});

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const cookies = fs.existsSync(COOKIES_FILE) ? "yes" : "no";
  res.send(`VYBZZ Backend | cookies=${cookies} | cached=${urlCache.size} | active=${active}/${MAX_CONCURRENT}`);
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
