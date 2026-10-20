'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  MigrationTransactionError,
  createMigrationTransaction
} = require('../src/data/migrationTransaction');

const temporaryDirectories = [];

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-transaction-'));
  temporaryDirectories.push(directory);
  const files = {
    catalog: path.join(directory, 'questions.json'),
    progress: path.join(directory, 'progress.json'),
    history: path.join(directory, 'history.json'),
    userData: path.join(directory, 'user-data.json')
  };
  const contents = {
    catalog: [{ id: 'personal-001', question: 'Questão', tag: 'Tecnologia', source: 'Personal' }],
    progress: { version: 1, questionProgress: { 'personal-001': { timesAnswered: 1 } }, history: [], session: null },
    history: { version: 1, attempts: [{ questionId: 'personal-001', source: 'Personal' }] },
    userData: { version: 1, errorBank: ['personal-001'], personalQuestions: [] }
  };
  for (const [name, value] of Object.entries(contents)) {
    await fs.writeFile(files[name], `${JSON.stringify(value)}\n`);
  }
  return {
    directory,
    files,
    stateFile: path.join(directory, 'migration-state.json'),
    backupDirectory: path.join(directory, 'backups'),
    contents
  };
}

function makeTransaction(fixture, options = {}) {
  return createMigrationTransaction({
    files: fixture.files,
    stateFile: fixture.stateFile,
    backupDirectory: fixture.backupDirectory,
    operationId: Object.hasOwn(options, 'operationId') ? options.operationId : 'numeric-ids-v2',
    fsApi: options.fsApi,
    hooks: options.hooks,
    protectedPaths: options.protectedPaths,
    transform: async source => ({
      catalog: source.catalog.map(question => ({ id: '1', question: question.question, tag: question.tag })),
      progress: { ...source.progress, questionProgress: { '1': source.progress.questionProgress['personal-001'] } },
      history: { ...source.history, attempts: [{ questionId: '1' }] },
      userData: { ...source.userData, errorBank: ['1'] }
    }),
    validate: async prepared => {
      if (!prepared.catalog.every(question => /^[1-9]\d*$/.test(question.id))) {
        throw new MigrationTransactionError('INVALID_PREPARED_DATA', 'ID preparado inválido.');
      }
      if (!prepared.progress.questionProgress['1']
        || prepared.history.attempts[0].questionId !== '1'
        || prepared.userData.errorBank[0] !== '1') {
        throw new MigrationTransactionError('INVALID_REFERENCES', 'Referência preparada inválida.');
      }
    }
  });
}

