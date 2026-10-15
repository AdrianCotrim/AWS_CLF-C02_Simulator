'use strict';

const {
  readQuestions,
  getQuestionById,
  addQuestion,
  deleteQuestion: removeQuestion,
  updateQuestion: saveQuestion
} = require('../data/questionsStore');

function normalizeQuestionText(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

function findDuplicateQuestions(questionText, existingQuestions, ignoredId = null) {
  const normalizedQuestion = normalizeQuestionText(questionText);
  if (!normalizedQuestion) return [];
  return existingQuestions.filter(question =>
    question &&
    question.id !== ignoredId &&
    typeof question.question === 'string' &&
    normalizeQuestionText(question.question) === normalizedQuestion
  );
}

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

function sanitizeImportedQuestion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  return Object.fromEntries(Object.entries(raw).filter(([field]) => allowedFields.has(field)));
}

function summarizeImportQuestions(rawQuestions, existingQuestions = []) {
  const questions = Array.isArray(rawQuestions) ? rawQuestions : [];
  const addable = [];
  const duplicateRecords = [];
  const invalidRecords = [];

  for (let index = 0; index < questions.length; index += 1) {
    const rawQuestion = questions[index];
    try {
      const sanitized = sanitizeImportedQuestion(rawQuestion);
      const question = validateQuestion(sanitized);
      const duplicates = findDuplicateQuestions(question.question, existingQuestions)
        .concat(addable.filter(item => normalizeQuestionText(item.question) === normalizeQuestionText(question.question)));

      if (duplicates.length) {
        duplicateRecords.push({
          index,
          question: question.question,
          duplicateIds: duplicates.map(item => item.id || 'unknown')
        });
        continue;
      }

      addable.push(question);
    } catch (error) {
      invalidRecords.push({
        index,
        reason: error && error.message ? error.message : 'Item inválido.'
      });
    }
  }

  return {
    total: questions.length,
    addable: addable.length,
    duplicates: duplicateRecords.length,
    invalid: invalidRecords.length,
    importable: addable.length,
    valid: addable.length,
    questions: addable,
    duplicateRecords,
    invalidRecords
  };
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

async function importQuestions(req, res) {
  const rawQuestions = Array.isArray(req.body)
    ? req.body
    : Array.isArray(req.body && req.body.questions)
      ? req.body.questions
      : null;

  if (!rawQuestions) {
    throw new ApiError(400, 'INVALID_IMPORT', 'O corpo deve conter um array de questões ou { questions: [...] }');
  }

  const existingQuestions = await readQuestions();
  const summary = summarizeImportQuestions(rawQuestions, existingQuestions);

  if (req.body && req.body.confirm !== true) {
    return res.json({
      ...summary,
      imported: 0,
      confirm: false,
      message: summary.addable ? 'Pré-visualização gerada. Revise os itens duplicados e inválidos antes de confirmar a importação.' : 'Nenhuma questão válida foi encontrada para importação.'
    });
  }

  if (!summary.questions.length) {
    return res.status(200).json({
      ...summary,
      imported: 0,
      confirm: true,
      message: 'Nenhuma questão válida foi encontrada para importar.'
    });
  }

  const importedQuestions = [];
  for (const question of summary.questions) {
    importedQuestions.push(await addQuestion(question));
  }

  return res.status(201).json({
    ...summary,
    imported: importedQuestions.length,
    confirm: true,
    questions: importedQuestions,
    message: `${importedQuestions.length} questão(ões) importada(s) com sucesso.`
  });
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

module.exports = {
  getQuestions,
  getQuestion,
  createQuestion,
  deleteQuestion,
  updateQuestion,
  importQuestions,
  summarizeImportQuestions,
  ApiError
};