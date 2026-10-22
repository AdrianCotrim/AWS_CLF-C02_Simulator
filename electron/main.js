'use strict';

const { app, BrowserWindow, dialog, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');
const { createUpdateManager } = require('./updateManager');
const { createBackendLifecycle } = require('./backendLifecycle');

const HOST = '127.0.0.1';
const frontendDirectory = app.getAppPath();
const appIconPath = path.join(frontendDirectory, 'build', 'icon.ico');
const backendStartupTimeoutMs = Number(process.env.BACKEND_STARTUP_TIMEOUT_MS) || 15000;

let backendProcess;
let frontendServer;
let mainWindow;
let isShuttingDown = false;
let logger = console;
let backendLifecycle;

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
  process.env.QUESTIONS_FILE = path.join(app.getAppPath(), 'distribution', 'questions.json');
  process.env.QUESTIONS_SEQUENCE_FILE = path.join(userDataDirectory, 'questions.json.sequence.json');
}

function createLogger() {
  if (!app.isPackaged) return console;
  const logDirectory = app.getPath('logs');
  fs.mkdirSync(logDirectory, { recursive: true });
  const logFile = path.join(logDirectory, 'startup.log');
  const write = (level, args) => {
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(String).join(' ')}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  };
  return {
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args)
  };
}

function getBackendStartOptions(port) {
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
  logger.info(`Backend configurado: port=${port}, health=http://${HOST}:${port}/health`);
  return { executable: nodeExecutable, cwd: backendDirectory, env: environment, port };
}

async function startServices() {
  configureDataPaths();
  logger = createLogger();
  const startedAt = Date.now();
  const backendProbe = http.createServer();
  const backendPort = await listen(backendProbe);
  await closeServer(backendProbe);
  backendLifecycle = createBackendLifecycle({
    logger,
    startupTimeoutMs: backendStartupTimeoutMs
  });
  backendProcess = await backendLifecycle.start(getBackendStartOptions(backendPort));
  logger.info(`Inicialização do backend concluída em ${Date.now() - startedAt}ms`);
  frontendServer = createFrontendServer(backendPort);
  const frontendPort = await listen(frontendServer);
  return `http://${HOST}:${frontendPort}`;
}

async function stopServices() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  await closeServer(frontendServer);
  if (backendLifecycle) await backendLifecycle.stop();
  backendProcess = null;
}

function createWindow(frontendUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    show: false,
    icon: appIconPath,
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
    if (process.platform === 'win32') app.setAppUserModelId('com.adriancotrim.awsclf.c02simulator');
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
    logger.error(`Falha na inicialização: ${error.code || 'unknown'} - ${error.stack || error.message}`);
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
