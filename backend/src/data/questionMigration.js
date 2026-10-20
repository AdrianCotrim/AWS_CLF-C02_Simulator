'use strict';

const { createHash } = require('node:crypto');

const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
const NUMERIC_ID_PATTERN = /^[1-9]\d*$/;

class MigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isNumericQuestionId(value) {
  return typeof value === 'string'
    && NUMERIC_ID_PATTERN.test(value)
    && Number.isSafeInteger(Number(value));
}

function requireSourceId(value, context) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MigrationError('INVALID_QUESTION_ID', `A referência de ID em ${context} é inválida.`);
  }
  return value;
}

function withoutSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value };
  delete result.source;
  return result;
}

function addId(ids, value, context) {
  ids.push({ id: requireSourceId(value, context), context });
}

function collectIds(input) {
  const ids = [];
  const catalog = Array.isArray(input.catalog) ? input.catalog : [];
  const changes = input.changes || {};
  const progress = input.progress || {};
  const userData = input.userData || {};
  const history = input.history || {};

  catalog.forEach((question, index) => addId(ids, question && question.id, `catalog[${index}]`));
  (Array.isArray(changes.createdQuestions) ? changes.createdQuestions : [])
    .forEach((question, index) => addId(ids, question && question.id, `createdQuestions[${index}]`));
  for (const [id, change] of Object.entries(changes.overrides || {})) {
    addId(ids, id, `overrides.${id}`);
    addId(ids, change && change.question && change.question.id, `overrides.${id}.question`);
    addId(ids, change && change.baseQuestion && change.baseQuestion.id, `overrides.${id}.baseQuestion`);
  }
  for (const [id, tombstone] of Object.entries(changes.tombstones || {})) {
    addId(ids, id, `tombstones.${id}`);
    addId(ids, tombstone && tombstone.baseQuestion && tombstone.baseQuestion.id, `tombstones.${id}.baseQuestion`);
  }
  Object.keys(changes.catalogSnapshot || {}).forEach(id => addId(ids, id, `catalogSnapshot.${id}`));

  Object.keys(progress.questionProgress || {}).forEach(id => addId(ids, id, `progress.questionProgress.${id}`));
  (Array.isArray(progress.errorBank) ? progress.errorBank : [])
    .forEach((id, index) => addId(ids, id, `progress.errorBank[${index}]`));
  (Array.isArray(progress.history) ? progress.history : [])
    .forEach((entry, index) => {
      if (entry && entry.id !== undefined) addId(ids, entry.id, `progress.history[${index}].id`);
    });
  if (progress.session) {
    (Array.isArray(progress.session.ids) ? progress.session.ids : [])
      .forEach((id, index) => addId(ids, id, `progress.session.ids[${index}]`));
    Object.keys(progress.session.answers || {}).forEach(id => addId(ids, id, `progress.session.answers.${id}`));
  }

  (Array.isArray(userData.errorBank) ? userData.errorBank : [])
    .forEach((id, index) => addId(ids, id, `userData.errorBank[${index}]`));
  (Array.isArray(userData.personalQuestions) ? userData.personalQuestions : [])
    .forEach((question, index) => addId(ids, question && question.id, `userData.personalQuestions[${index}]`));

  (Array.isArray(history.attempts) ? history.attempts : [])
    .forEach((entry, index) => {
      if (entry && entry.questionId !== undefined) addId(ids, entry.questionId, `history.attempts[${index}].questionId`);
    });

  return ids;
}

function questionFingerprint(question) {
  const copy = withoutSource(question);
  delete copy.id;
  return JSON.stringify(copy);
}

