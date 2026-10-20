'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createMigrationTransaction } = require('./migrationTransaction');
const {
  isNumericQuestionId,
  migrateQuestionState,
} = require('./questionMigration');

const REQUIRED_FILE_NAMES = ['catalog', 'changes', 'progress', 'userData', 'history', 'questionSequence'];

class QuestionMigrationCoordinatorError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

function validatePaths(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new QuestionMigrationCoordinatorError('INVALID_FILES', 'Os arquivos da migração devem ser declarados explicitamente.');
  }
  for (const name of REQUIRED_FILE_NAMES) {
    if (typeof files[name] !== 'string' || !path.isAbsolute(files[name])) {
      throw new QuestionMigrationCoordinatorError('INVALID_FILES', `O arquivo obrigatório ${name} não foi declarado com caminho absoluto.`);
    }
  }
}

function parseProgressDocument(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'progress') && Object.hasOwn(value, 'migration')) {
    if (!value.progress || typeof value.progress !== 'object' || Array.isArray(value.progress)) {
      throw new QuestionMigrationCoordinatorError('INVALID_PROGRESS_DOCUMENT', 'O envelope do progresso contém um objeto progress inválido.');
    }
    return { value: value.progress, envelope: value };
  }
  return { value, envelope: null };
}

function createInput(source) {
  const progress = parseProgressDocument(source.progress);
  return {
    catalog: source.catalog,
    changes: source.changes,
    progress: progress.value,
    userData: source.userData,
    history: source.history,
    questionSequence: source.questionSequence
  };
}

function createOutput(data, source) {
  const progressDocument = parseProgressDocument(source.progress).envelope;
  return {
    catalog: data.catalog,
    changes: data.changes,
    progress: progressDocument
      ? { ...clone(progressDocument), progress: data.progress }
      : data.progress,
    userData: data.userData,
    history: data.history,
    questionSequence: data.questionSequence
  };
}

function assertQuestionWithoutSource(question, context) {
  if (!question || typeof question !== 'object' || Array.isArray(question)) {
    throw new QuestionMigrationCoordinatorError('INVALID_QUESTION_RECORD', `A questão em ${context} é inválida.`);
  }
  if (Object.hasOwn(question, 'source')) {
    throw new QuestionMigrationCoordinatorError('SOURCE_PRESENT', `O campo source permaneceu em ${context}.`);
  }
  if (!isNumericQuestionId(question.id)) {
    throw new QuestionMigrationCoordinatorError('INVALID_MIGRATED_ID', `O ID em ${context} não está no formato numérico canônico.`);
  }
}

