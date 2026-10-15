'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const questionStore = require('./questionsStore');
const userDataStore = require('./userDataStore');
const historyStore = require('./historyStore');
const progressStore = require('./progressStore');

const FORMAT = 'aws-clf-c02-backup';
const VERSION = 2;
const legacyComponentNames = ['questions', 'questionSequence', 'userData', 'history', 'progress'];
const componentNames = [...legacyComponentNames, 'catalog', 'questionChanges'];
const backupDirectory = process.env.BACKUP_DIRECTORY
  ? path.resolve(process.env.BACKUP_DIRECTORY)
  : path.resolve(__dirname, '../../../data/backups');

class BackupError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createBundle(data) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    includes: componentNames,
    data,
    checksums: Object.fromEntries(componentNames.map(name => [name, hash(data[name])]))
  };
}

function validateQuestionBank(questions) {
  if (!Array.isArray(questions)) {
    throw new BackupError('INVALID_BACKUP_QUESTIONS', 'O banco de questões do backup deve ser uma lista.');
  }

  const ids = new Set();
  for (const question of questions) {
    if (!question || typeof question !== 'object' || Array.isArray(question)
      || typeof question.id !== 'string' || !question.id.trim()
      || typeof question.question !== 'string' || !question.question.trim()) {
      throw new BackupError('INVALID_BACKUP_QUESTIONS', 'O backup contém uma questão sem ID ou enunciado válido.');
    }
    if (ids.has(question.id)) {
      throw new BackupError('INVALID_BACKUP_QUESTIONS', `O backup contém o ID de questão duplicado ${question.id}.`);
    }
    ids.add(question.id);

    const options = Array.isArray(question.options)
      ? question.options
      : question.options && typeof question.options === 'object' && !Array.isArray(question.options)
        ? Object.values(question.options)
        : [];
    const answers = Array.isArray(question.correct_answer)
      ? question.correct_answer
      : typeof question.correct_answer === 'string' ? [question.correct_answer] : [];
    if (options.length < 2 || options.some(option => typeof option !== 'string' || !option.trim())
      || !answers.length || answers.some(answer => typeof answer !== 'string' || !answer.trim())) {
      throw new BackupError('INVALID_BACKUP_QUESTIONS', `A questão ${question.id} possui alternativas ou respostas inválidas.`);
    }
  }

  return questions;
}

function validateUserData(userData) {
  if (!userData || typeof userData !== 'object' || Array.isArray(userData)
    || userData.version !== 1 || !Array.isArray(userData.personalQuestions)
    || !Array.isArray(userData.errorBank)
    || userData.errorBank.some(id => typeof id !== 'string')
    || !userData.preferences || typeof userData.preferences !== 'object' || Array.isArray(userData.preferences)) {
    throw new BackupError('INVALID_BACKUP_USER_DATA', 'Os dados do usuário do backup estão ausentes ou inválidos.');
  }
  return userData;
}

function validateHistory(history) {
  if (!history || typeof history !== 'object' || Array.isArray(history)
    || history.version !== 1 || !Array.isArray(history.attempts)) {
    throw new BackupError('INVALID_BACKUP_HISTORY', 'O histórico do backup está ausente ou inválido.');
  }
  return history;
}

function validateProgress(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)
    || progress.version !== 1
    || !progress.questionProgress || typeof progress.questionProgress !== 'object' || Array.isArray(progress.questionProgress)
    || !Array.isArray(progress.history)
    || (progress.session !== null && (!progress.session || typeof progress.session !== 'object' || Array.isArray(progress.session)
      || progress.session.persist !== true || progress.session.done === true
      || !Array.isArray(progress.session.ids) || !Number.isInteger(progress.session.idx)
      || progress.session.idx < 0 || progress.session.idx >= progress.session.ids.length
      || !progress.session.answers || typeof progress.session.answers !== 'object' || Array.isArray(progress.session.answers)))) {
    throw new BackupError('INVALID_BACKUP_PROGRESS', 'O progresso do frontend está ausente ou inválido.');
  }
  return progress;
}

