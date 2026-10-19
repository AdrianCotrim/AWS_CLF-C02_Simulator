'use strict';

const { app, BrowserWindow, dialog, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { autoUpdater } = require('electron-updater');
const { createUpdateManager } = require('./updateManager');

const HOST = '127.0.0.1';
const frontendDirectory = app.getAppPath();
const backendHealthPath = '/api/questions';
const maxHealthAttempts = 30;
const healthRetryDelayMs = 200;

let backendProcess;
let frontendServer;
let mainWindow;
let isShuttingDown = false;

function getBackendDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'backend')
    : path.resolve(__dirname, '..', 'backend');
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  }[extension] || 'application/octet-stream';
}

function createFrontendServer(backendPort) {
  return http.createServer((request, response) => {
    const requestPath = new URL(request.url, `http://${HOST}`).pathname;
    if (requestPath === '/config.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(`window.__AWS_CLF_API_BASE_URL__ = ${JSON.stringify(`http://${HOST}:${backendPort}/api`)};`);
      return;
    }
    const relativePath = decodeURIComponent(requestPath === '/' ? '/index.html' : requestPath);
    const filePath = path.resolve(frontendDirectory, `.${relativePath}`);
    if (filePath !== frontendDirectory && !filePath.startsWith(`${frontendDirectory}${path.sep}`)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (error, contents) => {
      if (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500);
        response.end(error.code === 'ENOENT' ? 'Not found' : 'Unable to load resource');
        return;
      }
      response.writeHead(200, { 'Content-Type': contentType(filePath) });
      response.end(contents);
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, HOST);
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise(resolve => server.close(() => resolve()));
}

function configureDataPaths() {
  if (!app.isPackaged) return;
  const userDataDirectory = app.getPath('userData');
  process.env.LOCAL_QUESTIONS_FILE = path.join(userDataDirectory, 'questions.local.json');
  process.env.USER_DATA_FILE = path.join(userDataDirectory, 'user-data.json');
  process.env.HISTORY_FILE = path.join(userDataDirectory, 'history.json');
  process.env.PROGRESS_FILE = path.join(userDataDirectory, 'progress.json');
  process.env.BACKUP_DIRECTORY = path.join(userDataDirectory, 'backups');
  process.env.QUESTIONS_FILE = path.join(app.getAppPath(), 'data', 'questions.json');
}

function startBackend(port) {
  const nodeExecutable = app.isPackaged
    ? process.execPath
    : (process.env.npm_node_execpath || process.env.NODE_EXEC_PATH || process.execPath);
  const backendDirectory = getBackendDirectory();
  const environment = {
    ...process.env,
    PORT: String(port),
    ...(nodeExecutable === process.execPath && process.versions.electron
      ? { ELECTRON_RUN_AS_NODE: '1' }
      : {})
  };
  return new Promise((resolve, reject) => {
    backendProcess = spawn(nodeExecutable, ['server.js'], {
      cwd: backendDirectory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let startupError = '';
    backendProcess.stderr.setEncoding('utf8');
    backendProcess.stderr.on('data', chunk => { startupError += chunk; });
    backendProcess.once('error', reject);
    backendProcess.once('exit', code => {
      if (!isShuttingDown && code !== 0) {
        reject(new Error(startupError.trim() || `O backend encerrou com código ${code}.`));
      }
    });
    resolve();
  });
}

async function waitForBackend(port) {
  const url = `http://${HOST}:${port}${backendHealthPath}`;
  for (let attempt = 0; attempt < maxHealthAttempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child process may still be binding its port.
    }
    await new Promise(resolve => setTimeout(resolve, healthRetryDelayMs));
  }
  throw new Error('O backend não ficou disponível dentro do tempo esperado.');
}

async function startServices() {
  configureDataPaths();
  const backendProbe = http.createServer();
  const backendPort = await listen(backendProbe);
  await closeServer(backendProbe);
  await startBackend(backendPort);
  await waitForBackend(backendPort);
  frontendServer = createFrontendServer(backendPort);
  const frontendPort = await listen(frontendServer);
  return `http://${HOST}:${frontendPort}`;
}

async function stopServices() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  await closeServer(frontendServer);
  if (backendProcess && !backendProcess.killed) {
    if (backendProcess.exitCode === null && backendProcess.signalCode === null) {
      await new Promise(resolve => {
        backendProcess.once('exit', resolve);
        backendProcess.kill();
      });
    }
  }
}

function createWindow(frontendUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  const allowedOrigin = new URL(frontendUrl).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: new URL(url).origin === allowedOrigin ? 'allow' : 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => {
    if (mainWindow.webContents.getURL() && new URL(event.url).origin !== allowedOrigin) {
      event.preventDefault();
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(frontendUrl).catch(error => {
    dialog.showErrorBox('Falha ao carregar o aplicativo', error.message);
  });
  return mainWindow;
}

app.whenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
      callback({ cancel: true });
    });
    const frontendUrl = await startServices();
    createWindow(frontendUrl);
    const updateManager = createUpdateManager({
      updater: autoUpdater,
      getWindow: () => mainWindow,
      isPackaged: app.isPackaged,
      dialogApi: dialog
    });
    void updateManager.check();
  } catch (error) {
    await stopServices();
    dialog.showErrorBox('Falha ao iniciar o aplicativo', error.message);
    app.quit();
  }
});

app.on('before-quit', event => {
  if (isShuttingDown) return;
  event.preventDefault();
  stopServices().then(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