function validateMigratedData(data) {
  if (!data || !Array.isArray(data.catalog) || !data.changes || !data.progress
    || !data.userData || !data.history || !data.questionSequence) {
    throw new QuestionMigrationCoordinatorError('INVALID_MIGRATED_DATA', 'A saída da migração não possui todos os arquivos esperados.');
  }
  if (!Number.isSafeInteger(data.questionSequence.lastIssued) || data.questionSequence.lastIssued < 0) {
    throw new QuestionMigrationCoordinatorError('INVALID_SEQUENCE', 'A sequência migrada é inválida.');
  }

  const questionIds = new Set();
  const register = (question, context) => {
    assertQuestionWithoutSource(question, context);
    if (questionIds.has(question.id)) {
      throw new QuestionMigrationCoordinatorError('QUESTION_ID_COLLISION', `O ID migrado ${question.id} aparece mais de uma vez.`);
    }
    questionIds.add(question.id);
  };
  data.catalog.forEach((question, index) => register(question, `catalog[${index}]`));
  data.changes.createdQuestions.forEach((question, index) => register(question, `createdQuestions[${index}]`));
  for (const [id, change] of Object.entries(data.changes.overrides || {})) {
    if (id !== change.question?.id || id !== change.baseQuestion?.id) {
      throw new QuestionMigrationCoordinatorError('INVALID_REFERENCE', `O override ${id} não referencia seu próprio ID.`);
    }
    assertQuestionWithoutSource(change.question, `overrides.${id}.question`);
    assertQuestionWithoutSource(change.baseQuestion, `overrides.${id}.baseQuestion`);
  }
  for (const [id, tombstone] of Object.entries(data.changes.tombstones || {})) {
    if (id !== tombstone.baseQuestion?.id) {
      throw new QuestionMigrationCoordinatorError('INVALID_REFERENCE', `O tombstone ${id} não referencia seu próprio ID.`);
    }
    assertQuestionWithoutSource(tombstone.baseQuestion, `tombstones.${id}.baseQuestion`);
  }
  for (const question of data.userData.personalQuestions || []) register(question, 'userData.personalQuestions');

  const assertReference = (id, context) => {
    if (!isNumericQuestionId(id) || Number(id) > data.questionSequence.lastIssued) {
      throw new QuestionMigrationCoordinatorError('INVALID_REFERENCE', `A referência ${context} não possui ID numérico canônico.`);
    }
  };
  Object.keys(data.progress.questionProgress || {}).forEach(id => assertReference(id, `progress.questionProgress.${id}`));
  (data.progress.errorBank || []).forEach((id, index) => assertReference(id, `progress.errorBank[${index}]`));
  (data.userData.errorBank || []).forEach((id, index) => assertReference(id, `userData.errorBank[${index}]`));
  (data.progress.session?.ids || []).forEach((id, index) => assertReference(id, `progress.session.ids[${index}]`));
  Object.keys(data.progress.session?.answers || {}).forEach(id => assertReference(id, `progress.session.answers.${id}`));
  (data.history.attempts || []).forEach((entry, index) => {
    if (Object.hasOwn(entry, 'source')) {
      throw new QuestionMigrationCoordinatorError('SOURCE_PRESENT', `O campo source permaneceu em history.attempts[${index}].`);
    }
    if (entry.questionId !== undefined) assertReference(entry.questionId, `history.attempts[${index}].questionId`);
  });
  (data.progress.history || []).forEach((entry, index) => {
    if (Object.hasOwn(entry, 'source')) {
      throw new QuestionMigrationCoordinatorError('SOURCE_PRESENT', `O campo source permaneceu em progress.history[${index}].`);
    }
    if (entry.id !== undefined) assertReference(entry.id, `progress.history[${index}].id`);
  });
  for (const id of questionIds) {
    if (Number(id) > data.questionSequence.lastIssued) {
      throw new QuestionMigrationCoordinatorError('INVALID_SEQUENCE', `O ID ${id} excede lastIssued.`);
    }
  }
}

function createQuestionMigrationCoordinator({
  files,
  stateFile,
  backupDirectory,
  operationId,
  fsApi = fs,
  hooks,
  now,
  randomId,
  protectedPaths
}) {
  validatePaths(files);
  let latestResult = null;

  const transaction = createMigrationTransaction({
    files,
    stateFile,
    backupDirectory,
    operationId,
    fsApi,
    hooks,
    now,
    randomId,
    protectedPaths,
    transform: source => {
      const result = migrateQuestionState(createInput(source));
      const output = createOutput(result.data, source);
      latestResult = {
        idMap: result.idMap,
        lastIssued: result.lastIssued,
        limitations: result.limitations
      };
      return output;
    },
    validate: (prepared, context) => {
      const input = createInput(prepared);
      validateMigratedData(input);
      if (context.source) {
        const source = createInput(context.source);
        if (!source.catalog || !source.changes || !source.progress || !source.userData || !source.history) {
          throw new QuestionMigrationCoordinatorError('INVALID_SOURCE_DATA', 'Os dados de origem não possuem a estrutura esperada.');
        }
      }
    }
  });

  return {
    async prepare() {
      const state = await transaction.prepare();
      return { state, ...(latestResult || {}) };
    },
    commit: transaction.commit,
    recover: transaction.recover,
    readState: transaction.readState,
    validatePrepared: transaction.validatePrepared
  };
}

module.exports = {
  REQUIRED_FILE_NAMES,
  QuestionMigrationCoordinatorError,
  createQuestionMigrationCoordinator,
  validateMigratedData
};