function validateBackup(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)
    || backup.format !== FORMAT || ![1, VERSION].includes(backup.version)) {
    throw new BackupError('UNSUPPORTED_BACKUP_VERSION', 'O formato ou a versão deste backup não é compatível.');
  }
  const expectedComponents = backup.version === 1 ? legacyComponentNames : componentNames;
  if (typeof backup.exportedAt !== 'string' || !Number.isFinite(Date.parse(backup.exportedAt))
    || !Array.isArray(backup.includes)
    || JSON.stringify(backup.includes) !== JSON.stringify(expectedComponents)
    || !backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)
    || !backup.checksums || typeof backup.checksums !== 'object' || Array.isArray(backup.checksums)) {
    throw new BackupError('INVALID_BACKUP_MANIFEST', 'O manifesto do backup está incompleto ou inválido.');
  }
  const data = backup.data;
  validateQuestionBank(data.questions);
  if (!data.questionSequence || !Number.isSafeInteger(data.questionSequence.lastIssued) || data.questionSequence.lastIssued < 0) {
    throw new BackupError('INVALID_BACKUP_SEQUENCE', 'A sequência de IDs do backup está ausente ou inválida.');
  }
  const highestPersonalId = data.questions.reduce((highest, question) => {
    const match = /^(?:personal|local)-(\d+)$/i.exec(question.id);
    const value = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(value) ? Math.max(highest, value) : highest;
  }, 0);
  if (data.questionSequence.lastIssued < highestPersonalId) {
    throw new BackupError('INVALID_BACKUP_SEQUENCE', 'A sequência de IDs é menor que o maior ID pessoal existente no backup.');
  }

  validateUserData(data.userData);
  validateHistory(data.history);
  validateProgress(data.progress);
  if (data.progress.session && data.progress.session.ids.some(id =>
    typeof id !== 'string' || !data.questions.some(question => question.id === id))) {
    throw new BackupError('INVALID_BACKUP_PROGRESS', 'A sessão salva referencia questões ausentes no banco do backup.');
  }

  for (const name of expectedComponents) {
    if (typeof backup.checksums[name] !== 'string' || backup.checksums[name] !== hash(data[name])) {
      throw new BackupError('BACKUP_CHECKSUM_MISMATCH', `A verificação de integridade falhou para ${name}.`);
    }
  }

  if (backup.version === VERSION) {
    questionStore.validateCatalog(data.catalog);
    questionStore.validateLocalChanges(data.questionChanges);
    let composed;
    try {
      composed = questionStore.composeQuestions(data.catalog, data.questionChanges);
    } catch (error) {
      throw new BackupError('INVALID_BACKUP_QUESTION_LAYERS', error.message);
    }
    if (JSON.stringify(composed) !== JSON.stringify(data.questions)) {
      throw new BackupError('INVALID_BACKUP_QUESTION_LAYERS', 'As questões efetivas não correspondem ao catálogo e às alterações locais do backup.');
    }
  }

  return backup;
}

function getSummary(backup) {
  const { data } = backup;
  return {
    exportedAt: backup.exportedAt,
    questions: data.questions.length,
    sequenceLastIssued: data.questionSequence.lastIssued,
    personalQuestions: data.userData.personalQuestions.length,
    errorBank: data.userData.errorBank.length,
    storedAttempts: data.history.attempts.length,
    progressEntries: Object.keys(data.progress.questionProgress).length,
    responseHistory: data.progress.history.length,
    hasActiveSession: Boolean(data.progress.session && !data.progress.session.done)
  };
}

async function readRequiredJson(filePath, label) {
  let contents;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new BackupError('BACKUP_SOURCE_MISSING', `Não foi possível criar o backup: o arquivo ${label} está ausente.`, 500);
    }
    throw error;
  }

  try {
    return JSON.parse(contents);
  } catch {
    throw new BackupError('BACKUP_SOURCE_INVALID', `Não foi possível criar o backup: o arquivo ${label} contém JSON inválido.`, 500);
  }
}

async function readCurrentData(progress, { usePersistedProgress = true } = {}) {
  const layers = await questionStore.readQuestionLayers();
  const questionChanges = layers.initialized
    ? layers.changes
    : questionStore.emptyLocalChanges(layers.catalog, true);
  const questions = layers.questions;
  const userData = await readRequiredJson(userDataStore.userDataFile, 'user-data.json');
  const history = await readRequiredJson(historyStore.historyFile, 'history.json');
  const questionSequence = { lastIssued: await questionStore.readIdHighWaterMark(questions) };
  const persistedProgress = await progressStore.readProgress();
  const selectedProgress = usePersistedProgress && persistedProgress.exists
    ? persistedProgress.progress
    : progress;
  return {
    questions,
    catalog: layers.catalog,
    questionChanges,
    questionSequence,
    userData,
    history,
    progress: validateProgress(selectedProgress)
  };
}

async function createBackup(progress, options) {
  return validateBackup(createBundle(await readCurrentData(progress, options)));
}

function getRestoreTargets(data) {
  const restoredAt = new Date().toISOString();
  const isLegacyBackup = !data.catalog || !data.questionChanges;
  const catalog = isLegacyBackup ? data.questions : data.catalog;
  const questionChanges = isLegacyBackup
    ? questionStore.emptyLocalChanges(catalog, true)
    : data.questionChanges;
  return [
    { filePath: questionStore.questionsFile, payload: catalog },
    { filePath: questionStore.localQuestionsFile, payload: questionChanges },
    { filePath: questionStore.idSequenceFile, payload: data.questionSequence },
    { filePath: userDataStore.userDataFile, payload: data.userData },
    { filePath: historyStore.historyFile, payload: data.history },
    { filePath: progressStore.progressFile, payload: progressStore.createDocument(data.progress, { source: 'backup-restore', completedAt: restoredAt }) }
  ];
}

