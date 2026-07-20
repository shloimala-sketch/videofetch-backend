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

// ── ytdl agent with spoofed headers ────────────────────────────
const agent = ytdl.createProxyAgent(
  { uri: '' },
  {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  }
);

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
  console.log(`Downloading: ${url}`);

  try {
    if (!ytdl.validateID(videoId)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    // Get info using Android client to avoid IP blocks
    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'User-Agent':
            'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
        },
      },
    });

    console.log(`Got info for: ${info.videoDetails.title}`);
    console.log(`Available formats: ${info.formats.length}`);

    // Log available formats for debugging
    const mp4Formats = info.formats.filter(
      (f) => f.hasVideo && f.hasAudio && f.container === 'mp4'
    );
    console.log(`MP4 combined formats: ${mp4Formats.length}`);
    mp4Formats.forEach((f) =>
      console.log(`  ${f.qualityLabel} - ${f.container} - ${f.codecs}`)
    );

    // Try to get best combined mp4 format (has both audio and video)
    let format = ytdl.chooseFormat(info.formats, {
      filter: (f) => f.hasVideo && f.hasAudio && f.container === 'mp4',
      quality: 'highest',
    });

    // Fallback 1: any format with audio and video
    if (!format) {
      console.log('No combined mp4, trying any audioandvideo format...');
      format = ytdl.chooseFormat(info.formats, {
        filter: 'audioandvideo',
      });
    }

    // Fallback 2: lowest quality anything
    if (!format) {
      console.log('Trying lowest quality fallback...');
      format = ytdl.chooseFormat(info.formats, { quality: 'lowest' });
    }

    if (!format) {
      console.error('No format found at all');
      return res.status(500).json({ error: 'No playable format found for this video' });
    }

    console.log(`Using format: ${format.qualityLabel} - ${format.container} - ${format.mimeType}`);

    res.setHeader('Content-Type', format.mimeType?.split(';')[0] || 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);
    if (format.contentLength) {
      res.setHeader('Content-Length', format.contentLength);
    }

    const stream = ytdl(url, {
      format,
      requestOptions: {
        headers: {
          'User-Agent':
            'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
        },
      },
    });

    stream.on('progress', (_, downloaded, total) => {
      const pct = total ? ((downloaded / total) * 100).toFixed(1) : '?';
      console.log(`Progress: ${pct}%`);
    });

    stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed', details: err.message });
    });

    stream.pipe(res);

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
