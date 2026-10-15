'use strict';

const {
  readUserData,
  writeUserData,
  addErrorBankQuestion,
  removeErrorBankQuestion,
  updatePreferences
} = require('../data/userDataStore');

async function getUserData(req, res) {
  res.json(await readUserData());
}

async function saveUserData(req, res) {
  const payload = await writeUserData(req.body || {});
  res.json(payload);
}

async function addToErrorBank(req, res) {
  const questionId = req.body && req.body.questionId ? req.body.questionId : req.params.id;
  const payload = await addErrorBankQuestion(questionId);
  res.status(200).json(payload);
}

async function removeFromErrorBank(req, res) {
  const questionId = req.params.id || (req.body && req.body.questionId);
  const payload = await removeErrorBankQuestion(questionId);
  res.status(200).json(payload);
}

async function setPreferences(req, res) {
  const payload = await updatePreferences(req.body || {});
  res.status(200).json(payload);
}

module.exports = { getUserData, saveUserData, addToErrorBank, removeFromErrorBank, setPreferences };
