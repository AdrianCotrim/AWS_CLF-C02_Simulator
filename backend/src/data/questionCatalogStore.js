'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const defaultFile = path.resolve(__dirname, '../../../data/questions.json');
const questionsFile = process.env.QUESTIONS_FILE
  ? path.resolve(process.env.QUESTIONS_FILE)
  : defaultFile;
const localQuestionsFile = process.env.LOCAL_QUESTIONS_FILE
  ? path.resolve(process.env.LOCAL_QUESTIONS_FILE)
  : path.join(path.dirname(questionsFile), 'questions.local.json');
const idSequenceFile = process.env.QUESTIONS_SEQUENCE_FILE
  ? path.resolve(process.env.QUESTIONS_SEQUENCE_FILE)
  : `${questionsFile}.sequence.json`;
const LOCAL_ID_PATTERN = /^local-(\d+)$/i;
const NUMERIC_ID_PATTERN = /^[1-9]\d*$/;
const SEQUENCE_ID_PATTERN = /^(?:personal|local)-(\d+)$/i;

class StoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function snapshotCatalog(catalog) {
  return Object.fromEntries(catalog.map(question => [question.id, fingerprint(question)]));
}

function emptyLocalChanges(catalog, initialized = false) {
  return {
    version: 1,
    createdQuestions: [],
    overrides: {},
    tombstones: {},
    catalogSnapshot: initialized ? snapshotCatalog(catalog) : {},
    migration: initialized ? {
      version: 1,
      strategy: 'approved-current-catalog-baseline',
      sourceCatalogCount: catalog.length,
      sourceCatalogSha256: fingerprint(catalog),
      completedAt: new Date().toISOString()
    } : null
  };
}

function validateCatalog(catalog) {
  if (!Array.isArray(catalog)) {
    throw new StoreError('QUESTIONS_FILE_INVALID', 'O catálogo padrão deve ser um array JSON.');
  }

  const ids = new Set();
  for (const question of catalog) {
    if (!question || typeof question !== 'object' || Array.isArray(question)
      || typeof question.id !== 'string' || !question.id.trim()) {
      throw new StoreError('QUESTIONS_FILE_INVALID', 'O catálogo contém uma questão sem ID válido.');
    }
    if (ids.has(question.id)) {
      throw new StoreError('DUPLICATE_QUESTION_ID', `O catálogo contém o ID duplicado ${question.id}.`);
    }
    if (LOCAL_ID_PATTERN.test(question.id)) {
      throw new StoreError('RESERVED_QUESTION_ID', `O ID ${question.id} usa o prefixo reservado para questões locais.`);
    }
    ids.add(question.id);
  }
  return catalog;
}

function validateLocalChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)
    || changes.version !== 1
    || !Array.isArray(changes.createdQuestions)
    || !changes.overrides || typeof changes.overrides !== 'object' || Array.isArray(changes.overrides)
    || !changes.tombstones || typeof changes.tombstones !== 'object' || Array.isArray(changes.tombstones)
    || !changes.catalogSnapshot || typeof changes.catalogSnapshot !== 'object' || Array.isArray(changes.catalogSnapshot)
    || Object.values(changes.catalogSnapshot).some(value => typeof value !== 'string')
    || !changes.migration || changes.migration.version !== 1
    || changes.migration.strategy !== 'approved-current-catalog-baseline'
    || typeof changes.migration.completedAt !== 'string') {
    throw new StoreError('LOCAL_QUESTIONS_FILE_INVALID', 'O arquivo de alterações locais está inválido ou usa uma versão incompatível.');
  }

  const createdIds = new Set();
  for (const question of changes.createdQuestions) {
    if (!question || typeof question !== 'object' || Array.isArray(question)
      || typeof question.id !== 'string'
      || (!LOCAL_ID_PATTERN.test(question.id) && !NUMERIC_ID_PATTERN.test(question.id))
      || createdIds.has(question.id)) {
      throw new StoreError('LOCAL_QUESTIONS_FILE_INVALID', 'A lista de questões locais contém IDs inválidos ou duplicados.');
    }
    createdIds.add(question.id);
  }

  for (const [id, change] of Object.entries(changes.overrides)) {
    if (!change || typeof change !== 'object' || change.question?.id !== id
      || !change.baseQuestion || change.baseQuestion.id !== id) {
      throw new StoreError('LOCAL_QUESTIONS_FILE_INVALID', `A alteração local da questão ${id} está inválida.`);
    }
  }

  for (const [id, tombstone] of Object.entries(changes.tombstones)) {
    if (!tombstone || typeof tombstone !== 'object'
      || !tombstone.baseQuestion || tombstone.baseQuestion.id !== id) {
      throw new StoreError('LOCAL_QUESTIONS_FILE_INVALID', `A exclusão local da questão ${id} está inválida.`);
    }
  }

  return changes;
}

