const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const youtubedl = require('youtube-dl-exec');
const https = require('https');
const http = require('http');

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

// ── POST /download  body: { videoId } ──────────────────────────
app.post('/download', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`Getting info for: ${url}`);

  try {
    // Use yt-dlp to get video info + direct URL (no HTML scraping)
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noCheckCertificates: true,
      format: 'best[height<=720][ext=mp4]/best[ext=mp4]/best[height<=720]/best',
    });

    const directUrl = info.url;
    if (!directUrl) throw new Error('No direct URL found in video info');

    console.log(`Got direct URL for: ${info.title}`);
    console.log(`Format: ${info.format} - ${info.ext}`);

    // Proxy the video through our server to the client
    const protocol = directUrl.startsWith('https') ? https : http;

    const videoReq = protocol.get(
      directUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://www.youtube.com/',
          Origin: 'https://www.youtube.com',
        },
      },
      (videoRes) => {
        console.log(`Proxying video - status: ${videoRes.statusCode}`);

        const contentType = videoRes.headers['content-type'] || 'video/mp4';
        res.setHeader('Content-Type', contentType);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${videoId}.mp4"`
        );
        if (videoRes.headers['content-length']) {
          res.setHeader('Content-Length', videoRes.headers['content-length']);
        }

        videoRes.pipe(res);

        videoRes.on('error', (err) => {
          console.error('Video response error:', err.message);
          if (!res.headersSent) res.status(500).json({ error: 'Proxy stream failed' });
        });
      }
    );

    videoReq.on('error', (err) => {
      console.error('Proxy request error:', err.message);
      if (!res.headersSent)
        res.status(500).json({ error: 'Failed to fetch video', details: err.message });
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
