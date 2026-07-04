const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const OBSWebSocket = require('obs-websocket-js').default;
require('dotenv').config();

const app = express();
const PORT = parseInt(process.env.PORT || '4600', 10);
const OBS_HOST = process.env.OBS_WS_HOST || '127.0.0.1';
const OBS_PORT = parseInt(process.env.OBS_WS_PORT || '4455', 10);
const OBS_PASSWORD = process.env.OBS_WS_PASSWORD || '';
const SKIP_DRIVES = ['C', 'D'];
const VIDEO_EXTENSIONS = ['.mp4'];

// ---------------------------------------------------------------------------
// OBS WebSocket Client
// ---------------------------------------------------------------------------
const obs = new OBSWebSocket();
let obsConnected = false;
let obsScenes = [];
let obsActiveScene = '';
let obsReconnectTimer = null;

async function connectOBS() {
  if (obsConnected) return;
  try {
    await obs.connect(`ws://${OBS_HOST}:${OBS_PORT}`, OBS_PASSWORD);
    obsConnected = true;
    console.log(`[OBS] Conectado em ${OBS_HOST}:${OBS_PORT}`);

    const { scenes } = await obs.call('GetSceneList');
    obsScenes = scenes.map(s => s.sceneName);
    obsActiveScene = scenes.find(s => s.sceneIndex === scenes.length - 1)?.sceneName || '';

    await refreshActiveScene();
  } catch (err) {
    obsConnected = false;
    console.log(`[OBS] Falha ao conectar: ${err.message}. Tentando novamente em 5s...`);
    scheduleOBSReconnect();
  }
}

async function refreshActiveScene() {
  try {
    const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
    obsActiveScene = currentProgramSceneName || '';
  } catch {
    // ignored
  }
}

function scheduleOBSReconnect() {
  if (obsReconnectTimer) clearTimeout(obsReconnectTimer);
  obsReconnectTimer = setTimeout(connectOBS, 5000);
}

obs.on('ConnectionClosed', () => {
  obsConnected = false;
  console.log('[OBS] Conexão perdida. Reconectando em 5s...');
  scheduleOBSReconnect();
});

obs.on('CurrentProgramSceneChanged', (data) => {
  obsActiveScene = data.sceneName;
});

obs.on('SceneListChanged', async () => {
  try {
    const { scenes } = await obs.call('GetSceneList');
    obsScenes = scenes.map(s => s.sceneName);
  } catch {
    // ignored
  }
});

// ---------------------------------------------------------------------------
// Drive Scanning
// ---------------------------------------------------------------------------
function getAvailableDrives() {
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Name"',
      { encoding: 'utf8', timeout: 5000 }
    );
    const drives = output.split('\n')
      .map(line => line.trim())
      .filter(line => /^[A-Za-z]$/.test(line))
      .map(line => line.toUpperCase());
    return drives.filter(d => !SKIP_DRIVES.includes(d));
  } catch {
    return [];
  }
}

function scanDrive(driveLetter) {
  const root = `${driveLetter}:\\`;
  const maria = [];
  const random = [];

  try {
    const files = fs.readdirSync(root);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!VIDEO_EXTENSIONS.includes(ext)) continue;
      const fullPath = path.join(root, file);
      if (fs.statSync(fullPath).isFile() && file.toUpperCase().includes('MARIA')) {
        maria.push(fullPath);
      }
    }
  } catch {
    return { maria: [], random: [] };
  }

  const videosFolder = path.join(root, 'VIDEOS');
  const videosFolderLower = path.join(root, 'videos');
  const target = fs.existsSync(videosFolder) ? videosFolder
    : fs.existsSync(videosFolderLower) ? videosFolderLower
    : null;

  if (target) {
    try {
      const files = fs.readdirSync(target);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (!VIDEO_EXTENSIONS.includes(ext)) continue;
        const fullPath = path.join(target, file);
        if (fs.statSync(fullPath).isFile()) {
          random.push(fullPath);
        }
      }
    } catch {
      // ignored
    }
  }

  return { maria, random };
}

function scanAllDrives() {
  const drives = getAvailableDrives();
  for (const drive of drives) {
    const result = scanDrive(drive);
    if (result.maria.length > 0) {
      return { status: 'found', drive: `${drive}:`, maria: result.maria, random: result.random };
    }
  }
  return { status: 'waiting', maria: [], random: [], drive: '' };
}

// ---------------------------------------------------------------------------
// MIME type helper
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Express Middleware
// ---------------------------------------------------------------------------
app.use(express.json());

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// Scan drives
app.get('/api/scan', (req, res) => {
  const result = scanAllDrives();
  res.json(result);
});

// Video streaming with range requests
app.get('/api/video', (req, res) => {
  const videoPath = req.query.path;

  if (!videoPath || typeof videoPath !== 'string') {
    return res.status(400).json({ error: 'Parâmetro path é obrigatório' });
  }

  if (videoPath.includes('..')) {
    return res.status(400).json({ error: 'Path inválido' });
  }

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Arquivo não encontrado' });
  }

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const mimeType = getMimeType(videoPath);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunksize = (end - start) + 1;
    const stream = fs.createReadStream(videoPath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache',
    });

    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });

    fs.createReadStream(videoPath).pipe(res);
  }
});

// List OBS scenes
app.get('/api/obs/scenes', (req, res) => {
  if (!obsConnected) {
    return res.json({ scenes: [], activeScene: '', connected: false });
  }
  res.json({ scenes: obsScenes, activeScene: obsActiveScene, connected: true });
});

// Switch OBS scene
app.post('/api/obs/switch-scene', async (req, res) => {
  const { scene } = req.body;
  if (!scene || typeof scene !== 'string') {
    return res.status(400).json({ success: false, error: 'Nome da cena é obrigatório' });
  }
  if (!obsConnected) {
    return res.status(503).json({ success: false, error: 'OBS não conectado' });
  }
  try {
    await obs.call('SetCurrentProgramScene', { sceneName: scene });
    obsActiveScene = scene;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    obsConnected,
    port: PORT,
  });
});

// ---------------------------------------------------------------------------
// Static Files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: serve index.html for root, 404 for other routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/cenas', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cenas.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] FlyerMediaPlayer Web rodando em http://localhost:${PORT}`);
  console.log(`[Server] Player: http://localhost:${PORT}`);
  console.log(`[Server] Cenas:  http://localhost:${PORT}/cenas`);
  connectOBS();
});