async function readCatalog() {
  let raw;
  try {
    raw = await fs.readFile(questionsFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new StoreError('QUESTIONS_FILE_NOT_FOUND', 'O arquivo do catálogo padrão não foi encontrado.');
    }
    throw new StoreError('QUESTIONS_READ_FAILED', 'Não foi possível ler o catálogo padrão.');
  }

  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch {
    throw new StoreError('QUESTIONS_FILE_INVALID', 'O catálogo padrão contém JSON inválido.');
  }
  return validateCatalog(catalog);
}

async function readLocalChanges(catalog) {
  let raw;
  try {
    raw = await fs.readFile(localQuestionsFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyLocalChanges(catalog);
    throw new StoreError('LOCAL_QUESTIONS_READ_FAILED', 'Não foi possível ler as alterações locais das questões.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoreError('LOCAL_QUESTIONS_FILE_INVALID', 'O arquivo de alterações locais contém JSON inválido.');
  }
  return validateLocalChanges(parsed);
}

function composeQuestions(catalog, changes) {
  const catalogById = new Map(catalog.map(question => [question.id, question]));
  const result = [];
  const effectiveIds = new Set();

  for (const question of catalog) {
    const id = question.id;
    if (changes.tombstones[id]) continue;
    const effective = changes.overrides[id]?.question || question;
    result.push(clone(effective));
    effectiveIds.add(id);
  }

  for (const [id, override] of Object.entries(changes.overrides)) {
    if (catalogById.has(id) || changes.tombstones[id]) continue;
    result.push(clone(override.question));
    effectiveIds.add(id);
  }

  for (const question of changes.createdQuestions) {
    if (catalogById.has(question.id) || effectiveIds.has(question.id)) {
      throw new StoreError('QUESTION_ID_COLLISION', `O ID ${question.id} está duplicado entre o catálogo e as alterações locais.`);
    }
    result.push(clone(question));
    effectiveIds.add(question.id);
  }

  return result;
}

function buildCatalogStatus(catalog, changes, initialized = true) {
  if (!initialized) {
    return {
      initialized: false,
      baselineCount: catalog.length,
      added: [],
      changed: [],
      removed: [],
      conflicts: [],
      deletedIds: []
    };
  }

  const currentSnapshot = snapshotCatalog(catalog);
  const previousSnapshot = changes.catalogSnapshot;
  const currentIds = new Set(Object.keys(currentSnapshot));
  const previousIds = new Set(Object.keys(previousSnapshot));
  const added = [...currentIds].filter(id => !previousIds.has(id)).sort();
  const changed = [...currentIds].filter(id => previousIds.has(id) && currentSnapshot[id] !== previousSnapshot[id]).sort();
  const removed = [...previousIds].filter(id => !currentIds.has(id)).sort();
  const catalogById = new Map(catalog.map(question => [question.id, question]));
  const conflicts = [];

  for (const [id, override] of Object.entries(changes.overrides)) {
    const current = catalogById.get(id);
    if (!current || fingerprint(current) !== fingerprint(override.baseQuestion)) {
      conflicts.push({ id, type: 'override', status: current ? 'catalog-changed' : 'catalog-removed' });
    }
  }
  for (const [id, tombstone] of Object.entries(changes.tombstones)) {
    const current = catalogById.get(id);
    if (!current || fingerprint(current) !== fingerprint(tombstone.baseQuestion)) {
      conflicts.push({ id, type: 'deletion', status: current ? 'catalog-changed' : 'catalog-removed' });
    }
  }

  return {
    initialized: true,
    baselineCount: catalog.length,
    added,
    changed,
    removed,
    conflicts,
    deletedIds: Object.keys(changes.tombstones).sort()
  };
}

async function readQuestionLayers() {
  const catalog = await readCatalog();
  let changes = await readLocalChanges(catalog);
  const initialized = Boolean(changes.migration);
  if (!initialized) changes = emptyLocalChanges(catalog);
  return {
    catalog,
    changes,
    initialized,
    questions: composeQuestions(catalog, changes),
    catalogStatus: buildCatalogStatus(catalog, changes, initialized)
  };
}

async function writeLocalChanges(changes) {
  validateLocalChanges(changes);
  await fs.mkdir(path.dirname(localQuestionsFile), { recursive: true });
  const temporaryFile = `${localQuestionsFile}.${process.pid}.${randomUUID()}.tmp`;
  let originalContents = null;
  try {
    originalContents = await fs.readFile(localQuestionsFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    const serialized = `${JSON.stringify(changes, null, 2)}\n`;
    await fs.writeFile(temporaryFile, serialized, { flag: 'wx' });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporaryFile, localQuestionsFile);
        break;
      } catch (error) {
        if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
        if (attempt >= 4) {
          if (process.platform !== 'win32') throw error;
          try {
            await fs.copyFile(temporaryFile, localQuestionsFile);
            if (await fs.readFile(localQuestionsFile, 'utf8') !== serialized) {
              throw new Error('A verificação da gravação local falhou.');
            }
            await fs.rm(temporaryFile, { force: true });
            break;
          } catch (copyError) {
            try {
              if (originalContents === null) await fs.rm(localQuestionsFile, { force: true });
              else await fs.writeFile(localQuestionsFile, originalContents);
            } catch (rollbackError) {
              throw new StoreError('LOCAL_QUESTIONS_ROLLBACK_FAILED', `A gravação falhou e as alterações anteriores não puderam ser recuperadas: ${rollbackError.message}`, copyError);
            }
            throw copyError;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)));
      }
    }
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    if (error.code === 'LOCAL_QUESTIONS_ROLLBACK_FAILED') throw error;
    throw new StoreError('LOCAL_QUESTIONS_WRITE_FAILED', 'Não foi possível salvar as alterações locais das questões.', error);
  }
}

