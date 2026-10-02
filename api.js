'use strict';

(function () {
  const endpoint = 'http://localhost:3000/api/questions';

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

  window.QuestionsApi = { getQuestions, createQuestion, deleteQuestion };
})();