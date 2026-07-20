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

//  ── Standalone yt-dlp Linux binary (NO Python needed) ───────────
const YTDLP_BIN = path.join(os.tmpdir(), 'yt-dlp-linux');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
let ytDlpReady = false;

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      // Handle redirects
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
      file.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

async function initYtDlp() {
  try {
    console.log('Downloading yt-dlp standalone Linux binary...');
    await downloadFile(YTDLP_URL, YTDLP_BIN);
    fs.chmodSync(YTDLP_BIN, 0o755);
    console.log('yt-dlp binary ready at:', YTDLP_BIN);
    console.log('File size:', fs.statSync(YTDLP_BIN).size, 'bytes');
    ytDlpReady = true;
  } catch (err) {
    console.error('Failed to download yt-dlp:', err.message);
  }
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args);
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
    if (!exists) return res.status(500).json({ ok: false, exists, ready: ytDlpReady, binary: YTDLP_BIN });
    const version = await runYtDlp(['--version']);
    res.json({ ok: true, exists, ready: ytDlpReady, binary: YTDLP_BIN, version: version.trim() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, binary: YTDLP_BIN });
  }
});

// ── POST /download ───────────────────────────────────────────────
app.post('/download', async (req, res) => {
  if (!ytDlpReady) {
    return res.status(503).json({ error: 'Downloader not ready yet, wait 30 seconds and try again.' });
  }
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`Getting info for: ${url}`);

  try {
    const infoJson = await runYtDlp([
      url,
      '--dump-single-json',
      '--no-playlist',
      '--no-check-certificates',
      '-f', 'best[height<=720][ext=mp4]/best[ext=mp4]/best[height<=720]/best',
    ]);

    const info = JSON.parse(infoJson);
    const directUrl = info.url;
    if (!directUrl) throw new Error('No direct URL found');

    console.log(`Streaming: ${info.title} | ${info.ext} | ${info.format}`);

    const protocol = directUrl.startsWith('https') ? https : http;
    const videoReq = protocol.get(directUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://www.youtube.com/',
        Origin: 'https://www.youtube.com',
      },
    }, (videoRes) => {
      console.log(`Video HTTP status: ${videoRes.statusCode}`);
      res.setHeader('Content-Type', videoRes.headers['content-type'] || 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);
      if (videoRes.headers['content-length']) {
        res.setHeader('Content-Length', videoRes.headers['content-length']);
      }
      videoRes.pipe(res);
      videoRes.on('error', (err) => {
        console.error('Stream error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
      });
    });

    videoReq.on('error', (err) => {
      console.error('Request error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Fetch failed', details: err.message });
    });

  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed', details: err.message });
  }
});

// ── Health ───────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', ytDlpReady, ytDlpExists: fs.existsSync(YTDLP_BIN)
}));

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VideoFetch running on port ${PORT}`);
  setTimeout(() => initYtDlp(), 500);
});
