const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = parseInt(process.env.PORT || '4600', 10);
const SKIP_DRIVES = ['C', 'D'];
const VIDEO_EXTENSIONS = ['.mp4'];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function getMainVideoName() {
  const config = loadConfig();
  return (config.media && typeof config.media.mainVideoName === 'string')
    ? config.media.mainVideoName.toUpperCase()
    : 'MAIN';
}

function getVideosFolderName() {
  const config = loadConfig();
  return (config.media && typeof config.media.videosFolder === 'string')
    ? config.media.videosFolder.toLowerCase()
    : 'videos';
}

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

function findVideosFolder(root, folderName) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        console.log(`[Scan] Pasta encontrada: "${entry.name}" vs "${folderName}" = match: ${entry.name.toLowerCase() === folderName.toLowerCase()}`);
        if (entry.name.toLowerCase() === folderName.toLowerCase()) {
          return path.join(root, entry.name);
        }
      }
    }
  } catch {
    // ignored
  }
  return null;
}

function scanDrive(driveLetter) {
  const root = `${driveLetter}:\\`;
  const main = [];
  const random = [];
  const mainVideoName = getMainVideoName();
  const videosFolderName = getVideosFolderName();
  let folderFound = false;

  try {
    const files = fs.readdirSync(root);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!VIDEO_EXTENSIONS.includes(ext)) continue;
      const fullPath = path.join(root, file);
      if (fs.statSync(fullPath).isFile() && file.toUpperCase().includes(mainVideoName)) {
        main.push(fullPath);
      }
    }
  } catch {
    return { main: [], random: [], folderFound: false };
  }

  const target = findVideosFolder(root, videosFolderName);

  if (target) {
    folderFound = true;
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

  return { main, random, folderFound };
}

function scanAllDrives() {
  const drives = getAvailableDrives();
  const mainVideoName = getMainVideoName();
  const videosFolderName = getVideosFolderName();
  console.log(`[Scan] Iniciando scan. mainVideoName="${mainVideoName}", videosFolder="${videosFolderName}", drives=${JSON.stringify(drives)}`);

  // Procura o drive que contém o vídeo principal
  for (const drive of drives) {
    const result = scanDrive(drive);
    console.log(`[Scan] Drive ${drive}: main=${result.main.length}, folderFound=${result.folderFound}, random=${result.random.length}`);
    if (result.main.length > 0) {
      // Vídeo principal encontrado neste drive
      if (!result.folderFound) {
        console.log(`[Scan] Retornando: videos-folder-missing (drive ${drive})`);
        return {
          status: 'videos-folder-missing',
          drive: `${drive}:`,
          main: result.main,
          random: [],
        };
      }
      console.log(`[Scan] Retornando: found (drive ${drive})`);
      return {
        status: 'found',
        drive: `${drive}:`,
        main: result.main,
        random: result.random,
      };
    }
  }

  // Nenhum drive com vídeo principal. Verifica se há algum drive acessível.
  for (const drive of drives) {
    try {
      const root = `${drive}:\\`;
      fs.readdirSync(root);
      // Drive acessível, mas sem vídeo principal. Verifica se a pasta existe.
      const result = scanDrive(drive);
      console.log(`[Scan] Drive acessivel ${drive}: main=${result.main.length}, folderFound=${result.folderFound}, random=${result.random.length}`);
      if (!result.folderFound) {
        console.log(`[Scan] Retornando: both-missing (drive ${drive})`);
        return {
          status: 'both-missing',
          drive: `${drive}:`,
          main: [],
          random: [],
        };
      }
      console.log(`[Scan] Retornando: main-missing (drive ${drive})`);
      return {
        status: 'main-missing',
        drive: `${drive}:`,
        main: [],
        random: result.random,
      };
    } catch (err) {
      console.log(`[Scan] Drive ${drive} nao acessivel: ${err.message}`);
      continue;
    }
  }

  console.log(`[Scan] Retornando: waiting (nenhum drive acessivel)`);
  return { status: 'waiting', main: [], random: [], drive: '' };
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

// CORS for file:// protocol (Electron wait window)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

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

// Health check
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    port: PORT,
  });
});

// Update main video name in config
app.post('/api/config/main-video-name', express.json(), (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'Nome inválido' });
  }
  try {
    const config = loadConfig();
    if (!config.media) config.media = {};
    config.media.mainVideoName = name.trim().toUpperCase();
    saveConfig(config);
    res.json({ success: true, mainVideoName: config.media.mainVideoName });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar configuração: ' + err.message });
  }
});

// Get current main video name
app.get('/api/config/main-video-name', (req, res) => {
  res.json({ mainVideoName: getMainVideoName() });
});

// Update videos folder name in config
app.post('/api/config/videos-folder', express.json(), (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'Nome inválido' });
  }
  try {
    const config = loadConfig();
    if (!config.media) config.media = {};
    config.media.videosFolder = name.trim().toLowerCase();
    saveConfig(config);
    res.json({ success: true, videosFolder: config.media.videosFolder });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar configuração: ' + err.message });
  }
});

// Get current videos folder name
app.get('/api/config/videos-folder', (req, res) => {
  res.json({ videosFolder: getVideosFolderName() });
});

// Update both main video name and videos folder
app.post('/api/config', express.json(), (req, res) => {
  const { mainVideoName, videosFolder } = req.body;
  if ((!mainVideoName || typeof mainVideoName !== 'string' || mainVideoName.trim() === '') &&
    (!videosFolder || typeof videosFolder !== 'string' || videosFolder.trim() === '')) {
    return res.status(400).json({ error: 'Pelo menos um campo é obrigatório' });
  }
  try {
    const config = loadConfig();
    if (!config.media) config.media = {};
    if (mainVideoName && typeof mainVideoName === 'string' && mainVideoName.trim() !== '') {
      config.media.mainVideoName = mainVideoName.trim().toUpperCase();
    }
    if (videosFolder && typeof videosFolder === 'string' && videosFolder.trim() !== '') {
      config.media.videosFolder = videosFolder.trim().toLowerCase();
    }
    saveConfig(config);
    res.json({
      success: true,
      mainVideoName: config.media.mainVideoName,
      videosFolder: config.media.videosFolder,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar configuração: ' + err.message });
  }
});

// Get all config
app.get('/api/config', (req, res) => {
  res.json({
    mainVideoName: getMainVideoName(),
    videosFolder: getVideosFolderName(),
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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] FlyerMediaPlayer Web rodando em http://localhost:${PORT}`);
  console.log(`[Server] Player: http://localhost:${PORT}`);
});
