const video = document.getElementById('player');
const overlay = document.getElementById('overlay');
const statusMsg = document.getElementById('status-msg');
const statusSub = document.getElementById('status-sub');
const progressFill = document.getElementById('progress-fill');

let mainVideos = [];
let randomVideos = [];
let mainQueue = [];
let randomQueue = [];
let playingMain = false;
let randomPlayedCount = 0;
let currentCutTimer = null;
let currentProgressTimer = null;
let isWaiting = false;
const CUT_TIME_MS = 8 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function showWaiting() {
  overlay.classList.remove('hidden');
  statusMsg.textContent = 'Aguardando Pen Drive';
  statusSub.textContent = 'Conecte o pendrive com os vídeos';
  isWaiting = true;
}

function showError(msg) {
  overlay.classList.remove('hidden');
  statusMsg.textContent = msg;
  statusSub.textContent = '';
  isWaiting = true;
}

function showPlaying() {
  overlay.classList.add('hidden');
  isWaiting = false;
}

// ---------------------------------------------------------------------------
// Progress Bar
// ---------------------------------------------------------------------------
function startProgress(durationMs) {
  stopProgress();
  const maxProgress = Math.min(durationMs, CUT_TIME_MS);
  progressFill.style.width = '0%';
  const startTime = Date.now();

  currentProgressTimer = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const pct = Math.min((elapsed / maxProgress) * 100, 100);
    progressFill.style.width = `${pct}%`;
    if (pct >= 100) {
      stopProgress();
    }
  }, 250);
}

function stopProgress() {
  if (currentProgressTimer) {
    clearInterval(currentProgressTimer);
    currentProgressTimer = null;
  }
  progressFill.style.width = '0%';
}

// ---------------------------------------------------------------------------
// Cut Timer
// ---------------------------------------------------------------------------
function clearCutTimer() {
  if (currentCutTimer) {
    clearTimeout(currentCutTimer);
    currentCutTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Playback Logic
// ---------------------------------------------------------------------------
function playMain() {
  playingMain = true;
  randomPlayedCount = 0;
  clearCutTimer();

  if (mainQueue.length === 0) {
    mainQueue = shuffle(mainVideos);
  }

  const videoPath = mainQueue.shift();
  loadAndPlay(videoPath);
}

function playRandom() {
  playingMain = false;
  randomPlayedCount++;

  if (randomQueue.length === 0) {
    randomQueue = shuffle(randomVideos);
  }

  const videoPath = randomQueue.shift();
  loadAndPlay(videoPath);

  clearCutTimer();
  currentCutTimer = setTimeout(() => {
    advanceToNext();
  }, CUT_TIME_MS);
}

function loadAndPlay(videoPath) {
  video.src = `/api/video?path=${encodeURIComponent(videoPath)}`;
  video.currentTime = 0;
  video.play().catch(() => {});
}

function advanceToNext() {
  clearCutTimer();
  stopProgress();

  if (playingMain) {
    playRandom();
  } else {
    if (randomPlayedCount >= 2) {
      playMain();
    } else {
      playRandom();
    }
  }
}

// ---------------------------------------------------------------------------
// Video Events
// ---------------------------------------------------------------------------
let fpsMeasurements = [];
let fpsCallbackId = null;
const FPS_SAMPLE_COUNT = 10;

function measureVideoFPS(now, metadata) {
  fpsMeasurements.push(metadata.mediaTime);

  if (fpsMeasurements.length >= FPS_SAMPLE_COUNT) {
    const first = fpsMeasurements[0];
    const last = fpsMeasurements[fpsMeasurements.length - 1];
    const elapsed = last - first;
    const fps = Math.round((fpsMeasurements.length - 1) / elapsed);

    if (fps > 0 && fps <= 240) {
      if (window.electronAPI && window.electronAPI.sendDetectedFPS) {
        window.electronAPI.sendDetectedFPS(fps);
      }
    }

    fpsMeasurements = [];
    return;
  }

  if (video && !video.paused && !video.ended) {
    fpsCallbackId = video.requestVideoFrameCallback(measureVideoFPS);
  }
}

function startFPSMeasurement() {
  fpsMeasurements = [];
  if (fpsCallbackId) {
    video.cancelVideoFrameCallback(fpsCallbackId);
    fpsCallbackId = null;
  }
  if ('requestVideoFrameCallback' in video) {
    fpsCallbackId = video.requestVideoFrameCallback(measureVideoFPS);
  }
}

function stopFPSMeasurement() {
  if (fpsCallbackId) {
    video.cancelVideoFrameCallback(fpsCallbackId);
    fpsCallbackId = null;
  }
  fpsMeasurements = [];
}

video.addEventListener('loadedmetadata', () => {
  const durationMs = video.duration * 1000;
  startProgress(durationMs);
  startFPSMeasurement();
});

video.addEventListener('ended', () => {
  advanceToNext();
});

video.addEventListener('error', () => {
  stopProgress();
  clearCutTimer();
  showWaiting();
  setTimeout(autoScan, POLL_INTERVAL_MS);
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'N' || e.key === 'n') {
    e.preventDefault();
    if (!isWaiting) {
      advanceToNext();
    }
  }
});

// Double-click to toggle fullscreen
let lastClickTime = 0;
video.addEventListener('click', (e) => {
  const now = Date.now();
  if (now - lastClickTime < 300) {
    e.preventDefault();
    toggleFullscreen();
  }
  lastClickTime = now;
});

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Auto Scan
// ---------------------------------------------------------------------------
async function autoScan() {
  try {
    const res = await fetch('/api/scan');
    const data = await res.json();

    if (data.status === 'waiting') {
      showWaiting();
      setTimeout(autoScan, POLL_INTERVAL_MS);
      return;
    }

    if (data.status === 'main-missing') {
      if (window.electronAPI && window.electronAPI.sendMainVideoMissing) {
        window.electronAPI.sendMainVideoMissing();
      }
      showError('ARQUIVO DE VIDEO PRINCIPAL NÃO ENCONTRADO');
      return;
    }

    if (data.status === 'videos-folder-missing') {
      if (window.electronAPI && window.electronAPI.sendVideosFolderMissing) {
        window.electronAPI.sendVideosFolderMissing();
      }
      showError('PASTA DE VÍDEOS NÃO ENCONTRADA');
      return;
    }

    if (data.status === 'both-missing') {
      if (window.electronAPI && window.electronAPI.sendBothMissing) {
        window.electronAPI.sendBothMissing();
      }
      showError('VÍDEO PRINCIPAL E PASTA DE VÍDEOS NÃO ENCONTRADOS');
      return;
    }

    mainVideos = data.main;
    randomVideos = data.random;

    if (mainVideos.length === 0) {
      if (window.electronAPI && window.electronAPI.sendMainVideoMissing) {
        window.electronAPI.sendMainVideoMissing();
      }
      showError('ARQUIVO DE VIDEO PRINCIPAL NÃO ENCONTRADO');
      return;
    }

    mainQueue = shuffle(mainVideos);
    randomQueue = shuffle(randomVideos);
    showPlaying();
    playMain();
  } catch (err) {
    showError('Erro ao escanear: ' + err.message);
    setTimeout(autoScan, POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
window.addEventListener('load', () => {
  showWaiting();
  autoScan();
});