async function writeUniqueBackup(bundle, prefix) {
  await fs.mkdir(backupDirectory, { recursive: true });
  const name = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
  const filePath = path.join(backupDirectory, name);
  const temporaryFile = `${filePath}.tmp`;
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporaryFile, filePath);
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    throw new BackupError('BACKUP_FILE_WRITE_FAILED', 'Não foi possível gravar o backup de segurança antes da restauração.', 500);
  }
  return name;
}

async function stageTarget(target) {
  const directory = path.dirname(target.filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryFile = `${target.filePath}.${process.pid}.${randomUUID()}.restore`;
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(target.payload, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
  return { ...target, temporaryFile };
}

async function rollbackTargets(changedTargets) {
  const failures = [];
  for (const target of changedTargets.slice().reverse()) {
    try {
      if (target.original === null) {
        await fs.rm(target.filePath, { force: true });
      } else {
        const rollbackFile = `${target.filePath}.${process.pid}.${randomUUID()}.rollback`;
        try {
          await fs.writeFile(rollbackFile, target.original, { flag: 'wx' });
          await replaceFile(rollbackFile, target.filePath);
        } catch (error) {
          await fs.rm(rollbackFile, { force: true }).catch(() => {});
          throw error;
        }
      }
    } catch (error) {
      failures.push({ filePath: target.filePath, message: error.message });
    }
  }
  return failures;
}

async function replaceFile(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    const sourceContents = await fs.readFile(source, 'utf8');
    await fs.copyFile(source, destination);
    if (await fs.readFile(destination, 'utf8') !== sourceContents) {
      throw new Error(`A verificação da substituição de ${path.basename(destination)} falhou.`);
    }
    await fs.rm(source, { force: true });
  }
}

async function restoreBackup(backup, currentProgress) {
  return questionStore.runExclusive(() =>
    progressStore.runExclusive(() => restoreBackupLocked(backup, currentProgress)));
}

async function restoreBackupLocked(backup, currentProgress) {
  validateBackup(backup);
  validateProgress(currentProgress);

  const targets = getRestoreTargets(backup.data);
  const originals = await Promise.all(targets.map(async target => {
    try {
      return await fs.readFile(target.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT'
        && [questionStore.localQuestionsFile, questionStore.idSequenceFile, progressStore.progressFile].includes(target.filePath)) return null;
      if (error.code === 'ENOENT') {
        throw new BackupError('BACKUP_SOURCE_MISSING', `Não foi possível restaurar com segurança: o arquivo atual ${path.basename(target.filePath)} está ausente.`, 500);
      }
      throw error;
    }
  }));

  const safetyBundle = validateBackup(createBundle(await readCurrentData(currentProgress)));
  const safetyBackup = await writeUniqueBackup(safetyBundle, 'safety');
  const staged = [];
  try {
    for (let index = 0; index < targets.length; index += 1) {
      staged.push(await stageTarget(targets[index]));
    }
  } catch (error) {
    await Promise.all(staged.map(target => fs.rm(target.temporaryFile, { force: true }).catch(() => {})));
    throw new BackupError('BACKUP_RESTORE_STAGE_FAILED', `A restauração não foi aplicada. O backup de segurança está em ${safetyBackup}.`, 500);
  }

  const changedTargets = [];
  try {
    for (let index = 0; index < staged.length; index += 1) {
      changedTargets.push({ ...staged[index], original: originals[index] });
      await replaceFile(staged[index].temporaryFile, staged[index].filePath);
    }
  } catch (error) {
    const rollbackFailures = await rollbackTargets(changedTargets);
    await Promise.all(staged.map(target => fs.rm(target.temporaryFile, { force: true }).catch(() => {})));
    const message = rollbackFailures.length
      ? `A restauração falhou e o rollback ficou incompleto. O backup de segurança está em ${safetyBackup}.`
      : `A restauração falhou; os arquivos anteriores foram recuperados. O backup de segurança está em ${safetyBackup}.`;
    throw new BackupError(
      rollbackFailures.length ? 'BACKUP_RESTORE_ROLLBACK_FAILED' : 'BACKUP_RESTORE_FAILED',
      message,
      500
    );
  }

  return {
    restored: getSummary(backup),
    safetyBackup
  };
}

module.exports = {
  FORMAT,
  VERSION,
  backupDirectory,
  BackupError,
  createBackup,
  validateBackup,
  getSummary,
  restoreBackup,
  writeUniqueBackup
};
