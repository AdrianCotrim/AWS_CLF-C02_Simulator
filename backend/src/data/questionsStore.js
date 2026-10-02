'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const defaultFile = path.resolve(__dirname, '../../../data/questions.json');
const questionsFile = process.env.QUESTIONS_FILE
  ? path.resolve(process.env.QUESTIONS_FILE)
  : defaultFile;

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

function generateNextId(questions) {
  const usedIds = new Set(questions.map(question => question && question.id).filter(id => typeof id === 'string'));
  let highest = 0;
  for (const id of usedIds) {
    const match = /^personal-(\d+)$/i.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }

  let next = highest + 1;
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
    const id = generateNextId(questions);
    if (questions.some(existing => existing && existing.id === id)) {
      throw new StoreError('DUPLICATE_QUESTION_ID', 'O ID gerado já existe no banco de questões.');
    }
    const created = { id, ...question };
    await writeQuestions([...questions, created]);
    return created;
  });

  writeQueue = operation.catch(() => {});
  return operation;
}

module.exports = { readQuestions, writeQuestions, getQuestionById, addQuestion };