function detectQuestionCollisions(input) {
  const owners = new Map();
  const register = (question, context) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      throw new MigrationError('INVALID_QUESTION_RECORD', `A questão em ${context} é inválida.`);
    }
    const id = requireSourceId(question.id, context);
    if (owners.has(id)) {
      const previous = owners.get(id);
      if (previous.kind !== 'override-base-compatible' && previous.kind !== 'tombstone-base-compatible') {
        throw new MigrationError('QUESTION_ID_COLLISION', `O ID ${id} aparece em ${previous.context} e ${context}.`);
      }
    } else {
      owners.set(id, { context, kind: 'question', fingerprint: questionFingerprint(question) });
    }
  };

  (input.catalog || []).forEach((question, index) => register(question, `catalog[${index}]`));
  (input.changes?.createdQuestions || []).forEach((question, index) => register(question, `createdQuestions[${index}]`));
  return owners;
}

function buildIdMap(input) {
  detectQuestionCollisions(input);
  const occurrences = collectIds(input);
  const uniqueIds = [];
  const seen = new Set();
  for (const occurrence of occurrences) {
    if (!seen.has(occurrence.id)) {
      seen.add(occurrence.id);
      uniqueIds.push(occurrence.id);
    }
  }

  const mapping = new Map();
  const used = new Set();
  let next = 0;
  const sequence = input.questionSequence && input.questionSequence.lastIssued;
  if (sequence !== undefined
    && (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_SAFE_ID)) {
    throw new MigrationError('INVALID_SEQUENCE', 'A sequência de IDs excede o limite seguro de inteiros.');
  }

  for (const oldId of uniqueIds) {
    if (isNumericQuestionId(oldId)) {
      const numeric = Number(oldId);
      if (used.has(numeric)) throw new MigrationError('QUESTION_ID_COLLISION', `O ID numérico ${oldId} está duplicado.`);
      mapping.set(oldId, oldId);
      used.add(numeric);
      next = Math.max(next, numeric);
    }
  }
  next = Math.max(next, sequence || 0);

  for (const oldId of uniqueIds) {
    if (mapping.has(oldId)) continue;
    if (next >= MAX_SAFE_ID) {
      throw new MigrationError('ID_SEQUENCE_EXHAUSTED', 'Não há próximo ID seguro disponível.');
    }
    next += 1;
    while (used.has(next)) {
      if (next >= MAX_SAFE_ID) throw new MigrationError('ID_SEQUENCE_EXHAUSTED', 'Não há próximo ID seguro disponível.');
      next += 1;
    }
    mapping.set(oldId, String(next));
    used.add(next);
  }

  return { mapping, lastIssued: next };
}

function mapId(mapping, value, context) {
  const oldId = requireSourceId(value, context);
  const mapped = mapping.get(oldId);
  if (!mapped) throw new MigrationError('UNMAPPED_QUESTION_ID', `O ID ${oldId} em ${context} não possui mapeamento.`);
  return mapped;
}

function mapQuestion(mapping, question, context) {
  if (!question || typeof question !== 'object' || Array.isArray(question)) {
    throw new MigrationError('INVALID_QUESTION_RECORD', `A questão em ${context} é inválida.`);
  }
  return { ...withoutSource(question), id: mapId(mapping, question.id, `${context}.id`) };
}

function mapIdList(mapping, values, context) {
  return Array.isArray(values) ? values.map((id, index) => mapId(mapping, id, `${context}[${index}]`)) : values;
}

