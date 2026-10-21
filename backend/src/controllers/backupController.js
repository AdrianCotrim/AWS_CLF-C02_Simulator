'use strict';

const { createBackup, validateBackup, getSummary, restoreBackup, BackupError } = require('../data/backupStore');

function readBackupBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.backup) {
    throw new BackupError('INVALID_BACKUP_REQUEST', 'Envie o backup no campo "backup".');
  }
  return body.backup;
}

async function exportBackup(req, res) {
  const backup = await createBackup(req.body && req.body.progress, { usePersistedProgress: false });
  res.json(backup);
}

function validateBackupRequest(req, res) {
  const backup = readBackupBody(req.body);
  validateBackup(backup);
  res.json({ valid: true, summary: getSummary(backup) });
}

async function restoreBackupRequest(req, res) {
  const backup = readBackupBody(req.body);
  if (!req.body.currentProgress) {
    throw new BackupError('INVALID_CURRENT_PROGRESS', 'O progresso atual é necessário para criar um backup de segurança antes da restauração.');
  }
  const result = await restoreBackup(backup, req.body.currentProgress);
  res.json(result);
}

module.exports = { exportBackup, validateBackupRequest, restoreBackupRequest };
