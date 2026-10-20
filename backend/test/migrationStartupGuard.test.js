'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { createMigrationTransaction } = require('../src/data/migrationTransaction');
const { createMigrationStartupGuard } = require('../src/data/migrationStartupGuard');
const { checkMigrationStartup } = require('../src/migrationStartupCheck');

const directories = [];

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-startup-'));
  directories.push(directory);
  const files = { catalog: path.join(directory, 'questions.json') };
  await fs.writeFile(files.catalog, JSON.stringify([{ id: 'personal-001' }]));
  return {
    directory,
    files,
    stateFile: path.join(directory, 'transaction-state.json'),
    schemaFile: path.join(directory, 'schema.json'),
    backupDirectory: path.join(directory, 'backups')
  };
}

function guardFor(fixture) {
  return createMigrationStartupGuard({
    stateFile: fixture.stateFile,
    schemaFile: fixture.schemaFile,
    files: fixture.files
  });
}

async function completedTransaction(fixture) {
  const transaction = createMigrationTransaction({
    files: fixture.files,
    stateFile: fixture.stateFile,
    backupDirectory: fixture.backupDirectory,
    operationId: 'startup-test',
    transform: async source => ({ catalog: source.catalog.map(() => ({ id: '1' })) }),
    validate: async data => {
      if (!/^[1-9]\d*$/.test(data.catalog[0].id)) throw new Error('invalid');
    }
  });
  await transaction.prepare();
  return { transaction, state: await transaction.commit() };
}

afterEach(async () => {
  while (directories.length) await fs.rm(directories.pop(), { recursive: true, force: true });
});

test('classifica instalação legada sem inferir conclusão pelos IDs', async () => {
  const testFixture = await fixture();
  const result = await guardFor(testFixture).inspect();
  assert.equal(result.status, 'legacy');
});

test('bloqueia estado pendente e permite recuperação antes de nova inicialização', async () => {
  const testFixture = await fixture();
  const transaction = createMigrationTransaction({
    files: testFixture.files,
    stateFile: testFixture.stateFile,
    backupDirectory: testFixture.backupDirectory,
    operationId: 'startup-test',
    transform: async source => ({ catalog: source.catalog }),
    validate: async () => {}
  });
  await transaction.prepare();
  const guard = guardFor(testFixture);
  assert.equal((await guard.inspect()).status, 'migration-pending');
  await transaction.recover();
  assert.equal((await guard.inspect()).status, 'recovered');
  await assert.rejects(() => guard.assertReady(), error => error.code === 'STARTUP_BLOCKED');
});

test('grava marcador somente após transação concluída e reconhece esquema migrado', async () => {
  const testFixture = await fixture();
  const { state } = await completedTransaction(testFixture);
  const guard = guardFor(testFixture);
  const marker = await guard.writeCompletedMarker(state);
  assert.equal(marker.schemaVersion, 2);
  assert.equal((await guard.inspect()).status, 'migration-completed');
  assert.equal((await guard.assertReady()).status, 'migration-completed');
});

test('não grava marcador para transação pendente ou dados finais inválidos', async () => {
  const testFixture = await fixture();
  const guard = guardFor(testFixture);
  await assert.rejects(() => guard.writeCompletedMarker({
    format: 'aws-clf-c02-migration-transaction',
    version: 1,
    operationId: 'startup-test',
    phase: 'prepared',
    files: testFixture.files
  }), error => error.code === 'TRANSACTION_NOT_COMPLETE');
  await fs.writeFile(testFixture.files.catalog, '{ invalid');
  await assert.rejects(() => guard.writeCompletedMarker({
    format: 'aws-clf-c02-migration-transaction',
    version: 1,
    operationId: 'startup-test',
    phase: 'completed',
    files: testFixture.files
  }), error => error.code === 'FINAL_DATA_INVALID');
  await assert.rejects(() => fs.access(testFixture.schemaFile));
});

test('rejeita marcador inválido e falha de gravação sem indicar conclusão', async () => {
  const testFixture = await fixture();
  await fs.writeFile(testFixture.schemaFile, JSON.stringify({ format: 'wrong' }));
  await assert.rejects(() => guardFor(testFixture).inspect(), error => error.code === 'INVALID_SCHEMA_MARKER');
  const second = await fixture();
  const { state } = await completedTransaction(second);
  const baseFs = require('node:fs/promises');
  const failingFs = {
    ...baseFs,
    rename: async () => { throw new Error('write failure'); }
  };
  const guard = createMigrationStartupGuard({
    stateFile: second.stateFile,
    schemaFile: second.schemaFile,
    files: second.files,
    fsApi: failingFs
  });
  await assert.rejects(() => guard.writeCompletedMarker(state), error => error.code === 'SCHEMA_MARKER_WRITE_FAILED');
  await assert.rejects(() => fs.access(second.schemaFile));
});

test('middleware bloqueia operações normais durante estado pendente', async () => {
  const testFixture = await fixture();
  const { state } = await completedTransaction(testFixture);
  const guard = guardFor(testFixture);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await guard.middleware()({}, response, () => { response.called = true; });
  assert.equal(response.statusCode, 503);
  assert.equal(response.called, undefined);
  await guard.writeCompletedMarker(state);
  const ready = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await guard.middleware()({}, ready, () => { ready.called = true; });
  assert.equal(ready.called, true);
});

test('a verificação do ciclo de inicialização permanece desativada por padrão', async () => {
  assert.deepEqual(await checkMigrationStartup({ enabled: false, env: {} }), { status: 'disabled' });
});

test('a opção explícita de teste exige todos os caminhos e bloqueia estado pendente', async () => {
  const testFixture = await fixture();
  const transaction = createMigrationTransaction({
    files: testFixture.files,
    stateFile: testFixture.stateFile,
    backupDirectory: testFixture.directory,
    operationId: 'startup-test',
    transform: async source => ({ catalog: source.catalog }),
    validate: async () => {}
  });
  await transaction.prepare();
  const env = {
    QUESTIONS_FILE: testFixture.files.catalog,
    LOCAL_QUESTIONS_FILE: path.join(testFixture.directory, 'changes.json'),
    PROGRESS_FILE: path.join(testFixture.directory, 'progress.json'),
    USER_DATA_FILE: path.join(testFixture.directory, 'user.json'),
    HISTORY_FILE: path.join(testFixture.directory, 'history.json'),
    QUESTIONS_SEQUENCE_FILE: path.join(testFixture.directory, 'sequence.json'),
    MIGRATION_STATE_FILE: testFixture.stateFile,
    MIGRATION_SCHEMA_FILE: testFixture.schemaFile
  };
  await assert.rejects(() => checkMigrationStartup({ enabled: true, env }), error => error.code === 'STARTUP_BLOCKED' || error.code === 'STARTUP_STATE_UNREADABLE');
});