function migrateQuestionChanges(mapping, changes, catalog) {
  const result = withoutSource(clone(changes || {}));
  result.createdQuestions = (changes?.createdQuestions || []).map((question, index) =>
    mapQuestion(mapping, question, `createdQuestions[${index}]`));
  result.overrides = {};
  for (const [oldId, change] of Object.entries(changes?.overrides || {})) {
    const newId = mapId(mapping, oldId, `overrides.${oldId}`);
    result.overrides[newId] = {
      ...clone(change),
      question: mapQuestion(mapping, change.question, `overrides.${oldId}.question`),
      baseQuestion: mapQuestion(mapping, change.baseQuestion, `overrides.${oldId}.baseQuestion`)
    };
  }
  result.tombstones = {};
  for (const [oldId, tombstone] of Object.entries(changes?.tombstones || {})) {
    const newId = mapId(mapping, oldId, `tombstones.${oldId}`);
    result.tombstones[newId] = {
      ...clone(tombstone),
      baseQuestion: mapQuestion(mapping, tombstone.baseQuestion, `tombstones.${oldId}.baseQuestion`)
    };
  }
  const migratedCatalogById = new Map(catalog.map(question => [question.id, question]));
  result.catalogSnapshot = Object.fromEntries(Object.entries(changes?.catalogSnapshot || {})
    .map(([oldId, previousFingerprint]) => {
      const newId = mapId(mapping, oldId, `catalogSnapshot.${oldId}`);
      const migratedQuestion = migratedCatalogById.get(newId);
      return [newId, migratedQuestion ? fingerprint(migratedQuestion) : previousFingerprint];
    }));
  return result;
}

function migrateProgress(mapping, progress) {
  const result = clone(progress || {});
  result.questionProgress = Object.fromEntries(Object.entries(progress?.questionProgress || {})
    .map(([oldId, value]) => [mapId(mapping, oldId, `progress.questionProgress.${oldId}`), clone(value)]));
  if (Array.isArray(progress?.errorBank)) result.errorBank = mapIdList(mapping, progress.errorBank, 'progress.errorBank');
  if (Array.isArray(progress?.history)) {
    result.history = progress.history.map((entry, index) => {
      const converted = { ...clone(entry) };
      if (entry && entry.id !== undefined) converted.id = mapId(mapping, entry.id, `progress.history[${index}].id`);
      delete converted.source;
      if (entry?.questionSnapshot) converted.questionSnapshot = mapQuestion(mapping, entry.questionSnapshot, `progress.history[${index}].questionSnapshot`);
      return converted;
    });
  }
  if (progress?.session) {
    result.session = { ...clone(progress.session) };
    result.session.ids = mapIdList(mapping, progress.session.ids, 'progress.session.ids');
    result.session.answers = Object.fromEntries(Object.entries(progress.session.answers || {})
      .map(([oldId, answer]) => [mapId(mapping, oldId, `progress.session.answers.${oldId}`), clone(answer)]));
  }
  return result;
}

function migrateQuestionState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MigrationError('INVALID_MIGRATION_INPUT', 'A entrada da migração deve ser um objeto.');
  }
  const { mapping, lastIssued } = buildIdMap(input);
  const output = clone(input);
  output.catalog = (input.catalog || []).map((question, index) => mapQuestion(mapping, question, `catalog[${index}]`));
  output.changes = migrateQuestionChanges(mapping, input.changes, output.catalog);
  output.progress = migrateProgress(mapping, input.progress);
  output.userData = clone(input.userData || {});
  output.userData.errorBank = mapIdList(mapping, output.userData.errorBank, 'userData.errorBank');
  output.userData.personalQuestions = (output.userData.personalQuestions || [])
    .map((question, index) => mapQuestion(mapping, question, `userData.personalQuestions[${index}]`));
  delete output.userData.source;
  output.history = clone(input.history || {});
  output.history.attempts = (output.history.attempts || []).map(entry => {
    const converted = { ...clone(entry) };
    if (entry && entry.questionId !== undefined) converted.questionId = mapId(mapping, entry.questionId, 'history.attempts.questionId');
    delete converted.source;
    return converted;
  });
  output.questionSequence = { lastIssued };
  return {
    data: output,
    idMap: Object.fromEntries(mapping),
    lastIssued,
    limitations: collectIds(input)
      .filter(({ id }) => !(input.catalog || []).some(question => question && question.id === id))
      .map(({ id, context }) => ({ id, context, reason: 'A referência não possui necessariamente uma questão atual no catálogo.' }))
  };
}

module.exports = {
  MigrationError,
  isNumericQuestionId,
  migrateQuestionState
};