async function writeCatalog(catalog) {
  validateCatalog(catalog);
  const temporaryFile = `${questionsFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporaryFile, questionsFile);
  } catch {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    throw new StoreError('QUESTIONS_WRITE_FAILED', 'Não foi possível salvar o catálogo padrão.');
  }
}

function highestSequenceId(questions) {
  let highest = 0;
  for (const question of questions) {
    const match = typeof question?.id === 'string' ? SEQUENCE_ID_PATTERN.exec(question.id) : null;
    const value = match ? Number(match[1]) : NUMERIC_ID_PATTERN.test(question?.id || '') ? Number(question.id) : 0;
    if (Number.isSafeInteger(value)) highest = Math.max(highest, value);
  }
  return highest;
}

async function readIdHighWaterMark(questions) {
  let stored;
  try {
    stored = JSON.parse(await fs.readFile(idSequenceFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return highestSequenceId(questions);
    throw new StoreError('QUESTION_ID_SEQUENCE_INVALID', 'Não foi possível ler a sequência de IDs.');
  }
  if (!stored || !Number.isSafeInteger(stored.lastIssued) || stored.lastIssued < 0) {
    throw new StoreError('QUESTION_ID_SEQUENCE_INVALID', 'A sequência de IDs está inválida.');
  }
  return Math.max(highestSequenceId(questions), stored.lastIssued);
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
  const usedIds = new Set(questions.map(question => question.id));
  let next = Math.max(highestSequenceId(questions), highWaterMark) + 1;
  const numericCatalog = questions.some(question => NUMERIC_ID_PATTERN.test(question.id));
  let id = numericCatalog ? String(next) : `local-${String(next).padStart(3, '0')}`;
  while (usedIds.has(id)) {
    next += 1;
    id = numericCatalog ? String(next) : `local-${String(next).padStart(3, '0')}`;
  }
  return { id, sequence: next };
}

let writeQueue = Promise.resolve();

function enqueue(operation) {
  const result = writeQueue.then(operation);
  writeQueue = result.catch(() => {});
  return result;
}

async function changesForMutation(layers, beforeInitialize) {
  if (layers.initialized) return layers.changes;
  if (beforeInitialize) await beforeInitialize();
  return emptyLocalChanges(layers.catalog, true);
}

function readQuestions() {
  return readQuestionLayers().then(layers => layers.questions);
}

async function getQuestionById(id) {
  const questions = await readQuestions();
  return questions.find(question => question.id === id) || null;
}

function addQuestion(question, beforeInitialize) {
  return enqueue(async () => {
    const layers = await readQuestionLayers();
    const highWaterMark = await readIdHighWaterMark(layers.questions);
    const { id, sequence } = generateNextId(layers.questions, highWaterMark);
    const created = { id, ...question };
    const changes = await changesForMutation(layers, beforeInitialize);
    changes.createdQuestions.push(created);
    await writeIdHighWaterMark(sequence);
    await writeLocalChanges(changes);
    return clone(created);
  });
}

function deleteQuestion(id, beforeInitialize) {
  return enqueue(async () => {
    const layers = await readQuestionLayers();
    const current = layers.questions.find(question => question.id === id);
    if (!current) return null;
    const changes = await changesForMutation(layers, beforeInitialize);
    const createdIndex = changes.createdQuestions.findIndex(question => question.id === id);
    if (createdIndex !== -1) {
      changes.createdQuestions.splice(createdIndex, 1);
    } else {
      const baseQuestion = layers.catalog.find(question => question.id === id);
      if (baseQuestion) changes.tombstones[id] = { baseQuestion: clone(baseQuestion) };
    }
    await writeLocalChanges(changes);
    return clone(current);
  });
}

function updateQuestion(id, question, beforeInitialize) {
  return enqueue(async () => {
    const layers = await readQuestionLayers();
    const current = layers.questions.find(item => item.id === id);
    if (!current) return null;
    const changes = await changesForMutation(layers, beforeInitialize);
    const created = changes.createdQuestions.findIndex(item => item.id === id);
    if (created !== -1) {
      changes.createdQuestions[created] = { id, ...question };
    } else {
      const baseQuestion = layers.catalog.find(item => item.id === id);
      if (!baseQuestion) throw new StoreError('QUESTION_BASE_NOT_FOUND', `Não existe uma versão padrão atual para a questão ${id}.`);
      changes.overrides[id] = {
        question: { id, ...question },
        baseQuestion: clone(changes.overrides[id]?.baseQuestion || baseQuestion)
      };
    }
    await writeLocalChanges(changes);
    return clone({ id, ...question });
  });
}

function restoreDefaultQuestion(id, beforeInitialize) {
  return enqueue(async () => {
    const layers = await readQuestionLayers();
    const baseQuestion = layers.catalog.find(question => question.id === id);
    if (!baseQuestion) return null;
    const changes = await changesForMutation(layers, beforeInitialize);
    delete changes.overrides[id];
    delete changes.tombstones[id];
    await writeLocalChanges(changes);
    return clone(baseQuestion);
  });
}

function getQuestionMetadata(id) {
  return readQuestionLayers().then(layers => {
    const created = layers.changes.createdQuestions.some(question => question.id === id);
    const override = Boolean(layers.changes.overrides[id]);
    const standard = layers.catalog.some(question => question.id === id);
    return {
      id,
      origin: created ? 'local' : standard ? 'catalog' : override ? 'orphaned-override' : null,
      hasOverride: override,
      deleted: Boolean(layers.changes.tombstones[id])
    };
  });
}

function getCatalogStatus() {
  return readQuestionLayers().then(layers => layers.catalogStatus);
}

function acknowledgeCatalogUpdate(beforeInitialize) {
  return enqueue(async () => {
    const layers = await readQuestionLayers();
    const changes = await changesForMutation(layers, beforeInitialize);
    changes.catalogSnapshot = snapshotCatalog(layers.catalog);
    await writeLocalChanges(changes);
    return getCatalogStatus();
  });
}

async function readIdHighWaterMarkForBackup(catalog, changes) {
  const questions = composeQuestions(catalog, changes);
  return readIdHighWaterMark(questions);
}

module.exports = {
  defaultFile,
  questionsFile,
  localQuestionsFile,
  idSequenceFile,
  StoreError,
  readCatalog,
  readLocalChanges,
  validateCatalog,
  validateLocalChanges,
  readQuestionLayers,
  readQuestions,
  readIdHighWaterMark,
  readIdHighWaterMarkForBackup,
  writeCatalog,
  writeQuestions: writeCatalog,
  writeLocalChanges,
  emptyLocalChanges,
  composeQuestions,
  getCatalogStatus,
  getQuestionMetadata,
  acknowledgeCatalogUpdate,
  getQuestionById,
  addQuestion,
  deleteQuestion,
  updateQuestion,
  restoreDefaultQuestion,
  runExclusive: enqueue
};
