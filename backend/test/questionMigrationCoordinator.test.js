'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  createQuestionMigrationCoordinator,
  QuestionMigrationCoordinatorError
} = require('../src/data/questionMigrationCoordinator');

const directories = [];

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'question-migration-'));
  directories.push(directory);
  const files = {
    catalog: path.join(directory, 'questions.json'),
    changes: path.join(directory, 'questions.local.json'),
    progress: path.join(directory, 'progress.json'),
    userData: path.join(directory, 'user-data.json'),
    history: path.join(directory, 'history.json'),
    questionSequence: path.join(directory, 'questions.json.sequence.json')
  };
  const question = (id, source = 'Personal') => ({
    id, source, tag: 'tag', question: `question-${id}`, options: ['A', 'B'], correct_answer: 'A', extra: { keep: true }
  });
  const contents = {
    catalog: [question('personal-001')],
    changes: {
      version: 1,
      createdQuestions: [question('local-001', 'Cloudverse')],
      overrides: {
        'personal-001': {
          question: question('personal-001', 'Examtopics'),
          baseQuestion: question('personal-001')
        }
      },
      tombstones: {
        'personal-999': { baseQuestion: question('personal-999') }
      },
      catalogSnapshot: { 'personal-001': 'hash-1', 'personal-999': 'hash-9' }
    },
    progress: {
      version: 1,
      progress: {
        version: 1,
        questionProgress: { 'personal-001': { timesAnswered: 3, marker: 'preserve' }, 'personal-404': { timesWrong: 1 } },
        errorBank: ['personal-404'],
        history: [{ id: 'personal-001', source: 'Personal', result: 'keep' }],
        session: { ids: ['local-001', 'personal-404'], answers: { 'local-001': { selected: ['A'] } }, idx: 0, persist: true, done: false }
      },
      migration: { source: 'fixture', completedAt: '2026-01-01T00:00:00.000Z', keep: true }
    },
    userData: {
      version: 1,
      errorBank: ['personal-999'],
      personalQuestions: [question('personal-404')],
      preferences: { theme: 'dark' }
    },
    history: { version: 1, attempts: [{ questionId: 'personal-001', source: 'Personal', attemptMarker: true }], keep: true },
    questionSequence: { lastIssued: 10 }
  };
  for (const [name, value] of Object.entries(contents)) {
    await fs.writeFile(files[name], `${JSON.stringify(value, null, 2)}\n`);
  }
  return {
    directory,
    files,
    contents,
    stateFile: path.join(directory, 'migration-state.json'),
    backupDirectory: path.join(directory, 'backups')
  };
}

function createCoordinator(fixture, options = {}) {
  return createQuestionMigrationCoordinator({
    files: fixture.files,
    stateFile: fixture.stateFile,
    backupDirectory: fixture.backupDirectory,
    operationId: 'fixture-operation',
    hooks: options.hooks
  });
}

async function readFiles(files) {
  const result = {};
  for (const [name, filePath] of Object.entries(files)) result[name] = JSON.parse(await fs.readFile(filePath, 'utf8'));
  return result;
}

afterEach(async () => {
  while (directories.length) await fs.rm(directories.pop(), { recursive: true, force: true });
});

test('prepara, valida e faz commit preservando metadados e envelope do progresso', async () => {
  const testFixture = await fixture();
  const coordinator = createCoordinator(testFixture);
  const prepared = await coordinator.prepare();

  assert.equal(prepared.state.phase, 'prepared');
  assert.equal(prepared.idMap['personal-001'], '11');
  assert.equal(prepared.idMap['local-001'], '12');
  assert.equal(prepared.idMap['personal-404'], '14');
  assert.equal(prepared.lastIssued, 14);
  const committed = await coordinator.commit();
  assert.equal(committed.phase, 'completed');

  const output = await readFiles(testFixture.files);
  assert.equal(output.catalog[0].id, '11');
  assert.equal(output.catalog[0].extra.keep, true);
  assert.equal(output.changes.overrides['11'].baseQuestion.id, '11');
  assert.equal(output.changes.tombstones['13'].baseQuestion.id, '13');
  assert.deepEqual(output.progress.progress.session.ids, ['12', '14']);
  assert.equal(output.progress.migration.keep, true);
  assert.equal(output.userData.preferences.theme, 'dark');
  assert.equal(output.history.attempts[0].attemptMarker, true);
  assert.equal(Object.hasOwn(output.catalog[0], 'source'), false);
  assert.equal(Object.hasOwn(output.progress.progress.history[0], 'source'), false);
  assert.equal(Object.hasOwn(output.history.attempts[0], 'source'), false);
});

test('preserva referências órfãs e permite recuperar após substituição parcial', async () => {
  const testFixture = await fixture();
  const coordinator = createCoordinator(testFixture, {
    hooks: { beforeReplace: name => { if (name === 'progress') throw new Error('falha de teste'); } }
  });
  await coordinator.prepare();
  await assert.rejects(() => coordinator.commit(), error => error.code === 'COMMIT_FAILED');
  assert.equal((await coordinator.readState()).phase, 'recovery-needed');

  const recreated = createCoordinator(testFixture);
  assert.equal((await recreated.recover()).phase, 'recovered');
  assert.deepEqual(await readFiles(testFixture.files), testFixture.contents);
  assert.equal((await fs.readdir(path.join(testFixture.backupDirectory, 'fixture-operation'))).includes('manifest.json'), true);
});

test('uma nova instância fica bloqueada enquanto houver operação pendente', async () => {
  const testFixture = await fixture();
  await createCoordinator(testFixture).prepare();
  await assert.rejects(
    () => createCoordinator(testFixture).prepare(),
    error => error.code === 'OPERATION_PENDING'
  );
});

test('detecta inconsistência antes de substituir os arquivos', async () => {
  const testFixture = await fixture();
  const original = await fs.readFile(testFixture.files.changes, 'utf8');
  const parsed = JSON.parse(original);
  parsed.overrides['personal-001'].baseQuestion.id = 'personal-404';
  await fs.writeFile(testFixture.files.changes, JSON.stringify(parsed));

  await assert.rejects(
    () => createCoordinator(testFixture).prepare(),
    error => error.code === 'PREPARATION_FAILED' || error.code === 'QUESTION_ID_COLLISION'
  );
  assert.equal(await fs.readFile(testFixture.files.catalog, 'utf8'), `${JSON.stringify(testFixture.contents.catalog, null, 2)}\n`);
});

test('rejeita arquivo obrigatório ausente ou JSON inválido sem alterar os demais', async () => {
  const testFixture = await fixture();
  await fs.rm(testFixture.files.history);
  await assert.rejects(() => createCoordinator(testFixture).prepare(), error => error.code === 'SOURCE_READ_FAILED');

  const second = await fixture();
  await fs.writeFile(second.files.catalog, '{ inválido');
  await assert.rejects(() => createCoordinator(second).prepare(), error => error.code === 'INVALID_SOURCE_JSON');
});

test('rejeita IDs preparados inválidos antes do commit', async () => {
  const testFixture = await fixture();
  const coordinator = createCoordinator(testFixture);
  await coordinator.prepare();
  const state = await coordinator.readState();
  await fs.writeFile(state.temporaryFiles.catalog, JSON.stringify([{ id: '001' }]));
  await assert.rejects(
    () => coordinator.validatePrepared(state),
    error => error instanceof QuestionMigrationCoordinatorError || error.code === 'INVALID_MIGRATED_ID'
  );
});
