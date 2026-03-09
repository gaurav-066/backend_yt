const express = require("express");
const cors    = require("cors");
const { exec, execSync } = require("child_process");
const fs      = require("fs");

const app = express();
app.use(cors());

const PORT      = process.env.PORT || 3000;
const COOKIE_FILE = "/tmp/cookies.txt";

// ── COOKIES ──────────────────────────────────────────────────────────────────
let cookieArg = "";
if (process.env.YT_COOKIES) {
  try {
    fs.writeFileSync(COOKIE_FILE, process.env.YT_COOKIES.replace(/\\n/g, "\n"));
    cookieArg = `--cookies ${COOKIE_FILE}`;
    console.log("Cookies loaded.");
  } catch (e) {
    console.warn("Cookie write failed:", e.message);
  }
} else {
  console.log("No YT_COOKIES env var.");
}

// ── CONCURRENCY ──────────────────────────────────────────────────────────────
let active = 0;
const MAX_CONCURRENT = 2;

// ── RUN HELPER ───────────────────────────────────────────────────────────────
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 50000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // If stdout has JSON, use it even if there were warnings (non-zero exit)
      if (stdout && stdout.includes("{")) return resolve(stdout.trim());
      if (err) return reject(new Error((stderr || err.message).split("\n")[0]));
      if (!stdout || !stdout.trim()) return reject(new Error("Empty output from yt-dlp"));
      resolve(stdout.trim());
    });
  });
}

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", active, max: MAX_CONCURRENT });
});

// ── /resolve — main endpoint ─────────────────────────────────────────────────
// Takes a videoId, returns direct audio + video URLs.
// Client streams directly from YouTube — zero bytes through Render.
app.get("/resolve", async (req, res) => {
  const { id } = req.query;

  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id))
    return res.status(400).json({ error: "Invalid or missing videoId" });

  if (active >= MAX_CONCURRENT)
    return res.status(503).json({ error: "Server busy, retry in a few seconds" });

  active++;
  try {
    const ytUrl = `https://youtube.com/watch?v=${id}`;

    // Single yt-dlp call — dump full JSON, no download
    const cmd = [
      "yt-dlp",
      `"${ytUrl}"`,
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      "--no-check-certificates",
      "--no-warnings",
      cookieArg
    ].filter(Boolean).join(" ");

    const raw  = await run(cmd);
    const start = raw.indexOf("{");
    if (start === -1) throw new Error("No JSON in yt-dlp output");
    const info = JSON.parse(raw.slice(start));

    const formats = info.formats || [];

    // ── Pick best audio-only URL ──────────────────────────────────────────
    const audioFormats = formats
      .filter(f =>
        f.url &&
        f.acodec && f.acodec !== "none" &&
        (!f.vcodec || f.vcodec === "none") &&
        !f.url.includes("manifest") &&
        !f.url.includes("m3u8")
      )
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    // fallback: any format with audio
    const audioFallback = formats
      .filter(f =>
        f.url &&
        f.acodec && f.acodec !== "none" &&
        !f.url.includes("manifest") &&
        !f.url.includes("m3u8")
      )
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    const audioUrl = (audioFormats[0] || audioFallback[0])?.url || info.url;
    if (!audioUrl) throw new Error("No audio URL found");

    // ── Pick best video URL (≤480p H.264) ────────────────────────────────
    const combined = formats.filter(f =>
      f.url &&
      f.acodec && f.acodec !== "none" &&
      f.vcodec && f.vcodec !== "none" &&
      (f.height || 999) <= 480 &&
      !f.url.includes("manifest") &&
      !f.url.includes("m3u8")
    );

    const h264 = combined
      .filter(f => (f.vcodec || "").includes("avc"))
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const anyVideo = combined.sort((a, b) => (b.height || 0) - (a.height || 0));

    const videoUrl = (h264[0] || anyVideo[0])?.url || info.url;

    res.json({
      videoId:   info.id,
      title:     info.title    || "",
      artist:    info.channel  || info.uploader || "",
      duration:  info.duration || 0,
      thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      audioUrl,
      videoUrl
    });

  } catch (e) {
    console.error("/resolve error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    active--;
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
