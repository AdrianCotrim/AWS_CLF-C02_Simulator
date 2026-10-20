'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createUpdateManager } = require('./updateManager');

function createHarness({
  packaged = true,
  currentVersion = '1.0.0',
  checkResult = null,
  responses = []
} = {}) {
  const updater = new EventEmitter();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.currentVersion = { version: currentVersion };
  updater.checkForUpdates = async () => checkResult;
  updater.downloadUpdate = async () => {};
  updater.quitAndInstall = () => { updater.installed = true; };
  const dialogCalls = [];
  const dialogApi = {
    showMessageBox: async (_window, options) => {
      dialogCalls.push(options);
      return { response: responses.shift() ?? 1 };
    }
  };
  const logger = { error() {}, warn() {} };
  const manager = createUpdateManager({
    updater,
    getWindow: () => ({ isDestroyed: () => false, setTitle(title) { updater.title = title; } }),
    isPackaged: packaged,
    dialogApi,
    logger
  });
  return { manager, updater, dialogCalls };
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

test('não notifica quando a versão remota é igual à instalada', async () => {
  const { manager, updater, dialogCalls } = createHarness({
    currentVersion: '1.0.1',
    checkResult: { updateInfo: { version: '1.0.1' } }
  });
  updater.downloadUpdate = async () => {
    throw new Error('não deveria baixar');
  };

  await manager.check();

  assert.equal(updater.installed, undefined);
  assert.equal(dialogCalls.length, 0);
});

test('notifica quando a versão remota é mais recente', async () => {
  const { manager, updater, dialogCalls } = createHarness({
    currentVersion: '1.0.1',
    checkResult: { updateInfo: { version: '1.0.2' } },
    responses: [1]
  });
  updater.downloadUpdate = async () => { throw new Error('não deveria baixar'); };

  await manager.check();

  assert.equal(updater.installed, undefined);
  assert.equal(dialogCalls.length, 1);
});

test('reconhece corretamente uma versão 1.0.10 como mais recente que 1.0.9', async () => {
  const { compareVersions } = require('./updateManager');
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
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
