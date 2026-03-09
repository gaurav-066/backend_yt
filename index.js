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
      reject(new Error((stderr || err?.message || "Empty output").split("\n").find(l => l.includes("ERROR")) || (stderr || err?.message || "Empty output")));
    });
  });
}

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", active, max: MAX_CONCURRENT });
});

// ── /resolve ─────────────────────────────────────────────────────────────────
// Takes videoId, returns audioUrl + videoUrl.
// Uses -g flag (URL only) — much lighter than --dump-single-json.
// Two parallel calls so it's fast.
app.get("/resolve", async (req, res) => {
  const { id } = req.query;

  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id))
    return res.status(400).json({ error: "Invalid or missing videoId" });

  if (active >= MAX_CONCURRENT)
    return res.status(503).json({ error: "Server busy, retry in a few seconds" });

  active++;
  const ytUrl = `https://youtube.com/watch?v=${id}`;

  const base = [
    "yt-dlp",
    `"${ytUrl}"`,
    "--no-playlist",
    "--no-warnings",
    "--no-check-certificates",
    "-g",            // just print the URL, nothing else
    cookieArg
  ].filter(Boolean).join(" ");

  try {
    // Run audio + video resolution in parallel
    const [audioUrl, videoUrl] = await Promise.all([
      run(`${base} -f "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best"`),
      run(`${base} -f "best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best"`)
    ]);

    res.json({
      videoId:   id,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      audioUrl:  audioUrl.split("\n")[0],  // -g can return multiple lines, take first
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
