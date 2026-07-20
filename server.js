const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

// ── yt-dlp is pre-installed in Docker at /usr/local/bin/yt-dlp ──
const YTDLP_BIN = '/usr/local/bin/yt-dlp';
const COOKIE_FILE = path.join(os.tmpdir(), 'yt-cookies.txt');

// Write cookies from env var if available
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIE_FILE, process.env.YOUTUBE_COOKIES, 'utf8');
  console.log('YouTube cookies written');
} else {
  console.log('No YOUTUBE_COOKIES env var — proceeding without cookies');
}

// ── Run yt-dlp ──────────────────────────────────────────────────
function runYtDlp(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const baseArgs = fs.existsSync(COOKIE_FILE)
      ? ['--cookies', COOKIE_FILE, ...args]
      : args;

    console.log('Running:', YTDLP_BIN, baseArgs.slice(-6).join(' '));
    const proc = spawn(YTDLP_BIN, baseArgs);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('yt-dlp timed out'));
    }, timeoutMs);

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      process.stdout.write('[yt-dlp] ' + d.toString());
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ── YouTube API ─────────────────────────────────────────────────
const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

function formatDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '';
  const h = match[1] ? `${match[1]}:` : '';
  const m = match[2] ? match[2].padStart(h ? 2 : 1, '0') : '0';
  const s = (match[3] || '0').padStart(2, '0');
  return `${h}${m}:${s}`;
}

// ── GET /search ─────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query is required' });
  try {
    const searchRes = await youtube.search.list({
      part: ['snippet'], q, type: ['video'], maxResults: 10,
    });
    const items = searchRes.data.items;
    if (!items?.length) return res.json({ results: [] });
    const videoIds = items.map((i) => i.id.videoId);
    const detailsRes = await youtube.videos.list({
      part: ['contentDetails', 'snippet'], id: videoIds,
    });
    const results = detailsRes.data.items.map((item) => ({
      videoId: item.id,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
      duration: formatDuration(item.contentDetails.duration),
    }));
    res.json({ results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// ── GET /ytdlp-check ────────────────────────────────────────────
app.get('/ytdlp-check', async (req, res) => {
  try {
    const version = await runYtDlp(['--version'], 10000);
    res.json({
      ok: true,
      binary: YTDLP_BIN,
      version: version.trim(),
      hasCookies: fs.existsSync(COOKIE_FILE),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /download ───────────────────────────────────────────────
app.post('/download', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const tmpFile = path.join(os.tmpdir(), `vf_${videoId}_${Date.now()}.mp4`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
   console.log(`Downloading: ${url}`);

  try {
    await runYtDlp([
      url,
      '--no-playlist',
      '--no-check-certificates',
      '--extractor-args', 'youtube:player_client=android',
      '-f', 'best[height<=480][ext=mp4]/best[ext=mp4]/best[height<=480]/best',
      '--merge-output-format', 'mp4',
      '-o', tmpFile,
    ], 240000);

    if (!fs.existsSync(tmpFile)) throw new Error('Output file not found after download');

    const stat = fs.statSync(tmpFile);
    console.log(`File ready: ${stat.size} bytes`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(tmpFile, () => {}));
    stream.on('error', () => {
      fs.unlink(tmpFile, () => {});
      if (!res.headersSent) res.status(500).json({ error: 'File send failed' });
    });

  } catch (err) {
    console.error('Download error:', err.message);
    fs.unlink(tmpFile, () => {});
    if (!res.headersSent) res.status(500).json({ error: 'Download failed', details: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VideoFetch running on port ${PORT}`));
