'use strict';

const storeMessages = {
  QUESTIONS_FILE_NOT_FOUND: 'O arquivo do banco de questões não foi encontrado.',
  QUESTIONS_FILE_INVALID: 'O arquivo do banco de questões está inválido ou corrompido.',
  QUESTIONS_READ_FAILED: 'Não foi possível ler o banco de questões.',
  QUESTIONS_WRITE_FAILED: 'Não foi possível salvar o banco de questões.',
  QUESTION_ID_SEQUENCE_INVALID: 'A sequência de IDs está inválida.',
  DUPLICATE_QUESTION_ID: 'O ID gerado já existe no banco de questões.'
};

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'O corpo da requisição contém JSON inválido.' } });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'O corpo da requisição excede o limite permitido.' } });
  }

  const status = error.status || (error.code === 'DUPLICATE_QUESTION_ID' ? 409 : 500);
  const code = error.code || 'INTERNAL_ERROR';
  const message = error.message && status < 500
    ? error.message
    : storeMessages[code] || 'Ocorreu um erro interno inesperado.';

  if (status >= 500) console.error(error);
  res.status(status).json({ error: { code, message } });
}

module.exports = { errorHandler };