'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const progressFile = process.env.PROGRESS_FILE
  ? path.resolve(process.env.PROGRESS_FILE)
  : path.resolve(__dirname, '../../../data/progress.json');

const emptyProgress = {
  version: 1,
  questionProgress: {},
  history: [],
  session: null
};

class ProgressError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

function validateProgress(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)
    || progress.version !== 1
    || !progress.questionProgress || typeof progress.questionProgress !== 'object' || Array.isArray(progress.questionProgress)
    || !Array.isArray(progress.history)
    || (progress.errorBank !== undefined && !Array.isArray(progress.errorBank))
    || (progress.statistics !== undefined && (!progress.statistics || typeof progress.statistics !== 'object' || Array.isArray(progress.statistics)))
    || (progress.session !== null && (!progress.session || typeof progress.session !== 'object' || Array.isArray(progress.session)
      || progress.session.persist !== true || progress.session.done === true
      || !Array.isArray(progress.session.ids) || !progress.session.ids.length
      || progress.session.ids.some(id => typeof id !== 'string' || !id)
      || !Number.isInteger(progress.session.idx) || progress.session.idx < 0 || progress.session.idx >= progress.session.ids.length
      || !progress.session.answers || typeof progress.session.answers !== 'object' || Array.isArray(progress.session.answers)))) {
    throw new ProgressError('INVALID_PROGRESS', 'O progresso está ausente ou possui uma estrutura inválida.');
  }

  for (const [id, entry] of Object.entries(progress.questionProgress)) {
    if (!id || !entry || typeof entry !== 'object' || Array.isArray(entry)
      || (entry.timesAnswered !== undefined && (!Number.isSafeInteger(entry.timesAnswered) || entry.timesAnswered < 0))
      || (entry.timesWrong !== undefined && (!Number.isSafeInteger(entry.timesWrong) || entry.timesWrong < 0))
      || (entry.inErrorBank !== undefined && typeof entry.inErrorBank !== 'boolean')
      || (entry.lastCorrect !== undefined && typeof entry.lastCorrect !== 'boolean')) {
      throw new ProgressError('INVALID_PROGRESS', `O progresso da questão ${id || '(sem ID)'} é inválido.`);
    }
  }

  for (const [index, entry] of progress.history.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProgressError('INVALID_PROGRESS', `O registro ${index + 1} do histórico é inválido.`);
    }
  }
  return progress;
}

function hasMeaningfulProgress(progress) {
  return Object.keys(progress.questionProgress).length > 0
    || progress.history.length > 0
    || Boolean(progress.session && !progress.session.done);
}

function normalizeDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || document.version !== 1) {
    throw new ProgressError('PROGRESS_FILE_INVALID', 'O arquivo de progresso está inválido ou usa uma versão incompatível.', 500);
  }
  validateProgress(document.progress);
  if (document.migration !== null && (!document.migration || typeof document.migration !== 'object'
    || typeof document.migration.source !== 'string' || typeof document.migration.completedAt !== 'string')) {
    throw new ProgressError('PROGRESS_FILE_INVALID', 'Os metadados da migração do progresso estão inválidos.', 500);
  }
  return document;
}

async function readDocument() {
  let raw;
  try {
    raw = await fs.readFile(progressFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false, document: { version: 1, progress: structuredClone(emptyProgress), migration: null }, raw: null };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProgressError('PROGRESS_FILE_INVALID', 'O arquivo de progresso contém JSON inválido.', 500);
  }
  return { exists: true, document: normalizeDocument(parsed), raw };
}

async function readProgress() {
  const record = await readDocument();
  return {
    exists: record.exists,
    hasData: record.exists && hasMeaningfulProgress(record.document.progress),
    migration: record.document.migration,
    progress: record.document.progress
  };
}

