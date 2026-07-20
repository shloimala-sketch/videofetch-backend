const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const YTDlpWrap = require('yt-dlp-wrap').default;
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

// ── yt-dlp binary path (downloaded on startup) ──────────────────
const YTDLP_PATH = path.join(os.tmpdir(), 'yt-dlp');
let ytDlp = null;

async function initYtDlp() {
  try {
    // Download yt-dlp binary from GitHub if not already present
    console.log('Downloading yt-dlp binary...');
    await YTDlpWrap.downloadFromGithub(YTDLP_PATH);
    fs.chmodSync(YTDLP_PATH, '755'); // make it executable
    ytDlp = new YTDlpWrap(YTDLP_PATH);
    console.log('yt-dlp ready at:', YTDLP_PATH);
  } catch (err) {
    console.error('Failed to initialize yt-dlp:', err.message);
  }
}

// ── YouTube API client ────────────────────────────────────────── const youtube = google.youtube({
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
      thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
      duration: formatDuration(item.contentDetails.duration),
    }));

    res.json({ results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// ── POST /download  body: { videoId } ──────────────────────────
app.post('/download', async (req, res) => {
  if (!ytDlp) {
    return res.status(503).json({ error: 'Downloader not ready yet, please wait a moment and try again.' });
  }

  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const tmpFile = path.join(os.tmpdir(), `${videoId}_${Date.now()}.mp4`);
  console.log(`Downloading videoId: ${videoId}`);

  try {
    await ytDlp.execPromise([
      `https://www.youtube.com/watch?v=${videoId}`,
      '-f', 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
      '--no-playlist',
      '--no-check-certificate',
      '-o', tmpFile,
    ]);

    if (!fs.existsSync(tmpFile)) throw new Error('Downloaded file not found');

    const stat = fs.statSync(tmpFile);
    console.log(`File ready: ${stat.size} bytes`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);

    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(tmpFile, () => {}));
    stream.on('error', () => {
      fs.unlink(tmpFile, () => {});
      if (!res.headersSent) res.status(500).end();
    });

  } catch (err) {
    console.error('Download error:', err.message);
    fs.unlink(tmpFile, () => {});
    res.status(500).json({ error: 'Download failed', details: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initYtDlp(); // download yt-dlp binary on startup
});
