'use strict';

const path = require('node:path');
const { readJsonFile, writeJsonFile, normalizeArray } = require('./storeUtils');
const { readQuestions } = require('./questionsStore');

const defaultFile = path.resolve(__dirname, '../../../data/user-data.json');
const userDataFile = process.env.USER_DATA_FILE
  ? path.resolve(process.env.USER_DATA_FILE)
  : defaultFile;

const defaultUserData = {
  version: 1,
  personalQuestions: [],
  errorBank: [],
  preferences: {},
  updatedAt: null,
  createdAt: null
};

function normalizeUserData(data) {
  const result = { ...defaultUserData, ...(data || {}) };
  result.version = 1;
  result.personalQuestions = normalizeArray(result.personalQuestions, []);
  result.errorBank = normalizeArray(result.errorBank, []);
  result.preferences = result.preferences && typeof result.preferences === 'object' && !Array.isArray(result.preferences)
    ? result.preferences
    : {};
  result.errorBank = [...new Set(result.errorBank.filter(value => typeof value === 'string' && value.trim()))];
  result.personalQuestions = result.personalQuestions.filter(question =>
    question && typeof question === 'object' && typeof question.id === 'string'
  );
  result.updatedAt = result.updatedAt || new Date().toISOString();
  result.createdAt = result.createdAt || result.updatedAt;
  return result;
}

async function readUserData() {
  const data = await readJsonFile(userDataFile, defaultUserData);
  return normalizeUserData(data);
}

async function writeUserData(userData) {
  const payload = normalizeUserData(userData);
  payload.updatedAt = new Date().toISOString();
  payload.createdAt = payload.createdAt || payload.updatedAt;
  await writeJsonFile(userDataFile, payload);
  return payload;
}

async function ensureQuestionExists(questionId) {
  if (typeof questionId !== 'string' || !questionId.trim()) {
    return false;
  }

  const questions = await readQuestions();
  return questions.some(question => question && question.id === questionId.trim());
}

async function addPersonalQuestion(question) {
  if (!question || typeof question !== 'object' || typeof question.id !== 'string') {
    throw new Error('Questão pessoal inválida.');
  }

  const userData = await readUserData();
  if (!userData.personalQuestions.some(item => item && item.id === question.id)) {
    userData.personalQuestions.push({ ...question });
    await writeUserData(userData);
  }
  return await readUserData();
}

async function addErrorBankQuestion(questionId) {
  const normalizedId = typeof questionId === 'string' ? questionId.trim() : '';
  if (!normalizedId) {
    throw new Error('ID da questão inválido.');
  }

  const exists = await ensureQuestionExists(normalizedId);
  if (!exists) {
    throw new Error(`A questão ${normalizedId} não foi encontrada no banco principal.`);
  }

  const userData = await readUserData();
  if (!userData.errorBank.includes(normalizedId)) {
    userData.errorBank.push(normalizedId);
    await writeUserData(userData);
  }

  return await readUserData();
}

async function removeErrorBankQuestion(questionId) {
  const normalizedId = typeof questionId === 'string' ? questionId.trim() : '';
  if (!normalizedId) {
    throw new Error('ID da questão inválido.');
  }

  const userData = await readUserData();
  userData.errorBank = userData.errorBank.filter(id => id !== normalizedId);
  await writeUserData(userData);
  return await readUserData();
}

async function updatePreferences(preferences) {
  const userData = await readUserData();
  userData.preferences = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? { ...userData.preferences, ...preferences }
    : userData.preferences;
  await writeUserData(userData);
  return await readUserData();
}

module.exports = {
  defaultUserData,
  defaultFile,
  userDataFile,
  readUserData,
  writeUserData,
  addPersonalQuestion,
  addErrorBankQuestion,
  removeErrorBankQuestion,
  updatePreferences,
  ensureQuestionExists
};
