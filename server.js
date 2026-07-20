const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const YTDlpWrap = require('yt-dlp-wrap').default;
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

// ── yt-dlp binary path ──────────────────────────────────────────
const YTDLP_BIN = path.join(os.tmpdir(), 'yt-dlp-bin');
let ytDlp = null;
let ytDlpReady = false;

// ── Download yt-dlp binary on startup (pure Node.js) ───────────
async function initYtDlp() {
  try {
    console.log('Downloading yt-dlp binary from GitHub...');
    await YTDlpWrap.downloadFromGithub(YTDLP_BIN);
    
    // Make sure it's executable
    fs.chmodSync(YTDLP_BIN, 0o755);
    
    ytDlp = new YTDlpWrap(YTDLP_BIN);
    ytDlpReady = true;
    console.log('yt-dlp ready! Binary at:', YTDLP_BIN);
    console.log('Binary exists:', fs.existsSync(YTDLP_BIN));
  } catch (err) {
    console.error('Failed to download yt-dlp:', err.message);
    ytDlpReady = false;
  }
}

// ── YouTube API client ──────────────────────────────────────────
const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

// ── Helper: convert ISO 8601 duration ──────────────────────────
function formatDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '';
  const h = match[1] ? `${match[1]}:` : '';
  const m = match[2] ? match[2].padStart(h ? 2 : 1, '0') : '0';
  const s = (match[3] || '0').padStart(2, '0');
  return `${h}${m}:${s}`;
}

// ── GET /search?q=... ───────────────────────────────────────────
app.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query is required' });

  try {
    const searchRes = await youtube.search.list({
      part: ['snippet'],
      q,
      type: ['video'],
      maxResults: 10,
    });

    const items = searchRes.data.items;
    if (!items || items.length === 0) return res.json({ results: [] });

    const videoIds = items.map((item) => item.id.videoId);

    const detailsRes = await youtube.videos.list({
      part: ['contentDetails', 'snippet'],
      id: videoIds,
    });

    const results = detailsRes.data.items.map((item) => ({
      videoId: item.id,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail:
        item.snippet.thumbnails.medium?.url ||
        item.snippet.thumbnails.default?.url,
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
    if (!exists || !ytDlpReady) {
      return res.status(500).json({
        ok: false,
        ready: ytDlpReady,
        exists,
        binary: YTDLP_BIN,
        message: 'yt-dlp not ready yet'
      });
    }
    const version = await ytDlp.execPromise(['--version']);
    res.json({ ok: true, binary: YTDLP_BIN, exists, version: version.trim() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /download  body: { videoId } ──────────────────────────
app.post('/download', async (req, res) => {
  if (!ytDlpReady) {
    return res.status(503).json({
      error: 'Downloader not ready yet. Please wait 30 seconds and try again.'
    });
  }

  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`Getting info for: ${url}`);

  try {
    // Get video info as JSON
    const infoJson = await ytDlp.execPromise([
      url,
      '--dump-single-json',
      '--no-playlist',
      '--no-check-certificates',
      '-f', 'best[height<=720][ext=mp4]/best[ext=mp4]/best[height<=720]/best',
    ]);

    const info = JSON.parse(infoJson);
    const directUrl = info.url;

    if (!directUrl) throw new Error('No direct URL in video info');
    console.log(`Got URL for: ${info.title} | format: ${info.ext}`);

    const protocol = directUrl.startsWith('https') ? https : http;

    const videoReq = protocol.get(
      directUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://www.youtube.com/',
          Origin: 'https://www.youtube.com',
        },
      },
      (videoRes) => {
        console.log(`Streaming video - HTTP ${videoRes.statusCode}`);
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
      }
    );

    videoReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      if (!res.headersSent)
        res.status(500).json({ error: 'Proxy failed', details: err.message });
    });

  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed', details: err.message });
    }
  }
});

// ── Health check ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ytDlpReady,
    ytDlpExists: fs.existsSync(YTDLP_BIN),
  });
});

// ── Start server then init yt-dlp ───────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VideoFetch running on port ${PORT}`);
  // Init yt-dlp AFTER server starts so Railway health checks pass
  setTimeout(() => initYtDlp(), 1000);
});
