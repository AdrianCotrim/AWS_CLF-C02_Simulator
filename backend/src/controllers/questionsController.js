'use strict';

const {
  readQuestions,
  getQuestionById,
  addQuestion
} = require('../data/questionsStore');

const allowedFields = new Set([
  'source',
  'tag',
  'question',
  'options',
  'correct_answer',
  'explanation'
]);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validateQuestion(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_QUESTION', 'O corpo deve ser um objeto JSON de questão.');
  }

  const unexpected = Object.keys(body).find(field => !allowedFields.has(field));
  if (unexpected) {
    throw new ApiError(400, 'INVALID_QUESTION', `Campo não permitido: ${unexpected}.`);
  }

  for (const field of allowedFields) {
    if (!(field in body)) {
      throw new ApiError(400, 'INVALID_QUESTION', `Campo obrigatório ausente: ${field}.`);
    }
    if (typeof body[field] !== 'string' && field !== 'options') {
      throw new ApiError(400, 'INVALID_QUESTION', `O campo ${field} deve ser texto.`);
    }
    if (!['options', 'explanation'].includes(field) && !body[field].trim()) {
      throw new ApiError(400, 'INVALID_QUESTION', `O campo ${field} não pode estar vazio.`);
    }
  }

  if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 26) {
    throw new ApiError(400, 'INVALID_QUESTION', 'options deve ser um array com 2 a 26 alternativas.');
  }

  const options = body.options.map(option => typeof option === 'string' ? option.trim() : '');
  if (options.some(option => !option)) {
    throw new ApiError(400, 'INVALID_QUESTION', 'Cada alternativa deve ser um texto não vazio.');
  }
  if (new Set(options.map(option => option.toLocaleLowerCase('pt-BR'))).size !== options.length) {
    throw new ApiError(400, 'INVALID_QUESTION', 'As alternativas não podem ser duplicadas.');
  }

  const answer = body.correct_answer.trim();
  const answerIndex = /^[A-Z]$/i.test(answer) ? answer.toUpperCase().charCodeAt(0) - 65 : -1;
  const answerIsLetter = answerIndex >= 0 && answerIndex < options.length;
  const answerText = options.find(option => option.toLocaleLowerCase('pt-BR') === answer.toLocaleLowerCase('pt-BR'));
  if (!answerIsLetter && !answerText) {
    throw new ApiError(400, 'INVALID_QUESTION', 'correct_answer deve corresponder à letra ou ao texto de uma alternativa.');
  }

  return {
    source: body.source.trim(),
    tag: body.tag.trim(),
    question: body.question.trim(),
    options,
    correct_answer: answerIsLetter ? answer.toUpperCase() : answerText,
    explanation: body.explanation.trim()
  };
}

async function getQuestions(req, res) {
  res.json(await readQuestions());
}

async function getQuestion(req, res) {
  const question = await getQuestionById(req.params.id);
  if (!question) {
    throw new ApiError(404, 'QUESTION_NOT_FOUND', `Nenhuma questão encontrada com o ID ${req.params.id}.`);
  }
  res.json(question);
}

async function createQuestion(req, res) {
  const question = await addQuestion(validateQuestion(req.body));
  res.status(201).json(question);
}

module.exports = { getQuestions, getQuestion, createQuestion, ApiError };