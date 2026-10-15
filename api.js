'use strict';

(function () {
  const endpoint = 'http://127.0.0.1:3000/api/questions';
  const backupEndpoint = 'http://127.0.0.1:3000/api/backup';

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

  window.QuestionsApi = {
    getQuestions,
    createQuestion,
    importQuestions,
    deleteQuestion,
    updateQuestion,
    createBackup,
    validateBackup,
    restoreBackup
  };
})();