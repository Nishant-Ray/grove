const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { copyFile } = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');

let window;
let agent;
let quitting = false;
let snapshot = { state: 'starting', detail: '' };

function update(state, detail = '') {
  snapshot = { state, detail };
  if (window && !window.isDestroyed()) window.webContents.send('runner:state', snapshot);
}

function folder() {
  return path.join(app.getPath('userData'), 'runner');
}

function startAgent() {
  update('starting');
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'dist');
  const exe = process.platform === 'win32' ? 'grove-agent.exe' : 'grove-agent';
  const child = spawn(path.join(root, 'agent', 'grove-agent', exe), [folder()], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  agent = child;
  child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (agent !== child || quitting) return;
    try {
      const { state, detail } = JSON.parse(line);
      if (snapshot.state === 'stopping' && ['running', 'preparing'].includes(state)) return;
      update(state, detail);
    } catch {
      update('failed', 'The local agent returned an invalid response.');
    }
  });
  child.on('error', () => update('offline', 'Build the bundled agent, then retry.'));
  child.on('close', () => {
    agent = undefined;
    if (quitting) app.quit();
    else if (snapshot.state !== 'offline')
      update('offline', 'The local agent exited. Retry to reconnect.');
  });
}

function send(command) {
  if (agent?.stdin.writable) agent.stdin.write(JSON.stringify({ command }) + '\n');
}

function createWindow() {
  window = new BrowserWindow({
    width: 790,
    height: 690,
    minWidth: 490,
    minHeight: 600,
    title: 'Grove Host',
    backgroundColor: '#f6f7f0',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(path.join(__dirname, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(() => {
    ipcMain.handle('runner:state', () => snapshot);
    ipcMain.handle('runner:run', () => {
      if (snapshot.state === 'offline' && !agent) return startAgent();
      if (!['ready', 'failed', 'stopped', 'completed'].includes(snapshot.state)) return;
      update('preparing', 'Checking Docker…');
      send('run');
    });
    ipcMain.handle('runner:stop', () => {
      if (!['preparing', 'running'].includes(snapshot.state)) return;
      update('stopping', 'Cleaning up the job…');
      send('stop');
    });
    ipcMain.handle('runner:save', async () => {
      if (snapshot.state !== 'completed') return;
      const { filePath } = await dialog.showSaveDialog(window, {
        defaultPath: 'grove-result.json',
      });
      if (filePath) await copyFile(path.join(folder(), 'result.json'), filePath);
    });
    createWindow();
    startAgent();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!agent) return;
    event.preventDefault();
    if (!quitting) {
      quitting = true;
      send('quit');
      agent.stdin.end();
    }
  });
}
