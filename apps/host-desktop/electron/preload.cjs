const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('runner', {
  state: () => ipcRenderer.invoke('runner:state'),
  run: () => ipcRenderer.invoke('runner:run'),
  stop: () => ipcRenderer.invoke('runner:stop'),
  save: () => ipcRenderer.invoke('runner:save'),
  listen: (callback) => ipcRenderer.on('runner:state', (_, state) => callback(state)),
});

contextBridge.exposeInMainWorld('hosting', {
  state: () => ipcRenderer.invoke('host:state'),
  pair: () => ipcRenderer.invoke('host:pair'),
  limits: (limits) => ipcRenderer.invoke('host:limits', limits),
  online: (enabled) => ipcRenderer.invoke('host:online', enabled),
  listen: (callback) => ipcRenderer.on('host:update', (_, state) => callback(state)),
});
