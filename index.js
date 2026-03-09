const express = require("express");
const cors    = require("cors");
const { exec } = require("child_process");
const fs      = require("fs");

const app = express();
app.use(cors());

const PORT        = process.env.PORT || 3000;
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
    exec(cmd, { timeout: 50000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || "").trim();
      if (out) return resolve(out);
      const errMsg = (stderr || err?.message || "Empty output");
      reject(new Error(errMsg.split("\n").find(l => l.includes("ERROR")) || errMsg));
    });
  });
}

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", active, max: MAX_CONCURRENT });
});

// ── /resolve ─────────────────────────────────────────────────────────────────
app.get("/resolve", async (req, res) => {
  const { id } = req.query;

  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id))
    return res.status(400).json({ error: "Invalid or missing videoId" });

  if (active >= MAX_CONCURRENT)
    return res.status(503).json({ error: "Server busy, retry in a few seconds" });

  active++;
  const ytUrl = `https://youtube.com/watch?v=${id}`;

  // Base args — NO explicit -f flag, let yt-dlp pick whatever YouTube serves
  const base = `yt-dlp "${ytUrl}" --no-playlist --no-warnings --no-check-certificates ${cookieArg}`;

  try {
    // Single call, get best available URL — no format restrictions
    const audioUrl = await run(`${base} -f "bestaudio" -g`);

    // For video try low res, fallback to same as audio
    let videoUrl = audioUrl;
    try {
      videoUrl = await run(`${base} -f "worstvideo+worstaudio/worst" -g`);
    } catch (_) {
      // fine, just use audio url for video too
    }

    res.json({
      videoId:   id,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      audioUrl:  audioUrl.split("\n")[0],
      videoUrl:  videoUrl.split("\n")[0]
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
