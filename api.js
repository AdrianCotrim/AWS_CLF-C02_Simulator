'use strict';

(function () {
  const apiBaseUrl = window.__AWS_CLF_API_BASE_URL__ || 'http://127.0.0.1:3000/api';
  const endpoint = `${apiBaseUrl}/questions`;
  const backupEndpoint = `${apiBaseUrl}/backup`;
  const progressEndpoint = `${apiBaseUrl}/progress`;

  async function getQuestions() {
    let response;
    try {
      response = await fetch(endpoint);
    } catch {
      throw new Error('Não foi possível carregar as questões. Verifique se o servidor está funcionando e tente novamente.');
    }

    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok || !Array.isArray(result)) {
      throw new Error('Não foi possível carregar as questões. Verifique se o servidor está funcionando e tente novamente.');
    }
    return result;
  }

  async function getCatalogStatus() {
    let response;
    try {
      response = await fetch(`${endpoint}/catalog-status`);
    } catch {
      throw new Error('Não foi possível verificar a versão do catálogo. Verifique se o backend está funcionando.');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || typeof result.initialized !== 'boolean'
      || !Array.isArray(result.added) || !Array.isArray(result.changed)
      || !Array.isArray(result.removed) || !Array.isArray(result.conflicts)) {
      throw new Error(result && result.error && result.error.message
        ? result.error.message
        : 'A API respondeu em um formato inesperado ao verificar o catálogo.');
    }
    return result;
  }

  async function acknowledgeCatalogUpdate() {
    const response = await fetch(`${endpoint}/catalog-status/acknowledge`, { method: 'POST' }).catch(() => {
      throw new Error('Não foi possível registrar a revisão do catálogo. Verifique se o backend está funcionando.');
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || typeof result.initialized !== 'boolean') {
      throw new Error(result && result.error && result.error.message
        ? result.error.message
        : 'A API respondeu em um formato inesperado ao registrar a revisão do catálogo.');
    }
    return result;
  }

  async function getQuestionMetadata(id) {
    const response = await fetch(`${endpoint}/${encodeURIComponent(id)}/metadata`).catch(() => {
      throw new Error('Não foi possível carregar a origem da questão.');
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.id !== id || typeof result.hasOverride !== 'boolean') {
      throw new Error(result && result.error && result.error.message
        ? result.error.message
        : 'A API respondeu em um formato inesperado ao carregar a origem da questão.');
    }
    return result;
  }

  async function createQuestion(question) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(question)
      });
    } catch {
      throw new Error('Não foi possível conectar à API. Confirme se o backend está em execução e tente novamente.');
    }

    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok) {
      if (response.status === 400 && result && result.error && result.error.message) {
        throw new Error(result.error.message);
      }
      if (response.status === 404) {
        throw new Error('O endpoint de cadastro não foi encontrado. Confirme se o backend está atualizado.');
      }
      if (response.status >= 500) {
        throw new Error('O backend não conseguiu salvar a questão. Tente novamente mais tarde.');
      }
      throw new Error('Não foi possível adicionar a questão. Verifique os dados e tente novamente.');
    }

    if (!result || typeof result.id !== 'string' || !result.id) {
      throw new Error('O servidor respondeu em um formato inesperado. A questão pode não ter sido confirmada.');
    }
    return result;
  }

  async function importQuestions({ questions, confirm = false } = {}) {
    if (!Array.isArray(questions)) {
      throw new Error('Arquivo de questões inválido. O conteúdo deve ser uma lista de questões em JSON.');
    }

    let response;
    try {
      response = await fetch(`${endpoint}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions, confirm })
      });
    } catch {
      throw new Error('Não foi possível conectar à API. Confirme se o backend está em execução e tente novamente.');
    }

    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok) {
      if (response.status === 400 && result && result.error && result.error.message) {
        throw new Error(result.error.message);
      }
      if (response.status >= 500) {
        throw new Error('O backend não conseguiu processar a importação. Tente novamente mais tarde.');
      }
      throw new Error('Não foi possível importar o arquivo de questões. Verifique o formato e tente novamente.');
    }

    if (!result || typeof result !== 'object') {
      throw new Error('O servidor respondeu em um formato inesperado durante a importação.');
    }

    return result;
  }

  async function deleteQuestion(id) {
    let response;
    try {
      response = await fetch(`${endpoint}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      throw new Error('Não foi possível conectar à API. Confirme se o backend está em execução e tente novamente.');
    }

    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok) {
      if (response.status === 404) throw new Error('A questão não foi encontrada. Atualize o Banco de Questões e tente novamente.');
      if (response.status >= 500) throw new Error('O backend não conseguiu excluir a questão. Tente novamente mais tarde.');
      throw new Error('Não foi possível excluir a questão. Tente novamente.');
    }
    if (!result || result.id !== id) throw new Error('O servidor respondeu em um formato inesperado.');
    return result;
  }

  async function updateQuestion(id, question) {
    let response;
    try {
      response = await fetch(`${endpoint}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(question)
      });
    } catch {
      throw new Error('Não foi possível conectar à API. Confirme se o backend está em execução e tente novamente.');
    }

    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok) {
      if (response.status === 400 && result && result.error && result.error.message) throw new Error(result.error.message);
      if (response.status === 404) throw new Error('A questão não foi encontrada. Atualize o Banco de Questões e tente novamente.');
      if (response.status >= 500) throw new Error('O backend não conseguiu salvar as alterações. Tente novamente mais tarde.');
      throw new Error('Não foi possível salvar as alterações. Verifique os dados e tente novamente.');
    }
    if (!result || result.id !== id) throw new Error('O servidor respondeu em um formato inesperado.');
    return result;
  }

  async function restoreDefaultQuestion(id) {
    let response;
    try {
      response = await fetch(`${endpoint}/${encodeURIComponent(id)}/restore-default`, { method: 'POST' });
    } catch {
      throw new Error('Não foi possível conectar à API. Confirme se o backend está em execução e tente novamente.');
    }
    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    if (!response.ok) {
      throw new Error(result && result.error && result.error.message
        ? result.error.message
        : 'Não foi possível restaurar a versão padrão da questão.');
    }
    if (!result || result.id !== id) throw new Error('A API respondeu em um formato inesperado ao restaurar a questão.');
    return result;
  }

  async function requestBackup(path, payload, fallbackMessage) {
    let response;
    try {
      response = await fetch(`${backupEndpoint}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch {
      throw new Error('Não foi possível conectar à API. Confirme se o backend está em execução e tente novamente.');
    }

    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok) {
      const message = result && result.error && result.error.message;
      throw new Error(message || fallbackMessage);
    }
    if (!result || typeof result !== 'object') throw new Error('O servidor respondeu em um formato inesperado.');
    return result;
  }

  async function createBackup(progress) {
    return requestBackup('create', { progress }, 'Não foi possível criar o backup completo.');
  }

  async function validateBackup(backup) {
    return requestBackup('validate', { backup }, 'Não foi possível validar o backup.');
  }

  async function restoreBackup({ backup, currentProgress }) {
    return requestBackup('restore', { backup, currentProgress }, 'Não foi possível restaurar o backup.');
  }

  async function requestProgress(path = '', { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(`${progressEndpoint}${path}`, {
        method,
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
      });
    } catch {
      throw new Error('Não foi possível conectar à API de progresso. Verifique se o backend está funcionando.');
    }

    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    if (!response.ok) {
      throw new Error(result && result.error && result.error.message
        ? result.error.message
        : 'A API não conseguiu carregar ou salvar o progresso.');
    }
    if (!result || typeof result !== 'object') throw new Error('A API respondeu em um formato inesperado.');
    return result;
  }

  async function getProgress() {
    const result = await requestProgress();
    if (typeof result.exists !== 'boolean' || !result.progress || result.progress.version !== 1
      || (result.migration !== null && (!result.migration || typeof result.migration !== 'object'))) {
      throw new Error('A API respondeu em um formato inesperado ao carregar o progresso.');
    }
    return result;
  }

  async function saveProgress(progress) {
    const result = await requestProgress('', { method: 'PUT', body: { progress } });
    if (result.exists !== true || !result.progress || result.progress.version !== 1) {
      throw new Error('A API respondeu em um formato inesperado ao confirmar o progresso.');
    }
    return result;
  }

  async function previewProgressMigration(progress) {
    const result = await requestProgress('/migration/preview', { method: 'POST', body: { progress } });
    if (result.valid !== true || !result.summary || !result.backend || typeof result.backend.hasData !== 'boolean') {
      throw new Error('A API respondeu em um formato inesperado ao validar a migração.');
    }
    return result;
  }

  async function migrateProgress(progress, replaceExisting = false) {
    const result = await requestProgress('/migration', { method: 'POST', body: { progress, replaceExisting } });
    if (result.exists !== true || !result.progress || result.progress.version !== 1
      || !result.migration || result.migration.source !== 'localStorage' || !result.backups) {
      throw new Error('A API respondeu em um formato inesperado ao confirmar a migração.');
    }
    return result;
  }

  async function importProgress(progress) {
    const result = await requestProgress('/import', { method: 'POST', body: { progress } });
    if (result.exists !== true || !result.progress || result.progress.version !== 1 || !result.safetyBackup) {
      throw new Error('A API respondeu em um formato inesperado ao confirmar a importação.');
    }
    return result;
  }

  window.QuestionsApi = {
    getQuestions,
    getCatalogStatus,
    acknowledgeCatalogUpdate,
    getQuestionMetadata,
    createQuestion,
    importQuestions,
    deleteQuestion,
    updateQuestion,
    restoreDefaultQuestion,
    createBackup,
    validateBackup,
    restoreBackup,
    getProgress,
    saveProgress,
    previewProgressMigration,
    migrateProgress,
    importProgress
  };
})();