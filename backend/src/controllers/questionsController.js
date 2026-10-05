'use strict';

const {
  readQuestions,
  getQuestionById,
  addQuestion,
  deleteQuestion: removeQuestion,
  updateQuestion: saveQuestion
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
    if (typeof body[field] !== 'string' && !['options', 'correct_answer'].includes(field)) {
      throw new ApiError(400, 'INVALID_QUESTION', `O campo ${field} deve ser texto.`);
    }
    if (!['options', 'explanation', 'correct_answer'].includes(field) && !body[field].trim()) {
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

  const isMultipleAnswer = Array.isArray(body.correct_answer);
  const submittedAnswers = isMultipleAnswer ? body.correct_answer : [body.correct_answer];
  if (!submittedAnswers.length || submittedAnswers.length > options.length) {
    throw new ApiError(400, 'INVALID_QUESTION', 'correct_answer deve conter pelo menos uma resposta e não pode exceder o número de alternativas.');
  }

  const correctAnswers = submittedAnswers.map(answer => {
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new ApiError(400, 'INVALID_QUESTION', 'Cada resposta correta deve ser um texto não vazio.');
    }
    const normalizedAnswer = answer.trim();
    const answerIndex = /^[A-Z]$/i.test(normalizedAnswer) ? normalizedAnswer.toUpperCase().charCodeAt(0) - 65 : -1;
    if (answerIndex >= 0 && answerIndex < options.length) return String.fromCharCode(65 + answerIndex);
    const optionIndex = options.findIndex(option => option.toLocaleLowerCase('pt-BR') === normalizedAnswer.toLocaleLowerCase('pt-BR'));
    if (optionIndex >= 0) return String.fromCharCode(65 + optionIndex);
    throw new ApiError(400, 'INVALID_QUESTION', 'correct_answer deve corresponder à letra ou ao texto de uma alternativa.');
  });
  if (new Set(correctAnswers).size !== correctAnswers.length) {
    throw new ApiError(400, 'INVALID_QUESTION', 'As respostas corretas não podem ser duplicadas.');
  }
  const singleAnswer = typeof body.correct_answer === 'string' ? body.correct_answer.trim() : '';
  const singleAnswerIndex = /^[A-Z]$/i.test(singleAnswer) ? singleAnswer.toUpperCase().charCodeAt(0) - 65 : -1;
  const singleAnswerText = options.find(option => option.toLocaleLowerCase('pt-BR') === singleAnswer.toLocaleLowerCase('pt-BR'));

  return {
    source: body.source.trim(),
    tag: body.tag.trim(),
    question: body.question.trim(),
    options,
    correct_answer: isMultipleAnswer
      ? correctAnswers
      : singleAnswerIndex >= 0 && singleAnswerIndex < options.length ? correctAnswers[0] : singleAnswerText,
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

async function deleteQuestion(req, res) {
  const deleted = await removeQuestion(req.params.id);
  if (!deleted) {
    throw new ApiError(404, 'QUESTION_NOT_FOUND', `Nenhuma questão encontrada com o ID ${req.params.id}.`);
  }
  res.json({ id: deleted.id, message: 'Questão excluída.' });
}

async function updateQuestion(req, res) {
  const updated = await saveQuestion(req.params.id, validateQuestion(req.body));
  if (!updated) {
    throw new ApiError(404, 'QUESTION_NOT_FOUND', `Nenhuma questão encontrada com o ID ${req.params.id}.`);
  }
  res.json(updated);
}

module.exports = { getQuestions, getQuestion, createQuestion, deleteQuestion, updateQuestion, ApiError };