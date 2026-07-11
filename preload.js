const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  restart: () => ipcRenderer.send('restart-app'),
  onFrameUpdate: (callback) => ipcRenderer.on('frame-update', (_, data) => callback(data)),
  sendDetectedFPS: (fps) => ipcRenderer.send('detected-fps', fps),
  requestAdvance: () => ipcRenderer.send('advance-video'),
});
