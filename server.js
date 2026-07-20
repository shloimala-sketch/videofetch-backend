const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

// ── yt-dlp standalone binary  ────────────────────────────────────
const YTDLP_BIN = path.join(os.tmpdir(), 'yt-dlp-linux');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
let ytDlpReady = false;

// ── Cookie file path (written from env var) ─────────────────────
const COOKIE_FILE = path.join(os.tmpdir(), 'yt-cookies.txt');

function writeCookies() {
  const cookies = process.env.YOUTUBE_COOKIES;
  if (cookies) {
    fs.writeFileSync(COOKIE_FILE, cookies, 'utf8');
    console.log('YouTube cookies written to:', COOKIE_FILE);
  } else {
    console.warn('No YOUTUBE_COOKIES env var found - bot detection may block downloads');
  }
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    }).on('error', reject);
  });
}

async function initYtDlp() {
  try {
    console.log('Downloading yt-dlp standalone binary...');
    await downloadFile(YTDLP_URL, YTDLP_BIN);
    fs.chmodSync(YTDLP_BIN, 0o755);
    ytDlpReady = true;
    console.log('yt-dlp ready! Size:', fs.statSync(YTDLP_BIN).size, 'bytes');
    writeCookies();
  } catch (err) {
    console.error('Failed to init yt-dlp:', err.message);
  }
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    // Add cookie file if it exists
    const allArgs = fs.existsSync(COOKIE_FILE)
      ? ['--cookies', COOKIE_FILE, ...args]
      : args;

    console.log('Running yt-dlp with args:', allArgs.join(' '));
    const proc = spawn(YTDLP_BIN, allArgs);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    proc.on('error', reject);
  });
}

// ── YouTube API client ──────────────────────────────────────────
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
    const exists = fs.existsSync(YTDLP_BIN);
    if (!exists) return res.status(500).json({ ok: false, exists, ready: ytDlpReady });
    const version = await runYtDlp(['--version']);
    res.json({
      ok: true, exists, ready: ytDlpReady,
      version: version.trim(),
      hasCookies: fs.existsSync(COOKIE_FILE),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /download ───────────────────────────────────────────────
app.post('/download', async (req, res) => {
  if (!ytDlpReady) {
    return res.status(503).json({ error: 'Downloader not ready, wait 30 seconds and try again.' });
  }

  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`Downloading: ${url}`);

  try {
    const infoJson = await runYtDlp([
      url,
      '--dump-single-json',
      '--no-playlist',
      '--no-check-certificates',
      // Use Android client — no JS runtime needed, less bot detection
      '--extractor-args', 'youtube:player_client=android,web',
      '-f', 'best[height<=720][ext=mp4]/best[ext=mp4]/best[height<=720]/best',
    ]);

    const info = JSON.parse(infoJson);
    const directUrl = info.url;
    if (!directUrl) throw new Error('No direct URL found');

    console.log(`Got URL for: ${info.title} | ${info.ext}`);

    const protocol = directUrl.startsWith('https') ? https : http;
    const videoReq = protocol.get(directUrl, {
      headers: {
        'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
        Referer: 'https://www.youtube.com/',
      },
    }, (videoRes) => {
      console.log(`Video HTTP: ${videoRes.statusCode}`);
      res.setHeader('Content-Type', videoRes.headers['content-type'] || 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);
      if (videoRes.headers['content-length']) {
        res.setHeader('Content-Length', videoRes.headers['content-length']);
      }
      videoRes.pipe(res);
      videoRes.on('error', (err) => {
        if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
      });
    });

    videoReq.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: 'Fetch failed', details: err.message });
    });

  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed', details: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', ytDlpReady,
  hasCookies: fs.existsSync(COOKIE_FILE),
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VideoFetch running on port ${PORT}`);
  setTimeout(() => initYtDlp(), 500);
});