async function writeDocument(document) {
  const normalized = normalizeDocument(document);
  const directory = path.dirname(progressFile);
  await fs.mkdir(directory, { recursive: true });
  const temporaryFile = `${progressFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporaryFile, progressFile);
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
  return normalized;
}

async function rollbackDocument(raw) {
  if (raw === null) {
    await fs.rm(progressFile, { force: true });
    return;
  }
  const rollbackFile = `${progressFile}.${process.pid}.${randomUUID()}.rollback`;
  try {
    await fs.writeFile(rollbackFile, raw, { flag: 'wx' });
    await fs.rename(rollbackFile, progressFile);
  } catch (error) {
    await fs.rm(rollbackFile, { force: true }).catch(() => {});
    throw error;
  }
}

let writeQueue = Promise.resolve();

function enqueue(operation) {
  const result = writeQueue.then(operation);
  writeQueue = result.catch(() => {});
  return result;
}

function saveProgress(progress, { beforeWrite } = {}) {
  const validated = validateProgress(progress);
  const snapshot = structuredClone(validated);
  return enqueue(async () => {
    const current = await readDocument();
    const metadata = beforeWrite
      ? await beforeWrite({
        exists: current.exists,
        hasData: current.exists && hasMeaningfulProgress(current.document.progress),
        progress: current.document.progress,
        migration: current.document.migration
      })
      : {};
    const document = {
      version: 1,
      progress: snapshot,
      migration: current.document.migration
    };
    try {
      await writeDocument(document);
      const persisted = await readDocument();
      if (JSON.stringify(persisted.document.progress) !== JSON.stringify(snapshot)) {
        throw new ProgressError('PROGRESS_VERIFY_FAILED', 'A gravação do progresso não passou pela verificação final.', 500);
      }
      return {
        exists: true,
        hasData: hasMeaningfulProgress(persisted.document.progress),
        migration: persisted.document.migration,
        progress: persisted.document.progress,
        ...metadata
      };
    } catch (error) {
      try {
        await rollbackDocument(current.raw);
      } catch (rollbackError) {
        throw new ProgressError('PROGRESS_ROLLBACK_FAILED', `A gravação falhou e o estado anterior não pôde ser recuperado: ${rollbackError.message}`, 500);
      }
      throw error;
    }
  });
}

function summarizeProgress(progress) {
  return {
    progressEntries: Object.keys(progress.questionProgress).length,
    responseHistory: progress.history.length,
    errorBankEntries: Array.isArray(progress.errorBank)
      ? progress.errorBank.length
      : Object.values(progress.questionProgress).filter(entry => entry && entry.inErrorBank).length,
    hasActiveSession: Boolean(progress.session && !progress.session.done),
    sessionQuestionCount: progress.session && Array.isArray(progress.session.ids) ? progress.session.ids.length : 0
  };
}

function migrateProgress(progress, { replaceExisting = false, beforeWrite } = {}) {
  const validated = validateProgress(progress);
  const snapshot = structuredClone(validated);
  return enqueue(async () => {
    const current = await readDocument();
    if (current.document.migration && current.document.migration.source === 'localStorage') {
      throw new ProgressError('MIGRATION_ALREADY_COMPLETED', 'A migração do LocalStorage já foi concluída.', 409);
    }
    if (current.exists && hasMeaningfulProgress(current.document.progress) && !replaceExisting) {
      throw new ProgressError('PROGRESS_ALREADY_EXISTS', 'Já existem dados de progresso no backend; eles não foram substituídos.', 409);
    }

    if (beforeWrite) await beforeWrite({
      exists: current.exists,
      hasData: current.exists && hasMeaningfulProgress(current.document.progress),
      progress: current.document.progress,
      migration: current.document.migration
    });

    const nextDocument = {
      version: 1,
      progress: snapshot,
      migration: {
        source: 'localStorage',
        completedAt: new Date().toISOString(),
        legacyExportedAt: typeof progress.exportedAt === 'string' ? progress.exportedAt : null
      }
    };

    try {
      await writeDocument(nextDocument);
      const persisted = await readDocument();
      if (JSON.stringify(persisted.document.progress) !== JSON.stringify(snapshot)
        || persisted.document.migration.source !== 'localStorage'
        || persisted.document.migration.completedAt !== nextDocument.migration.completedAt) {
        throw new ProgressError('PROGRESS_VERIFY_FAILED', 'A migração não passou pela verificação final.', 500);
      }
      return {
        exists: true,
        hasData: hasMeaningfulProgress(persisted.document.progress),
        migration: persisted.document.migration,
        progress: persisted.document.progress
      };
    } catch (error) {
      try {
        await rollbackDocument(current.raw);
      } catch (rollbackError) {
        throw new ProgressError('PROGRESS_ROLLBACK_FAILED', `A migração falhou e o estado anterior não pôde ser recuperado: ${rollbackError.message}`, 500);
      }
      throw error;
    }
  });
}

module.exports = {
  progressFile,
  emptyProgress,
  ProgressError,
  validateProgress,
  hasMeaningfulProgress,
  summarizeProgress,
  readProgress,
  saveProgress,
  migrateProgress,
  runExclusive: enqueue,
  createDocument: (progress, migration = null) => normalizeDocument({ version: 1, progress, migration })
};
