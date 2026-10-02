'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const defaultFile = path.resolve(__dirname, '../../../data/questions.json');
const questionsFile = process.env.QUESTIONS_FILE
  ? path.resolve(process.env.QUESTIONS_FILE)
  : defaultFile;
const idSequenceFile = `${questionsFile}.sequence.json`;

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function readQuestions() {
  let contents;
  try {
    contents = await fs.readFile(questionsFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new StoreError('QUESTIONS_FILE_NOT_FOUND', 'O arquivo do banco de questões não foi encontrado.');
    }
    throw new StoreError('QUESTIONS_READ_FAILED', 'Não foi possível ler o banco de questões.');
  }

  let questions;
  try {
    questions = JSON.parse(contents);
  } catch {
    throw new StoreError('QUESTIONS_FILE_INVALID', 'O arquivo do banco de questões contém JSON inválido.');
  }
  if (!Array.isArray(questions)) {
    throw new StoreError('QUESTIONS_FILE_INVALID', 'O banco de questões deve ser um array JSON.');
  }
  return questions;
}

async function writeQuestions(questions) {
  if (!Array.isArray(questions)) {
    throw new StoreError('QUESTIONS_FILE_INVALID', 'O banco de questões deve ser um array JSON.');
  }

  const temporaryFile = `${questionsFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(questions, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporaryFile, questionsFile);
  } catch {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    throw new StoreError('QUESTIONS_WRITE_FAILED', 'Não foi possível salvar o banco de questões.');
  }
}

async function getQuestionById(id) {
  const questions = await readQuestions();
  return questions.find(question => question && question.id === id) || null;
}

function highestPersonalId(questions) {
  let highest = 0;
  for (const question of questions) {
    const id = question && question.id;
    if (typeof id !== 'string') continue;
    const match = /^personal-(\d+)$/i.exec(id);
    const value = match ? Number(match[1]) : 0;
    if (Number.isSafeInteger(value)) highest = Math.max(highest, value);
  }
  return highest;
}

async function readIdHighWaterMark(questions) {
  let stored;
  try {
    stored = JSON.parse(await fs.readFile(idSequenceFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return highestPersonalId(questions);
    throw new StoreError('QUESTION_ID_SEQUENCE_INVALID', 'Não foi possível ler a sequência de IDs.');
  }
  if (!stored || !Number.isSafeInteger(stored.lastIssued) || stored.lastIssued < 0) {
    throw new StoreError('QUESTION_ID_SEQUENCE_INVALID', 'A sequência de IDs está inválida.');
  }
  return Math.max(highestPersonalId(questions), stored.lastIssued);
}

async function writeIdHighWaterMark(lastIssued) {
  const temporaryFile = `${idSequenceFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify({ lastIssued }, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporaryFile, idSequenceFile);
  } catch {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    throw new StoreError('QUESTIONS_WRITE_FAILED', 'Não foi possível salvar a sequência de IDs.');
  }
}

function generateNextId(questions, highWaterMark) {
  const usedIds = new Set(questions.map(question => question && question.id).filter(id => typeof id === 'string'));

  let next = Math.max(highestPersonalId(questions), highWaterMark) + 1;
  let id = `personal-${String(next).padStart(3, '0')}`;
  while (usedIds.has(id)) {
    next++;
    id = `personal-${String(next).padStart(3, '0')}`;
  }
  return id;
}

let writeQueue = Promise.resolve();

function addQuestion(question) {
  const operation = writeQueue.then(async () => {
    const questions = await readQuestions();
    const highWaterMark = await readIdHighWaterMark(questions);
    const id = generateNextId(questions, highWaterMark);
    if (questions.some(existing => existing && existing.id === id)) {
      throw new StoreError('DUPLICATE_QUESTION_ID', 'O ID gerado já existe no banco de questões.');
    }
    await writeIdHighWaterMark(Number(id.slice('personal-'.length)));
    const created = { id, ...question };
    await writeQuestions([...questions, created]);
    return created;
  });

  writeQueue = operation.catch(() => {});
  return operation;
}

function deleteQuestion(id) {
  const operation = writeQueue.then(async () => {
    const questions = await readQuestions();
    const index = questions.findIndex(question => question && question.id === id);
    if (index === -1) return null;

    const highWaterMark = await readIdHighWaterMark(questions);
    await writeIdHighWaterMark(highWaterMark);
    const [deleted] = questions.splice(index, 1);
    await writeQuestions(questions);
    return deleted;
  });

  writeQueue = operation.catch(() => {});
  return operation;
}

module.exports = { readQuestions, writeQuestions, getQuestionById, addQuestion, deleteQuestion };