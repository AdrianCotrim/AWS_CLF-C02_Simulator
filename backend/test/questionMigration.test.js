'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { isNumericQuestionId, migrateQuestionState, MigrationError } = require('../src/data/questionMigration');

function fixture() {
  return {
    catalog: [
      { id: 'personal-001', source: 'Personal', tag: 'A', question: 'Q1', options: ['A', 'B'], correct_answer: 'A' },
      { id: 'personal-002', source: 'Cloudverse', tag: 'B', question: 'Q2', options: ['A', 'B'], correct_answer: 'B' }
    ],
    changes: {
      version: 1,
      createdQuestions: [{ id: 'local-001', source: 'Examtopics', tag: 'C', question: 'Q3', options: ['A', 'B'], correct_answer: 'A' }],
      overrides: {
        'personal-002': {
          question: { id: 'personal-002', source: 'Cloudverse', tag: 'B2', question: 'Q2 edit', options: ['A', 'B'], correct_answer: 'B' },
          baseQuestion: { id: 'personal-002', source: 'Cloudverse', tag: 'B', question: 'Q2', options: ['A', 'B'], correct_answer: 'B' }
        }
      },
      tombstones: {
        'personal-999': {
          baseQuestion: { id: 'personal-999', source: 'Personal', tag: 'D', question: 'Deleted', options: ['A', 'B'], correct_answer: 'A' }
        }
      },
      catalogSnapshot: { 'personal-001': 'hash-1', 'personal-002': 'hash-2', 'personal-999': 'hash-9' }
    },
    questionSequence: { lastIssued: 10 },
    progress: {
      version: 1,
      questionProgress: { 'personal-001': { timesAnswered: 2, lastCorrect: true }, 'personal-999': { inErrorBank: true } },
      errorBank: ['personal-999'],
      history: [{ id: 'personal-001', source: 'Personal', tag: 'A', ok: true, date: '2026-01-01' }],
      session: { ids: ['local-001', 'personal-404'], answers: { 'local-001': { sel: ['A'] } }, idx: 0, persist: true, done: false }
    },
    userData: {
      version: 1,
      errorBank: ['personal-999'],
      personalQuestions: [{ id: 'personal-404', source: 'Personal', tag: 'Orphan', question: 'Unavailable', options: ['A', 'B'], correct_answer: 'A' }]
    },
    history: { version: 1, attempts: [{ id: 'attempt-1', questionId: 'personal-001', source: 'Personal' }] }
  };
}

test('valida IDs numéricos canônicos e rejeita formatos antigos ou inseguros', () => {
  for (const id of ['1', '10', '1363']) assert.equal(isNumericQuestionId(id), true);
  for (const id of ['personal-001', 'local-001', '001', '0', '-1', '', '1.0', String(Number.MAX_SAFE_INTEGER) + '0']) {
    assert.equal(isNumericQuestionId(id), false);
  }
});

test('converte um espaço global, preserva referências órfãs e remove source', () => {
  const result = migrateQuestionState(fixture());
  const { data, idMap, limitations } = result;

  assert.deepEqual(idMap, {
    'personal-001': '11',
    'personal-002': '12',
    'local-001': '13',
    'personal-999': '14',
    'personal-404': '15'
  });
  assert.equal(result.lastIssued, 15);
  assert.equal(data.catalog.every(question => !Object.hasOwn(question, 'source')), true);
  assert.equal(data.changes.createdQuestions[0].id, '13');
  assert.equal(data.changes.tombstones['14'].baseQuestion.id, '14');
  assert.equal(data.progress.questionProgress['11'].timesAnswered, 2);
  assert.deepEqual(data.progress.session.ids, ['13', '15']);
  assert.equal(data.progress.session.answers['13'].sel[0], 'A');
  assert.equal(data.history.attempts[0].questionId, '11');
  assert.equal(Object.hasOwn(data.history.attempts[0], 'source'), false);
  assert.equal(limitations.some(item => item.id === 'personal-404'), true);
});

test('é determinística e não muta a entrada', () => {
  const input = fixture();
  const before = structuredClone(input);
  const first = migrateQuestionState(input);
  const second = migrateQuestionState(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
});

test('não resolve silenciosamente colisão de ID entre catálogo e questão local', () => {
  const input = fixture();
  input.changes.createdQuestions.push({ ...input.catalog[0] });
  assert.throws(() => migrateQuestionState(input), error => {
    assert.equal(error instanceof MigrationError, true);
    assert.equal(error.code, 'QUESTION_ID_COLLISION');
    return true;
  });
});

test('considera sequência persistida e IDs numéricos existentes', () => {
  const input = fixture();
  input.questionSequence.lastIssued = 100;
  input.catalog.push({ id: '7', tag: 'E', question: 'Q7', options: ['A', 'B'], correct_answer: 'A' });
  const result = migrateQuestionState(input);
  assert.equal(result.idMap['7'], '7');
  assert.equal(result.idMap['personal-001'], '101');
  assert.equal(result.lastIssued, 105);
});

test('recalcula fingerprints do snapshot para questões presentes e preserva órfãos', () => {
  const input = fixture();
  const result = migrateQuestionState(input);
  const migratedQuestion = result.data.catalog[0];
  const expectedFingerprint = createHash('sha256')
    .update(JSON.stringify(migratedQuestion))
    .digest('hex');

  assert.equal(result.data.changes.catalogSnapshot['11'], expectedFingerprint);
  assert.equal(result.data.changes.catalogSnapshot['14'], 'hash-9');
});
