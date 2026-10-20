'use strict';

function formatReleaseNotes(notes) {
  if (typeof notes === 'string') return notes.trim();
  if (Array.isArray(notes)) {
    return notes.map(note => typeof note === 'string' ? note : note && note.note).filter(Boolean).join('\n');
  }
  return '';
}

function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const match = version.trim().replace(/^v/i, '').match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return null;

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] > rightVersion.core[index] ? 1 : -1;
    }
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1;
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1;
  for (let index = 0; index < leftVersion.prerelease.length; index += 1) {
    if (index >= rightVersion.prerelease.length) return 1;
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumber = /^\d+$/.test(leftIdentifier) ? Number(leftIdentifier) : null;
    const rightNumber = /^\d+$/.test(rightIdentifier) ? Number(rightIdentifier) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return leftVersion.prerelease.length === rightVersion.prerelease.length ? 0 : -1;
}

function createUpdateManager({ updater, getWindow, isPackaged, dialogApi, logger = console }) {
  let checkStarted = false;
  let downloadInProgress = false;

  function setStatus(title) {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.setTitle(title);
  }

  async function askToDownload(updateInfo) {
    const currentVersion = updater.currentVersion?.version || 'atual';
    const releaseNotes = formatReleaseNotes(updateInfo.releaseNotes);
    const details = [
      `Versão instalada: ${currentVersion}`,
      `Nova versão: ${updateInfo.version}`,
      releaseNotes ? `\nNotas da versão:\n${releaseNotes}` : ''
    ].filter(Boolean).join('\n');
    const result = await dialogApi.showMessageBox(getWindow(), {
      type: 'info',
      buttons: ['Baixar atualização', 'Agora não'],
      defaultId: 0,
      cancelId: 1,
      title: 'Atualização disponível',
      message: 'Uma nova versão do AWS CLF-C02 Simulator está disponível.',
      detail: details
    });
    return result.response === 0;
  }

  async function download(updateInfo) {
    if (downloadInProgress) return;
    downloadInProgress = true;
    setStatus(`AWS CLF-C02 Simulator - Baixando atualização ${updateInfo.version}...`);
    const onProgress = progress => {
      const percent = Number.isFinite(progress.percent) ? Math.round(progress.percent) : null;
      if (percent !== null) {
        setStatus(`AWS CLF-C02 Simulator - Baixando atualização (${percent}%)...`);
      }
    };
    updater.on('download-progress', onProgress);
    try {
      await updater.downloadUpdate();
      setStatus('AWS CLF-C02 Simulator');
      const result = await dialogApi.showMessageBox(getWindow(), {
        type: 'info',
        buttons: ['Instalar e reiniciar', 'Depois'],
        defaultId: 0,
        cancelId: 1,
        title: 'Atualização pronta',
        message: 'A atualização foi baixada.',
        detail: 'Deseja instalar a nova versão e reiniciar o aplicativo agora?'
      });
      if (result.response === 0) updater.quitAndInstall(false, false);
    } catch (error) {
      setStatus('AWS CLF-C02 Simulator');
      logger.error('Falha ao baixar atualização:', error);
      const result = await dialogApi.showMessageBox(getWindow(), {
        type: 'error',
        buttons: ['Tentar novamente', 'Agora não'],
        defaultId: 0,
        cancelId: 1,
        title: 'Falha na atualização',
        message: 'Não foi possível baixar a atualização.',
        detail: 'Verifique sua conexão com a internet e tente novamente.'
      });
      if (result.response === 0) {
        downloadInProgress = false;
        await download(updateInfo);
      }
    } finally {
      updater.removeListener('download-progress', onProgress);
      downloadInProgress = false;
    }
  }

  async function check() {
    if (!isPackaged || checkStarted) return;
    checkStarted = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    try {
      const result = await updater.checkForUpdates();
      const updateInfo = result && result.updateInfo;
      const currentVersion = updater.currentVersion && updater.currentVersion.version;
      const versionComparison = updateInfo && compareVersions(updateInfo.version, currentVersion);
      if (versionComparison === null && updateInfo && updateInfo.version) {
        logger.warn('Versão de atualização inválida:', updateInfo.version);
      }
      if (versionComparison > 0 && await askToDownload(updateInfo)) {
        await download(updateInfo);
      }
    } catch (error) {
      logger.warn('Não foi possível verificar atualizações:', error.message);
    }
  }

  return { check };
}

module.exports = { compareVersions, createUpdateManager };
