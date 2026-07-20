const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { create } = require('youtube-dl-exec');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// ── Use locally downloaded yt-dlp binary ────────────────────────
const LOCAL_YTDLP = path.join(__dirname, 'yt-dlp');
let ytDlpBin = LOCAL_YTDLP;

if (fs.existsSync(LOCAL_YTDLP)) {
  console.log('Using local yt-dlp binary:', LOCAL_YTDLP);
} else {
  console.warn('Local yt-dlp not found! Falling back to PATH');
  ytDlpBin = 'yt-dlp';
}

const youtubedl = create(ytDlpBin);

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
app.get('/ytdlp-check', (req, res) => {
  try {
    const version = execSync(`${ytDlpBin} --version`).toString().trim();
    const exists = fs.existsSync(LOCAL_YTDLP);
    res.json({ ok: true, binary: ytDlpBin, version, localFileExists: exists });
  } catch (err) {
    res.status(500).json({ ok: false, binary: ytDlpBin, error: err.message });
  }
});

// ── POST /download  body: { videoId } ──────────────────────────
app.post('/download', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`Getting info for: ${url}`);

  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noCheckCertificates: true,
      format: 'best[height<=720][ext=mp4]/best[ext=mp4]/best[height<=720]/best',
    });

    const directUrl = info.url;
    if (!directUrl) throw new Error('No direct URL in video info');

    console.log(`Got direct URL for: ${info.title}`);

    const protocol = directUrl.startsWith('https') ? https : http;

    const videoReq = protocol.get(
      directUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
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
          console.error('Video response error:', err.message);
          if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
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
  res.json({ status: 'ok', ytDlpBin, localBinaryExists: fs.existsSync(LOCAL_YTDLP) });
});

// ── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VideoFetch backend running on port ${PORT}`);
  console.log(`yt-dlp binary: ${ytDlpBin}`);
  console.log(`Local binary exists: ${fs.existsSync(LOCAL_YTDLP)}`);
});
