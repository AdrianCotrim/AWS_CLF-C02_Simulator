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

function normalizeOptionalText(field, value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_QUESTION', `O campo ${field} deve ser texto.`);
  }

  const trimmed = value.trim();
  if (field === 'explanation') return trimmed;
  return trimmed || fallback;
}

function normalizeOptions(options) {
  if (!Array.isArray(options) || options.length < 2 || options.length > 26) {
    throw new ApiError(400, 'INVALID_QUESTION', 'options deve ser um array com 2 a 26 alternativas.');
  }

  const normalized = options.map(option => typeof option === 'string' ? option.trim() : '');
  if (normalized.some(option => !option)) {
    throw new ApiError(400, 'INVALID_QUESTION', 'Cada alternativa deve ser um texto não vazio.');
  }
  if (new Set(normalized.map(option => option.toLocaleLowerCase('pt-BR'))).size !== normalized.length) {
    throw new ApiError(400, 'INVALID_QUESTION', 'As alternativas não podem ser duplicadas.');
  }

  return normalized;
}

function normalizeCorrectAnswer(options, correctAnswer) {
  const isMultipleAnswer = Array.isArray(correctAnswer);
  const submittedAnswers = isMultipleAnswer ? correctAnswer : [correctAnswer];

  if (!submittedAnswers.length || submittedAnswers.length > options.length) {
    throw new ApiError(400, 'INVALID_QUESTION', 'correct_answer deve conter pelo menos uma resposta e não pode exceder o número de alternativas.');
  }

  const normalizedAnswers = submittedAnswers.map(answer => {
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new ApiError(400, 'INVALID_QUESTION', 'Cada resposta correta deve ser um texto não vazio.');
    }

    const trimmedAnswer = answer.trim();
    const letterIndex = /^[A-Z]$/i.test(trimmedAnswer) ? trimmedAnswer.toUpperCase().charCodeAt(0) - 65 : -1;
    if (letterIndex >= 0 && letterIndex < options.length) {
      return String.fromCharCode(65 + letterIndex);
    }

    const optionIndex = options.findIndex(option => option.toLocaleLowerCase('pt-BR') === trimmedAnswer.toLocaleLowerCase('pt-BR'));
    if (optionIndex >= 0) {
      return String.fromCharCode(65 + optionIndex);
    }

    throw new ApiError(400, 'INVALID_QUESTION', 'correct_answer deve corresponder à letra ou ao texto de uma alternativa.');
  });

  if (new Set(normalizedAnswers).size !== normalizedAnswers.length) {
    throw new ApiError(400, 'INVALID_QUESTION', 'As respostas corretas não podem ser duplicadas.');
  }

  return isMultipleAnswer ? normalizedAnswers : normalizedAnswers[0];
}

function validateQuestion(body, { allowPartial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_QUESTION', 'O corpo deve ser um objeto JSON de questão.');
  }

  const unexpected = Object.keys(body).find(field => !allowedFields.has(field));
  if (unexpected) {
    throw new ApiError(400, 'INVALID_QUESTION', `Campo não permitido: ${unexpected}.`);
  }

  const normalized = {};

  if (body.source !== undefined || !allowPartial) {
    normalized.source = normalizeOptionalText('source', body.source, 'Personal');
  }

  if (body.tag !== undefined || !allowPartial) {
    normalized.tag = normalizeOptionalText('tag', body.tag, 'Conceitos de nuvem');
  }

  if (body.question !== undefined || !allowPartial) {
    if (typeof body.question !== 'string' || !body.question.trim()) {
      throw new ApiError(400, 'INVALID_QUESTION', 'O campo question não pode estar vazio.');
    }
    normalized.question = body.question.trim();
  }

  if (body.options !== undefined || !allowPartial) {
    if (body.options === undefined) {
      throw new ApiError(400, 'INVALID_QUESTION', 'Campo obrigatório ausente: options.');
    }
    normalized.options = normalizeOptions(body.options);
  }

  if (body.explanation !== undefined || !allowPartial) {
    normalized.explanation = normalizeOptionalText('explanation', body.explanation, '');
  }

  if (body.correct_answer !== undefined || !allowPartial) {
    if (body.correct_answer === undefined) {
      throw new ApiError(400, 'INVALID_QUESTION', 'Campo obrigatório ausente: correct_answer.');
    }
    if (!normalized.options) {
      throw new ApiError(400, 'INVALID_QUESTION', 'Campo obrigatório ausente: options.');
    }
    normalized.correct_answer = normalizeCorrectAnswer(normalized.options, body.correct_answer);
  }

  return normalized;
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
  const currentQuestion = await getQuestionById(req.params.id);
  if (!currentQuestion) {
    throw new ApiError(404, 'QUESTION_NOT_FOUND', `Nenhuma questão encontrada com o ID ${req.params.id}.`);
  }

  const validated = validateQuestion(req.body, { allowPartial: true });
  const mergedQuestion = { ...currentQuestion, ...validated, id: currentQuestion.id };
  if (!mergedQuestion.source || !mergedQuestion.source.trim()) mergedQuestion.source = 'Personal';
  if (!mergedQuestion.tag || !mergedQuestion.tag.trim()) mergedQuestion.tag = 'Conceitos de nuvem';
  if (mergedQuestion.explanation === undefined) mergedQuestion.explanation = '';

  const updated = await saveQuestion(req.params.id, mergedQuestion);
  if (!updated) {
    throw new ApiError(404, 'QUESTION_NOT_FOUND', `Nenhuma questão encontrada com o ID ${req.params.id}.`);
  }
  res.json(updated);
}

module.exports = { getQuestions, getQuestion, createQuestion, deleteQuestion, updateQuestion, ApiError };