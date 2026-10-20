'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { afterEach, test } = require('node:test');
const { createQuestionMigrationCoordinator } = require('../src/data/questionMigrationCoordinator');

const runNode = promisify(execFile);
const directories = [];

async function createLegacyFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-backup-'));
  directories.push(directory);
  const files = {
    catalog: path.join(directory, 'questions.json'),
    changes: path.join(directory, 'questions.local.json'),
    questionSequence: path.join(directory, 'questions.json.sequence.json'),
    progress: path.join(directory, 'progress.json'),
    history: path.join(directory, 'history.json'),
    userData: path.join(directory, 'user-data.json')
  };
  const question = id => ({
    id,
    source: 'Personal',
    tag: 'Technology',
    question: `Question ${id}`,
    options: ['A', 'B'],
    correct_answer: 'A',
    explanation: 'Keep this field'
  });
  const values = {
    catalog: [question('personal-001')],
    changes: {
      version: 1,
      createdQuestions: [question('local-001')],
      overrides: {},
      tombstones: {},
      catalogSnapshot: { 'personal-001': 'legacy-fingerprint' },
      migration: {
        version: 1,
        strategy: 'approved-current-catalog-baseline',
        sourceCatalogCount: 1,
        sourceCatalogSha256: 'legacy',
        completedAt: '2026-01-01T00:00:00.000Z'
      }
    },
    questionSequence: { lastIssued: 1 },
    progress: {
      version: 1,
      progress: {
        version: 1,
        questionProgress: { 'personal-001': { timesAnswered: 2 } },
        history: [{ id: 'personal-001', result: 'keep' }],
        session: null,
        errorBank: ['personal-001']
      },
      migration: { source: 'fixture', completedAt: '2026-01-01T00:00:00.000Z' }
    },
    history: { version: 1, attempts: [{ questionId: 'personal-001', result: 'keep' }] },
    userData: { version: 1, personalQuestions: [], errorBank: [], preferences: {} }
  };
  for (const [name, value] of Object.entries(values)) await fs.writeFile(files[name], `${JSON.stringify(value, null, 2)}\n`);
  return { directory, files, values };
}

const childScript = `
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const root = process.env.MIGRATION_TEST_ROOT;
  const files = {
    catalog: path.join(root, 'questions.json'),
    changes: path.join(root, 'questions.local.json'),
    questionSequence: path.join(root, 'questions.json.sequence.json'),
    progress: path.join(root, 'progress.json'),
    history: path.join(root, 'history.json'),
    userData: path.join(root, 'user-data.json')
  };
  (async () => {
    if (process.env.MIGRATION_TEST_MODE === 'backup') {
      process.env.QUESTIONS_FILE = files.catalog;
      process.env.LOCAL_QUESTIONS_FILE = files.changes;
      process.env.PROGRESS_FILE = files.progress;
      process.env.USER_DATA_FILE = files.userData;
      process.env.HISTORY_FILE = files.history;
      process.env.BACKUP_DIRECTORY = path.join(root, 'application-backups');
      const backupStore = require('./src/data/backupStore');
      const progress = JSON.parse(await fs.readFile(files.progress, 'utf8'));
      const bundle = await backupStore.createBackup(progress.progress);
      await fs.writeFile(path.join(root, 'bundle.json'), JSON.stringify(bundle));
    } else {
      process.env.QUESTIONS_FILE = files.catalog;
      process.env.LOCAL_QUESTIONS_FILE = files.changes;
      process.env.PROGRESS_FILE = files.progress;
      process.env.USER_DATA_FILE = files.userData;
      process.env.HISTORY_FILE = files.history;
      process.env.BACKUP_DIRECTORY = path.join(root, 'application-backups');
      const backupStore = require('./src/data/backupStore');
      const questionStore = require('./src/data/questionCatalogStore');
      const bundle = JSON.parse(await fs.readFile(process.env.MIGRATION_TEST_BUNDLE, 'utf8'));
      const progress = JSON.parse(await fs.readFile(files.progress, 'utf8'));
      await backupStore.restoreBackup(bundle, progress.progress);
      const layers = await questionStore.readQuestionLayers();
      if (!layers.questions.length || layers.catalogStatus.changed.length) throw new Error('restored catalog is inconsistent');
      await questionStore.updateQuestion('2', {
        tag: 'Updated after migration',
        question: layers.catalog[0].question,
        options: ['A', 'B'],
        correct_answer: 'A'
      });
      const overrideStatus = await questionStore.getCatalogStatus();
      if (overrideStatus.conflicts.length) throw new Error('override unexpectedly conflicts');
      await fs.writeFile(files.catalog, JSON.stringify([{ ...layers.catalog[0], question: 'Catalog update' }]));
      const conflictStatus = await questionStore.getCatalogStatus();
      if (!conflictStatus.conflicts.some(conflict => conflict.id === '2')) throw new Error('catalog conflict was not detected');
      await questionStore.deleteQuestion('2');
      const tombstoneStatus = await questionStore.getCatalogStatus();
      if (!tombstoneStatus.deletedIds.includes('2')) throw new Error('numeric tombstone was not preserved');
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;

afterEach(async () => {
  while (directories.length) await fs.rm(directories.pop(), { recursive: true, force: true });
});

test('migra cópia, cria backup atual e restaura em outro diretório temporário', async () => {
  const fixture = await createLegacyFixture();
  const migrated = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-backup-restored-'));
  directories.push(migrated);
  const coordinator = createQuestionMigrationCoordinator({
    files: fixture.files,
    stateFile: path.join(fixture.directory, 'state.json'),
    backupDirectory: path.join(fixture.directory, 'transaction-backups'),
    operationId: 'compatibility-test'
  });
  const prepared = await coordinator.prepare();
  await coordinator.commit();

  const destinationFiles = {};
  for (const name of Object.keys(fixture.files)) {
    destinationFiles[name] = path.join(migrated, path.basename(fixture.files[name]));
    await fs.copyFile(fixture.files[name], destinationFiles[name]);
  }
  await runNode(process.execPath, ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, MIGRATION_TEST_ROOT: fixture.directory, MIGRATION_TEST_MODE: 'backup' }
  });
  const bundlePath = path.join(fixture.directory, 'bundle.json');
  await runNode(process.execPath, ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      MIGRATION_TEST_ROOT: migrated,
      MIGRATION_TEST_BUNDLE: bundlePath,
      MIGRATION_TEST_MODE: 'restore'
    }
  });

  const restoredCatalog = JSON.parse(await fs.readFile(destinationFiles.catalog, 'utf8'));
  const restoredChanges = JSON.parse(await fs.readFile(destinationFiles.changes, 'utf8'));
  assert.equal(restoredCatalog[0].id, '2');
  assert.equal(restoredChanges.createdQuestions[0].id, '3');
  assert.equal(Object.hasOwn(restoredCatalog[0], 'source'), false);
  assert.equal(prepared.limitations.length, 1);
});
