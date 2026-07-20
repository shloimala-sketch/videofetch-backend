const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const ytdl = require('@distube/ytdl-core');

const app = express();
app.use(cors());
app.use(express.json());

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
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`Downloading: ${url}`);

  try {
    // Validate video is accessible
    if (!ytdl.validateID(videoId)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    // Get video info to find best format
    const info = await ytdl.getInfo(url);
    console.log(`Video title: ${info.videoDetails.title}`);

    // Pick best mp4 format up to 720p
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highestvideo',
      filter: (f) =>
        f.container === 'mp4' &&
        f.hasVideo &&
        f.hasAudio &&
        (f.height || 0) <= 720,
    });

    if (!format) {
      // Fallback — just get any mp4 with audio+video
      const fallback = ytdl.chooseFormat(info.formats, {
        filter: 'audioandvideo',
      });

      if (!fallback) {
        return res.status(500).json({ error: 'No suitable video format found' });
      }

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);
      return ytdl(url, { format: fallback }).pipe(res);
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);

    const stream = ytdl(url, { format });
    stream.pipe(res);

    stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
    });

  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed', details: err.message });
    }
  }
});

// ── Health check ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VideoFetch backend running on port ${PORT}`);
});
