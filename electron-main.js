const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SERVER_PORT = parseInt(process.env.PORT || '4600', 10);
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { preview: { fps: 5, width: 480, height: 270 } };
  }
}

const config = loadConfig();
const PREVIEW_FPS_MODE = config.preview.fps; // "auto" or number
const PREVIEW_WIDTH = config.preview.width || 480;
const PREVIEW_HEIGHT = config.preview.height || 270;
const DEFAULT_CAPTURE_INTERVAL_MS = typeof PREVIEW_FPS_MODE === 'number'
  ? Math.round(1000 / PREVIEW_FPS_MODE)
  : 200;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
let waitWindow = null;
let playerWindow = null;
let previewWindow = null;
let captureInterval = null;
let currentCaptureMs = DEFAULT_CAPTURE_INTERVAL_MS;

// ---------------------------------------------------------------------------
// Wait Window (1 display - "Aguardando segundo monitor")
// ---------------------------------------------------------------------------
let waitWindowState = 'waiting'; // 'waiting', 'main-missing', 'videos-folder-missing', 'both-missing'

function getWaitWindowHeight(state) {
  switch (state) {
    case 'both-missing':
      return 240; // Error + 2 inputs + restart button
    case 'main-missing':
    case 'videos-folder-missing':
      return 200; // Error + 1 input + restart button
    default:
      return 100; // Just "Aguardando segundo monitor" + restart button
  }
}

function createWaitWindow() {
  if (waitWindow && !waitWindow.isDestroyed()) return;

  const height = getWaitWindowHeight(waitWindowState);

  waitWindow = new BrowserWindow({
    width: 380,
    height: height,
    frame: true,
    alwaysOnTop: false,
    resizable: false,
    skipTaskbar: false,
    center: true,
    transparent: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  waitWindow.setMenu(null);

  // Load from server to allow fetch to /api endpoints (same-origin)
  const waitUrl = `${SERVER_URL}/wait.html?state=${waitWindowState}`;
  waitWindow.loadURL(waitUrl);

  waitWindow.on('closed', () => {
    waitWindow = null;
  });
}

function closeWaitWindow() {
  if (waitWindow && !waitWindow.isDestroyed()) {
    waitWindow.close();
    waitWindow = null;
  }
}

// ---------------------------------------------------------------------------
// Player Window (2+ displays - fullscreen on secondary monitor)
// ---------------------------------------------------------------------------
function createPlayerWindow(display) {
  if (playerWindow && !playerWindow.isDestroyed()) return;

  const { bounds } = display;

  playerWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fullscreen: true,
    kiosk: true,
    frame: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  playerWindow.setAlwaysOnTop(true, 'screen-saver');
  playerWindow.setVisibleOnAllWorkspaces(true);

  playerWindow.loadURL(SERVER_URL);

  playerWindow.on('closed', () => {
    playerWindow = null;
  });

  // Escape key exits fullscreen (emergency exit)
  playerWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape' && input.type === 'keyDown') {
      playerWindow.setKiosk(false);
      playerWindow.setFullScreen(false);
      playerWindow.setAlwaysOnTop(false);
    }
  });
}

function closePlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.close();
    playerWindow = null;
  }
  stopCapture();
  closePreviewWindow();
}

