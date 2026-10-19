'use strict';

function formatReleaseNotes(notes) {
  if (typeof notes === 'string') return notes.trim();
  if (Array.isArray(notes)) {
    return notes.map(note => typeof note === 'string' ? note : note && note.note).filter(Boolean).join('\n');
  }
  return '';
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
      if (result && result.updateInfo && result.updateInfo.version
        && await askToDownload(result.updateInfo)) {
        await download(result.updateInfo);
      }
    } catch (error) {
      logger.warn('Não foi possível verificar atualizações:', error.message);
    }
  }

  return { check };
}

module.exports = { createUpdateManager };
