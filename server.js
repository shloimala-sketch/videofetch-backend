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

// Increase timeout for large video downloads
app.use((req, res, next) => {
  res.setTimeout(300000); // 5 minutes
  next();
});

// ── yt-dlp binary ───────────────────────────────────────────────
const YTDLP_BIN = path.join(os.tmpdir(), 'yt-dlp-linux');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
let ytDlpReady = false;

// ── Cookie file ─────────────────────────────────────────────────
const COOKIE_FILE = path.join(os.tmpdir(), 'yt-cookies.txt');

function writeCookies() {
  const cookies = process.env.YOUTUBE_COOKIES;
  if (cookies) {
    fs.writeFileSync(COOKIE_FILE, cookies, 'utf8');
    console.log('Cookies written');
  }
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const makeRequest = (reqUrl) => {
      https.get(reqUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          return makeRequest(response.headers.location);
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
    };
    makeRequest(url);
  });
}

async function initYtDlp() {
  try {
    console.log('Downloading yt-dlp_linux binary...');
    await downloadFile(YTDLP_URL, YTDLP_BIN);
    fs.chmodSync(YTDLP_BIN, 0o755);
    ytDlpReady = true;
    writeCookies();
    console.log('yt-dlp ready! Size:', fs.statSync(YTDLP_BIN).size);
  } catch (err) {
    console.error('Failed to init yt-dlp:', err.message);
  }
}

// Run yt-dlp and return stdout
function runYtDlp(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const baseArgs = fs.existsSync(COOKIE_FILE)
      ? ['--cookies', COOKIE_FILE, ...args]
      : args;

    console.log('yt-dlp args:', baseArgs.join(' '));
    const proc = spawn(YTDLP_BIN, baseArgs);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('yt-dlp timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      console.log('yt-dlp stderr:', d.toString().trim());
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ── YouTube API ─────────────────────────────────────────────────
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

// ── GET /search ───────────────────────────────────────────────── app.get('/search', async (req, res) => {
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
    if (!exists) return res.status(500).json({ ok: false, ready: ytDlpReady, exists });
    const version = await runYtDlp(['--version'], 10000);
    res.json({ ok: true, ready: ytDlpReady, exists, version: version.trim(), hasCookies: fs.existsSync(COOKIE_FILE) });
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
  const tmpFile = path.join(os.tmpdir(), `vf_${videoId}_${Date.now()}.mp4`);

  console.log(`Downloading to temp file: ${tmpFile}`);

  try {
    // Download directly to file (most reliable approach)
    await runYtDlp([
      url,
      '--no-playlist',
      '--no-check-certificates',
      '--extractor-args', 'youtube:player_client=android',
      '-f', 'best[height<=480][ext=mp4]/best[ext=mp4]/best[height<=480]/best',
      '--merge-output-format', 'mp4',
      '-o', tmpFile,
    ], 240000); // 4 min timeout

    if (!fs.existsSync(tmpFile)) {
      // yt-dlp might have added extension
      const altFile = tmpFile.replace('.mp4', '') + '.mp4';
      if (!fs.existsSync(altFile)) throw new Error('Downloaded file not found');
    }

    const stat = fs.statSync(tmpFile);
    console.log(`Download complete! File size: ${stat.size} bytes`);

    // Send file to client
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);

    stream.on('end', () => {
      console.log('File sent successfully');
      fs.unlink(tmpFile, () => {});
    });

    stream.on('error', (err) => {
      console.error('File stream error:', err.message);
      fs.unlink(tmpFile, () => {});
      if (!res.headersSent) res.status(500).json({ error: 'File stream failed' });
    });

  } catch (err) {
    console.error('Download error:', err.message);
    fs.unlink(tmpFile, () => {});
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed', details: err.message });
    }
  }
});

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', ytDlpReady, hasCookies: fs.existsSync(COOKIE_FILE)
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VideoFetch running on port ${PORT}`);
  setTimeout(() => initYtDlp(), 500);
});