// ---------------------------------------------------------------------------
// Preview Window (mirrors player content on primary display)
// ---------------------------------------------------------------------------
function createPreviewWindow(display) {
  if (previewWindow && !previewWindow.isDestroyed()) return;

  const { bounds } = display;

  previewWindow = new BrowserWindow({
    x: bounds.x + 50,
    y: bounds.y + 50,
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    frame: true,
    alwaysOnTop: false,
    resizable: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
    title: 'FlyerMediaPlayer - Preview',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  previewWindow.setMenu(null);
  previewWindow.loadFile(path.join(__dirname, 'public', 'preview.html'));

  previewWindow.on('closed', () => {
    // If we still have a player window, the preview was likely closed manually
    // In this case, quit the entire application
    if (playerWindow && !playerWindow.isDestroyed()) {
      console.log('[Electron] Preview window closed manually - exiting application');
      app.quit();
    } else {
      previewWindow = null;
    }
  });
}

function closePreviewWindow() {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.close();
    previewWindow = null;
  }
}

// ---------------------------------------------------------------------------
// Frame Capture (mirrors player to preview)
// ---------------------------------------------------------------------------
function startCapture(intervalMs) {
  stopCapture();

  const ms = intervalMs || currentCaptureMs;
  console.log(`[Electron] Capture iniciado: ${ms}ms (~${Math.round(1000 / ms)}fps)`);

  captureInterval = setInterval(async () => {
    if (!playerWindow || playerWindow.isDestroyed()) return;
    if (!previewWindow || previewWindow.isDestroyed()) return;

    try {
      const image = await playerWindow.webContents.capturePage();
      const size = image.getSize();
      if (size.width === 0 || size.height === 0) return;

      const resized = image.resize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
      const jpegBuffer = resized.toJPEG(50);
      const base64 = jpegBuffer.toString('base64');

      previewWindow.webContents.send('frame-update', {
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        dataURL: `data:image/jpeg;base64,${base64}`,
      });
    } catch {
      // ignored - window may be closing
    }
  }, ms);
}

function stopCapture() {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
}

function updateCaptureInterval(newMs) {
  if (newMs < 16) newMs = 16; // cap at ~60fps
  if (newMs === currentCaptureMs) return;
  currentCaptureMs = newMs;
  if (captureInterval) {
    startCapture(newMs);
  }
}

// ---------------------------------------------------------------------------
// Display Detection
// ---------------------------------------------------------------------------
function getSecondaryDisplay() {
  const displays = screen.getAllDisplays();
  return displays.length >= 2 ? displays[1] : null;
}

function handleDisplays() {
  const secondary = getSecondaryDisplay();
  const primary = screen.getPrimaryDisplay();

  if (secondary) {
    console.log(`[Electron] Display secundario detectado: ${secondary.bounds.width}x${secondary.bounds.height}`);
    closeWaitWindow();
    createPlayerWindow(secondary);
    createPreviewWindow(primary);
    startCapture();
  } else {
    console.log('[Electron] Somente 1 display. Modo de espera.');
    closePlayerWindow();
    createWaitWindow();
  }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------
ipcMain.on('restart-app', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.on('detected-fps', (_, originalFPS) => {
  if (PREVIEW_FPS_MODE !== 'auto') return;
  const previewFPS = Math.max(1, Math.round(originalFPS / 2));
  const newMs = Math.round(1000 / previewFPS);
  console.log(`[Electron] Video FPS detectado: ${originalFPS}fps -> preview FPS: ${previewFPS}fps (capture: ${newMs}ms)`);
  updateCaptureInterval(newMs);
});

ipcMain.on('advance-video', () => {
  if (playerWindow && !playerWindow.isDestroyed()) {
    console.log('[Electron] Advance request received from preview');
    playerWindow.webContents.executeJavaScript('advanceToNext()').catch(() => {});
  }
});

ipcMain.on('media-error', (_, state) => {
  console.log(`[Electron] Erro de midia (${state}) - mostrando janela de espera com erro`);
  // Aceita estados: 'main-missing', 'videos-folder-missing', 'both-missing'
  const validStates = ['main-missing', 'videos-folder-missing', 'both-missing'];
  if (!validStates.includes(state)) {
    state = 'main-missing';
  }
  waitWindowState = state;
  closePlayerWindow();
  closeWaitWindow();
  createWaitWindow();
});

ipcMain.on('main-video-found', () => {
  console.log('[Electron] Midia encontrada - abrindo player');
  waitWindowState = 'waiting';
  closeWaitWindow();
  handleDisplays();
});

// ---------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // Start Express server in background
  require('./server.js');

  // Wait a bit for server to be ready, then detect displays
  setTimeout(() => {
    handleDisplays();

    // Listen for display changes
    screen.on('display-added', () => {
      console.log('[Electron] Display adicionado');
      handleDisplays();
    });

    screen.on('display-removed', () => {
      console.log('[Electron] Display removido');
      handleDisplays();
    });
  }, 1500);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    handleDisplays();
  }
});
