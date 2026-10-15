'use strict';

const { readHistory, appendAttempt, replaceAttempt } = require('../data/historyStore');

async function getHistory(req, res) {
  res.json(await readHistory());
}

async function addAttempt(req, res) {
  const attempt = await appendAttempt(req.body || {});
  res.status(201).json(attempt);
}

async function updateAttempt(req, res) {
  const attempt = await replaceAttempt(req.params.id, req.body || {});
  if (!attempt) {
    res.status(404).json({ error: { code: 'ATTEMPT_NOT_FOUND', message: 'Tentativa não encontrada.' } });
    return;
  }
  res.json(attempt);
}

module.exports = { getHistory, addAttempt, updateAttempt };
