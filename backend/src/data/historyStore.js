'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJsonFile, writeJsonFile, ensureJsonFile, normalizeArray } = require('./storeUtils');

const defaultFile = path.resolve(__dirname, '../../../data/history.json');
const historyFile = process.env.HISTORY_FILE
  ? path.resolve(process.env.HISTORY_FILE)
  : defaultFile;

const defaultHistory = {
  version: 1,
  attempts: [],
  updatedAt: null,
  createdAt: null
};

function normalizeHistory(data) {
  const result = { ...defaultHistory, ...(data || {}) };
  result.version = 1;
  result.attempts = normalizeArray(result.attempts, []);
  result.updatedAt = result.updatedAt || new Date().toISOString();
  result.createdAt = result.createdAt || result.updatedAt;
  return result;
}

async function readHistory() {
  const data = await readJsonFile(historyFile, defaultHistory);
  return normalizeHistory(data);
}

function ensureHistoryFile() {
  return ensureJsonFile(historyFile, defaultHistory);
}

async function writeHistory(history) {
  const payload = normalizeHistory(history);
  payload.updatedAt = new Date().toISOString();
  payload.createdAt = payload.createdAt || payload.updatedAt;
  await writeJsonFile(historyFile, payload);
  return payload;
}

async function appendAttempt(attempt) {
  const history = await readHistory();
  const payload = { ...attempt };
  if (!payload.id) {
    payload.id = randomUUID();
  }

  history.attempts.push(payload);
  return writeHistory(history);
}

async function replaceAttempt(attemptId, attempt) {
  const history = await readHistory();
  const index = history.attempts.findIndex(entry => entry && entry.id === attemptId);
  if (index === -1) {
    return null;
  }

  history.attempts[index] = { ...history.attempts[index], ...attempt, id: attemptId };
  return writeHistory(history);
}

module.exports = {
  defaultHistory,
  defaultFile,
  historyFile,
  ensureHistoryFile,
  readHistory,
  writeHistory,
  appendAttempt,
  replaceAttempt
};
