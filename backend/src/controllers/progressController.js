'use strict';

const progressStore = require('../data/progressStore');
const backupStore = require('../data/backupStore');
const { readQuestions } = require('../data/questionsStore');

function readProgressBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.progress) {
    throw new progressStore.ProgressError('INVALID_PROGRESS_REQUEST', 'Envie o progresso no campo "progress".');
  }
  return progressStore.validateProgress(body.progress);
}

async function validateSessionQuestionReferences(progress) {
  if (!progress.session) return;
  const questions = await readQuestions();
  const questionIds = new Set(questions.filter(question => question && typeof question.id === 'string').map(question => question.id));
  const missingId = progress.session.ids.find(id => !questionIds.has(id));
  if (missingId) {
    throw new progressStore.ProgressError('INVALID_PROGRESS_SESSION', `A sessão referencia uma questão ausente no banco atual: ${missingId}.`);
  }
}

async function getProgress(req, res) {
  res.json(await progressStore.readProgress());
}

async function updateProgress(req, res) {
  const progress = readProgressBody(req.body);
  await validateSessionQuestionReferences(progress);
  res.json(await progressStore.saveProgress(progress));
}

async function previewMigration(req, res) {
  const progress = readProgressBody(req.body);
  await validateSessionQuestionReferences(progress);
  const current = await progressStore.readProgress();
  res.json({
    valid: true,
    summary: progressStore.summarizeProgress(progress),
    backend: {
      exists: Boolean(current && current.exists),
      hasData: Boolean(current && current.hasData),
      migrationCompleted: Boolean(current && current.migration && current.migration.source === 'localStorage'),
      summary: current && current.progress ? progressStore.summarizeProgress(current.progress) : null
    }
  });
}

async function migrateProgress(req, res) {
  const progress = readProgressBody(req.body);
  await validateSessionQuestionReferences(progress);
  const replaceExisting = req.body.replaceExisting === true;
  const backups = {};
  const result = await progressStore.migrateProgress(progress, {
    replaceExisting,
    beforeWrite: async current => {
      const legacyBackup = await backupStore.createBackup(progress, { usePersistedProgress: false });
      backups.legacyBackup = await backupStore.writeUniqueBackup(legacyBackup, 'migration-legacy');
      if (current.hasData) {
        const currentBackup = await backupStore.createBackup(current.progress);
        backups.currentBackup = await backupStore.writeUniqueBackup(currentBackup, 'migration-current');
      }
    }
  });
  res.status(201).json({ ...result, backups });
}

async function importProgress(req, res) {
  const progress = readProgressBody(req.body);
  await validateSessionQuestionReferences(progress);
  const result = await progressStore.saveProgress(progress, {
    beforeWrite: async current => {
      const backup = await backupStore.createBackup(current.progress);
      return { safetyBackup: await backupStore.writeUniqueBackup(backup, 'safety-progress-import') };
    }
  });
  res.json(result);
}

module.exports = { getProgress, updateProgress, previewMigration, migrateProgress, importProgress };
