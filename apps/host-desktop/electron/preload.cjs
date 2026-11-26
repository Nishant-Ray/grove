const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('runner', {
  state: () => ipcRenderer.invoke('runner:state'),
  run: () => ipcRenderer.invoke('runner:run'),
  stop: () => ipcRenderer.invoke('runner:stop'),
  save: () => ipcRenderer.invoke('runner:save'),
  listen: (callback) => ipcRenderer.on('runner:state', (_, state) => callback(state)),
});
