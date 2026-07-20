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

// ── YouTube API client ──────────────────────────────────────────
const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

const ytDlp = new YTDlpWrap();

// ── Helper: convert ISO 8601 duration to readable format ────────
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
    // Step 1: Search for videos
    const searchRes = await youtube.search.list({
      part: ['snippet'],
      q,
      type: ['video'],
      maxResults: 10,
    });

    const items = searchRes.data.items;
    if (!items || items.length ===  0) return res.json({ results: [] });

    const videoIds = items.map((item) => item.id.videoId);

    // Step 2: Get durations
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
    res.status(500).json({ error: 'Search failed. Check your API key.' });
  }
});

// ── POST /download  body: { videoId } ──────────────────────────
app.post('/download', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const tmpFile = path.join(os.tmpdir(), `${videoId}_${Date.now()}.mp4`);

  try {
    // Download video up to 720p as mp4
    await ytDlp.execPromise([
      `https://www.youtube.com/watch?v=${videoId}`,
      '-f',
      'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '-o', tmpFile,
    ]);

    // Stream the file back to the client
    res.setHeader('Content-Type', 'video/mp4');
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
    res.status(500).json({ error: 'Download failed' });
  }
});

// ── Start server ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VideoFetch backend running on port ${PORT}`));