'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createUpdateManager } = require('./updateManager');

function createHarness({ packaged = true, checkResult = null, responses = [] } = {}) {
  const updater = new EventEmitter();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.currentVersion = { version: '1.0.0' };
  updater.checkForUpdates = async () => checkResult;
  updater.downloadUpdate = async () => {};
  updater.quitAndInstall = () => { updater.installed = true; };
  const dialogApi = {
    showMessageBox: async () => ({ response: responses.shift() ?? 1 })
  };
  const logger = { error() {}, warn() {} };
  const manager = createUpdateManager({
    updater,
    getWindow: () => ({ isDestroyed: () => false, setTitle(title) { updater.title = title; } }),
    isPackaged: packaged,
    dialogApi,
    logger
  });
  return { manager, updater };
}

test('não verifica atualizações no modo de desenvolvimento', async () => {
  const { manager, updater } = createHarness({ packaged: false });
  let calls = 0;
  updater.checkForUpdates = async () => { calls += 1; };

  await manager.check();

  assert.equal(calls, 0);
  assert.equal(updater.autoDownload, true);
});

test('desativa download automático e mantém a versão atual quando não há atualização', async () => {
  const { manager, updater } = createHarness();

  await manager.check();

  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
});

test('só baixa e instala depois da confirmação explícita', async () => {
  let downloads = 0;
  const { manager, updater } = createHarness({
    checkResult: { updateInfo: { version: '1.1.0', releaseNotes: 'Correções' } },
    responses: [0, 0]
  });
  updater.downloadUpdate = async () => { downloads += 1; };

  await manager.check();

  assert.equal(downloads, 1);
  assert.equal(updater.installed, true);
});

test('recusar a atualização não inicia o download', async () => {
  let downloads = 0;
  const { manager, updater } = createHarness({
    checkResult: { updateInfo: { version: '1.1.0' } },
    responses: [1]
  });
  updater.downloadUpdate = async () => { downloads += 1; };

  await manager.check();

  assert.equal(downloads, 0);
  assert.equal(updater.installed, undefined);
});

test('oferece nova tentativa quando o download falha', async () => {
  let downloads = 0;
  const { manager, updater } = createHarness({
    checkResult: { updateInfo: { version: '1.1.0' } },
    responses: [0, 0, 0]
  });
  updater.downloadUpdate = async () => {
    downloads += 1;
    if (downloads === 1) throw new Error('network failure');
  };

  await manager.check();

  assert.equal(downloads, 2);
  assert.equal(updater.installed, true);
});