afterEach(async () => {
  while (temporaryDirectories.length) {
    await fs.rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test('cria backup completo e prepara sem alterar os arquivos originais', async () => {
  const fixture = await createFixture();
  const transaction = makeTransaction(fixture);
  const state = await transaction.prepare();

  assert.equal(state.phase, 'prepared');
  for (const [name, filePath] of Object.entries(fixture.files)) {
    assert.equal(await fs.readFile(filePath, 'utf8'), `${JSON.stringify(fixture.contents[name])}\n`);
  }
  assert.equal((await fs.readdir(state.backupPath)).sort().length, 5);
  assert.equal((await transaction.readState()).phase, 'prepared');
});

test('rejeita temporário inválido antes de qualquer substituição', async () => {
  const fixture = await createFixture();
  const transaction = makeTransaction(fixture);
  const state = await transaction.prepare();
  await fs.writeFile(state.temporaryFiles.catalog, '{ inválido');

  await assert.rejects(() => transaction.validatePrepared(state), error => error.code === 'INVALID_SOURCE_JSON');
  assert.equal(await fs.readFile(fixture.files.catalog, 'utf8'), `${JSON.stringify(fixture.contents.catalog)}\n`);
});

test('recupera após falha de substituição parcial', async () => {
  const fixture = await createFixture();
  const transaction = makeTransaction(fixture, {
    hooks: {
      beforeReplace: name => {
        if (name === 'progress') throw new Error('falha injetada');
      }
    }
  });
  await transaction.prepare();
  await assert.rejects(() => transaction.commit(), error => error.code === 'COMMIT_FAILED');
  assert.equal((await transaction.readState()).phase, 'recovery-needed');

  const recovered = await transaction.recover();
  assert.equal(recovered.phase, 'recovered');
  for (const [name, filePath] of Object.entries(fixture.files)) {
    assert.equal(await fs.readFile(filePath, 'utf8'), `${JSON.stringify(fixture.contents[name])}\n`);
  }
});

test('identifica operação interrompida e permite recuperação determinística', async () => {
  const fixture = await createFixture();
  const first = makeTransaction(fixture);
  await first.prepare();
  const second = makeTransaction(fixture);
  await assert.rejects(() => second.prepare(), error => error.code === 'OPERATION_PENDING');
  const recovered = await second.recover();
  assert.equal(recovered.phase, 'recovered');
});

test('não permite duas operações simultâneas e preserva backup concluído', async () => {
  const fixture = await createFixture();
  const first = makeTransaction(fixture);
  const second = makeTransaction(fixture);
  const results = await Promise.allSettled([first.prepare(), second.prepare()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected')[0].reason.code, 'OPERATION_PENDING');
  const state = await first.readState();
  const manifestBefore = await fs.readFile(state.backupManifest, 'utf8');
  await first.commit();
  assert.equal(await fs.readFile(state.backupManifest, 'utf8'), manifestBefore);
});

test('mantém backup válido e remove temporários somente após sucesso', async () => {
  const fixture = await createFixture();
  const transaction = makeTransaction(fixture);
  const prepared = await transaction.prepare();
  for (const filePath of Object.values(prepared.temporaryFiles)) assert.equal((await fs.stat(filePath)).isFile(), true);

  const completed = await transaction.commit();
  assert.equal(completed.phase, 'completed');
  for (const filePath of Object.values(prepared.temporaryFiles)) {
    await assert.rejects(() => fs.access(filePath));
  }
  await assert.doesNotReject(() => fs.access(prepared.backupManifest));
});

test('mantém estado pendente quando a recuperação é interrompida e permite retomada', async () => {
  const fixture = await createFixture();
  let failRecovery = true;
  const baseFs = require('node:fs/promises');
  const fsApi = {
    ...baseFs,
    rename: async (source, destination) => {
      if (failRecovery && source.endsWith('.restore')) throw new Error('falha de recuperação');
      return baseFs.rename(source, destination);
    }
  };
  const transaction = makeTransaction(fixture, {
    fsApi,
    hooks: { beforeReplace: name => { if (name === 'history') throw new Error('falha de commit'); } }
  });
  await transaction.prepare();
  await assert.rejects(() => transaction.commit());
  await assert.rejects(() => transaction.recover(), error => error.code === 'RECOVERY_FAILED');
  assert.equal((await transaction.readState()).phase, 'recovery-needed');
  failRecovery = false;
  assert.equal((await transaction.recover()).phase, 'recovered');
});

test('rejeita estado corrompido como ambíguo', async () => {
  const fixture = await createFixture();
  await fs.writeFile(fixture.stateFile, '{ inválido');
  const transaction = makeTransaction(fixture);
  await assert.rejects(() => transaction.prepare(), error => error.code === 'AMBIGUOUS_STATE');
  await assert.rejects(() => transaction.recover(), error => error.code === 'AMBIGUOUS_STATE');
});

test('rejeita operationId com traversal ou separadores', async () => {
  const fixture = await createFixture();
  for (const operationId of ['../escape', 'nested/value', 'nested\\value', '', '.hidden']) {
    assert.throws(() => makeTransaction(fixture, { operationId }), error => error.code === 'INVALID_OPERATION_ID');
  }
});

test('rejeita destinos dentro de diretórios explicitamente protegidos', async () => {
  const fixture = await createFixture();
  assert.throws(
    () => makeTransaction(fixture, { protectedPaths: [fixture.directory] }),
    error => error.code === 'PROTECTED_PATH_TARGET'
  );
});

test('rejeita manifesto adulterado sem sobrescrever os arquivos originais', async () => {
  const fixture = await createFixture();
  const transaction = makeTransaction(fixture);
  const state = await transaction.prepare();
  const manifest = JSON.parse(await fs.readFile(state.backupManifest, 'utf8'));
  manifest.files.catalog.backupPath = path.join(fixture.directory, 'outside.json');
  await fs.writeFile(state.backupManifest, JSON.stringify(manifest));

  await assert.rejects(() => transaction.recover(), error => error.code === 'BACKUP_INVALID');
  assert.equal(await fs.readFile(fixture.files.catalog, 'utf8'), `${JSON.stringify(fixture.contents.catalog)}\n`);
});

test('rejeita symlink em caminho de origem', async () => {
  const fixture = await createFixture();
  const baseFs = require('node:fs/promises');
  const fsApi = {
    ...baseFs,
    lstat: async filePath => {
      if (filePath === fixture.files.catalog) return { isSymbolicLink: () => true };
      return baseFs.lstat(filePath);
    }
  };
  const transaction = createMigrationTransaction({
    files: fixture.files,
    stateFile: fixture.stateFile,
    backupDirectory: fixture.backupDirectory,
    operationId: 'safe-operation',
    fsApi,
    transform: async source => source,
    validate: async () => {}
  });
  await assert.rejects(() => transaction.prepare(), error => error.code === 'SYMLINK_NOT_ALLOWED');
});
