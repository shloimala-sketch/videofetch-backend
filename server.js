const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const YTDlpWrap = require('yt-dlp-wrap').default;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

// ── Find yt-dlp binary ──────────────────────────────────────────
function findYtDlp() {
  const locations = [
    'yt-dlp',
    '/usr/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/nix/store',
  ];

  // Try to find via which command
  try {
    const result = execSync('which yt-dlp').toString().trim();
    if (result) {
      console.log('Found yt-dlp at:', result);
      return result;
    }
  } catch (e) {}

  // Try known locations
  for (const loc of locations) {
    try {
      if (fs.existsSync(loc)) {
        console.log('Found yt-dlp at:', loc);
        return loc;
      }
    } catch (e) {}
  }

  console.log('Using default yt-dlp from PATH');
  return 'yt-dlp';
}

const ytDlpPath = findYtDlp();
const ytDlp = new YTDlpWrap(ytDlpPath);

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

  const tmpFile = path.join(os.tmpdir(), `${videoId}_${Date.now()}.mp4`);

  console.log(`Starting download for videoId: ${videoId}`);
  console.log(`Using yt-dlp at: ${ytDlpPath}`);
  console.log(`Output file: ${tmpFile}`);

  try {
    // Use single-file format — no merging needed, no ffmpeg required
    await ytDlp.execPromise([
      `https://www.youtube.com/watch?v=${videoId}`,
      '-f', 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
      '--no-playlist',
      '--no-check-certificate',
      '-o', tmpFile,
    ]);

    console.log(`Download complete, file exists: ${fs.existsSync(tmpFile)}`);

    if (!fs.existsSync(tmpFile)) {
      throw new Error('Downloaded file not found');
    }

    const stat = fs.statSync(tmpFile);
    console.log(`File size: ${stat.size} bytes`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);

    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);

    stream.on('end', () => {
      console.log('Stream complete, deleting temp file');
      fs.unlink(tmpFile, () => {});
    });

    stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      fs.unlink(tmpFile, () => {});
      if (!res.headersSent) res.status(500).end();
    });

  } catch (err) {
    console.error('Download error:', err.message);
    console.error('Full error:', err);
    fs.unlink(tmpFile, () => {});
    res.status(500).json({ error: 'Download failed', details: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VideoFetch backend running on port ${PORT}`);
  console.log(`yt-dlp path: ${ytDlpPath}`);
});
