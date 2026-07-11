const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  restart: () => ipcRenderer.send('restart-app'),
  onFrameUpdate: (callback) => ipcRenderer.on('frame-update', (_, data) => callback(data)),
  sendDetectedFPS: (fps) => ipcRenderer.send('detected-fps', fps),
  requestAdvance: () => ipcRenderer.send('advance-video'),
  sendMainVideoMissing: () => ipcRenderer.send('media-error', 'main-missing'),
  sendVideosFolderMissing: () => ipcRenderer.send('media-error', 'videos-folder-missing'),
  sendBothMissing: () => ipcRenderer.send('media-error', 'both-missing'),
  sendMainVideoFound: () => ipcRenderer.send('main-video-found'),
  onShowMainMissingError: (callback) => ipcRenderer.on('show-main-missing-error', callback),
});
