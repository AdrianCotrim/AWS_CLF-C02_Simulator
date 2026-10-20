'use strict';

const nodeFs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const FORMAT = 'aws-clf-c02-migration-transaction';
const VERSION = 1;
const TERMINAL_PHASES = new Set(['completed', 'recovered']);
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

class MigrationTransactionError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.code = code;
  }
}

function checksum(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function defaultNow() {
  return new Date().toISOString();
}

function validateFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) {
    throw new MigrationTransactionError('INVALID_TARGETS', 'A migração precisa declarar pelo menos um arquivo alvo.');
  }
  for (const [name, filePath] of Object.entries(files)) {
    if (!name || typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new MigrationTransactionError('INVALID_TARGETS', `O caminho do arquivo ${name || '(sem nome)'} é inválido.`);
    }
  }
}

async function assertNoSymlinkPath(fsApi, targetPath, { mustExist = false } = {}) {
  const absolutePath = path.resolve(targetPath);
  const root = path.parse(absolutePath).root;
  let current = absolutePath;
  while (current !== root) {
    try {
      const stat = await fsApi.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new MigrationTransactionError('SYMLINK_NOT_ALLOWED', `O caminho ${current} é um link simbólico e foi rejeitado.`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (mustExist) {
        throw new MigrationTransactionError('PATH_NOT_FOUND', `O caminho ${targetPath} não existe.`, error);
      }
    }
    current = path.dirname(current);
  }
}

function isPathInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isPathWithin(parent, target) {
  return path.resolve(parent) === path.resolve(target) || isPathInside(parent, target);
}

function parseJson(contents, filePath) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new MigrationTransactionError('INVALID_SOURCE_JSON', `O arquivo ${filePath} contém JSON inválido.`, error);
  }
}

function createMigrationTransaction({
  files,
  stateFile,
  backupDirectory,
  operationId = `migration-${randomUUID()}`,
  transform,
  validate,
  fsApi = nodeFs,
  now = defaultNow,
  randomId = randomUUID,
  hooks = {},
  protectedPaths = []
}) {
  validateFiles(files);
  if (!Array.isArray(protectedPaths) || protectedPaths.some(directory => typeof directory !== 'string' || !path.isAbsolute(directory))) {
    throw new MigrationTransactionError('INVALID_PROTECTED_PATHS', 'Os diretórios protegidos devem ser caminhos absolutos.');
  }
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new MigrationTransactionError('INVALID_OPERATION_ID', 'O identificador da operação contém componentes inválidos.');
  }
  if (!stateFile || !path.isAbsolute(stateFile) || !backupDirectory || !path.isAbsolute(backupDirectory)) {
    throw new MigrationTransactionError('INVALID_TRANSACTION_PATHS', 'O estado e o diretório de backup devem ser caminhos absolutos.');
  }
  if (typeof transform !== 'function' || typeof validate !== 'function') {
    throw new MigrationTransactionError('INVALID_TRANSACTION_CALLBACKS', 'A migração precisa fornecer transform e validate.');
  }
  const protectedTargets = [...Object.values(files), stateFile, backupDirectory];
  if (protectedPaths.some(directory => protectedTargets.some(target => isPathWithin(directory, target)))) {
    throw new MigrationTransactionError('PROTECTED_PATH_TARGET', 'A operação não pode escrever em um diretório protegido.');
  }

  const names = Object.keys(files);
  const backupPath = path.join(backupDirectory, operationId);
  const temporaryFiles = Object.fromEntries(names.map(name => [
    name,
    `${files[name]}.${process.pid}.${randomId()}.migration`
  ]));

  async function writeState(state, { exclusive = false } = {}) {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    await fsApi.mkdir(path.dirname(stateFile), { recursive: true });
    if (exclusive) {
      await fsApi.writeFile(stateFile, payload, { flag: 'wx' });
      return;
    }
    const temporaryState = `${stateFile}.${process.pid}.${randomId()}.tmp`;
    try {
      await fsApi.writeFile(temporaryState, payload, { flag: 'wx' });
      await fsApi.rename(temporaryState, stateFile);
    } catch (error) {
      await fsApi.rm(temporaryState, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function readState() {
    await assertNoSymlinkPath(fsApi, stateFile);
    let contents;
    try {
      contents = await fsApi.readFile(stateFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new MigrationTransactionError('STATE_READ_FAILED', 'Não foi possível ler o estado da migração.', error);
    }
    try {
      const state = JSON.parse(contents);
      if (!state || state.format !== FORMAT || state.version !== VERSION || state.operationId !== operationId) {
        throw new MigrationTransactionError('AMBIGUOUS_STATE', 'O estado persistido da migração não corresponde à operação atual.');
      }
      return state;
    } catch (error) {
      if (error instanceof MigrationTransactionError) throw error;
      throw new MigrationTransactionError('AMBIGUOUS_STATE', 'O estado persistido da migração está corrompido.', error);
    }
  }

  async function removeTemporaryFiles(state = null) {
    const paths = state?.temporaryFiles || temporaryFiles;
    await Promise.all(Object.values(paths).map(filePath => fsApi.rm(filePath, { force: true })));
  }

  async function prepare() {
    for (const [name, filePath] of Object.entries(files)) {
      try {
        await assertNoSymlinkPath(fsApi, filePath, { mustExist: true });
      } catch (error) {
        if (error.code === 'PATH_NOT_FOUND') {
          throw new MigrationTransactionError('SOURCE_READ_FAILED', `Não foi possível ler ${name}.`, error);
        }
        throw error;
      }
    }
    await assertNoSymlinkPath(fsApi, stateFile);
    await assertNoSymlinkPath(fsApi, backupDirectory);
    const existing = await readState();
    if (existing) {
      if (TERMINAL_PHASES.has(existing.phase)) {
        throw new MigrationTransactionError('OPERATION_ALREADY_FINISHED', `A operação de migração já está no estado ${existing.phase}.`);
      }
      throw new MigrationTransactionError('OPERATION_PENDING', `Há uma operação de migração pendente no estado ${existing.phase}.`);
    }

    const state = {
      format: FORMAT,
      version: VERSION,
      operationId,
      phase: 'preparing',
      createdAt: now(),
      updatedAt: now(),
      files: clone(files),
      temporaryFiles: clone(temporaryFiles),
      backupPath,
      backupManifest: null
    };
    try {
      await writeState(state, { exclusive: true });
      await hooks.afterState?.(clone(state));

      const originals = {};
      for (const name of names) {
        try {
          originals[name] = await fsApi.readFile(files[name], 'utf8');
        } catch (error) {
          throw new MigrationTransactionError('SOURCE_READ_FAILED', `Não foi possível ler ${name}.`, error);
        }
      }

      await fsApi.mkdir(backupPath, { recursive: true });
      await assertNoSymlinkPath(fsApi, backupPath);
      const backupManifest = {
        format: FORMAT,
        version: VERSION,
        operationId,
        createdAt: now(),
        files: {}
      };
      for (const name of names) {
        const backupFile = path.join(backupPath, `${name}.json`);
        await assertNoSymlinkPath(fsApi, backupFile);
        await fsApi.writeFile(backupFile, originals[name], { flag: 'wx' });
        backupManifest.files[name] = {
          originalPath: files[name],
          backupPath: backupFile,
          checksum: checksum(originals[name])
        };
      }
      const manifestFile = path.join(backupPath, 'manifest.json');
      await assertNoSymlinkPath(fsApi, manifestFile);
      await fsApi.writeFile(manifestFile, `${JSON.stringify(backupManifest, null, 2)}\n`, { flag: 'wx' });
      state.backupManifest = manifestFile;
      state.phase = 'backup-created';
      state.updatedAt = now();
      await writeState(state);
      await hooks.afterBackup?.(clone(state));

      for (const name of names) {
        const current = await fsApi.readFile(files[name], 'utf8');
        if (current !== originals[name]) {
          throw new MigrationTransactionError('SOURCE_CHANGED', `O arquivo ${name} mudou durante a preparação.`);
        }
      }

      const source = Object.fromEntries(names.map(name => [name, parseJson(originals[name], files[name])]));
      const converted = await transform(clone(source));
      if (!converted || typeof converted !== 'object' || Array.isArray(converted)) {
        throw new MigrationTransactionError('INVALID_PREPARED_DATA', 'A transformação não retornou um objeto de arquivos.');
      }
      for (const name of names) {
        if (!Object.hasOwn(converted, name)) {
          throw new MigrationTransactionError('INVALID_PREPARED_DATA', `A transformação não retornou o arquivo ${name}.`);
        }
      }
      await validate(clone(converted), { source: clone(source), state: clone(state) });

      for (const name of names) {
        await fsApi.writeFile(temporaryFiles[name], `${JSON.stringify(converted[name], null, 2)}\n`, { flag: 'wx' });
      }
      state.phase = 'prepared';
      state.updatedAt = now();
      await writeState(state);
      await hooks.afterPrepare?.(clone(state));
      return clone(state);
    } catch (error) {
      await removeTemporaryFiles(state).catch(() => {});
      if (error && error.code === 'EEXIST') {
        throw new MigrationTransactionError('OPERATION_PENDING', 'Outra operação de migração já possui o estado desta operação.');
      }
      if (error instanceof MigrationTransactionError) throw error;
      throw new MigrationTransactionError('PREPARATION_FAILED', 'A preparação da migração falhou.', error);
    }
  }

  async function validatePrepared(state) {
    const prepared = {};
    for (const name of names) {
      const contents = await fsApi.readFile(state.temporaryFiles[name], 'utf8');
      prepared[name] = parseJson(contents, state.temporaryFiles[name]);
    }
    await validate(clone(prepared), { prepared: true, state: clone(state) });
    return prepared;
  }

  async function commit() {
    const state = await readState();
    if (!state) throw new MigrationTransactionError('NO_PREPARED_OPERATION', 'Não há uma operação preparada para concluir.');
    if (state.phase !== 'prepared') {
      throw new MigrationTransactionError('OPERATION_NOT_READY', `A operação está no estado ${state.phase} e não pode ser concluída.`);
    }
    await validatePrepared(state);
    state.phase = 'committing';
    state.updatedAt = now();
    await writeState(state);
    try {
      for (const name of names) {
        await hooks.beforeReplace?.(name, clone(state));
        await fsApi.rename(state.temporaryFiles[name], files[name]);
        await hooks.afterReplace?.(name, clone(state));
      }
      const finalContents = {};
      for (const name of names) {
        finalContents[name] = parseJson(await fsApi.readFile(files[name], 'utf8'), files[name]);
      }
      await validate(clone(finalContents), { final: true, state: clone(state) });
      state.phase = 'completed';
      state.updatedAt = now();
      await writeState(state);
      await removeTemporaryFiles(state);
      return clone(state);
    } catch (error) {
      state.phase = 'recovery-needed';
      state.updatedAt = now();
      await writeState(state).catch(() => {});
      throw error instanceof MigrationTransactionError
        ? error
        : new MigrationTransactionError('COMMIT_FAILED', 'A substituição falhou; a recuperação está disponível.', error);
    }
  }

  async function recover() {
    const state = await readState();
    if (!state) throw new MigrationTransactionError('NO_PENDING_OPERATION', 'Não há operação pendente para recuperar.');
    if (state.phase === 'completed' || state.phase === 'recovered') {
      throw new MigrationTransactionError('OPERATION_ALREADY_FINISHED', `A operação já está no estado ${state.phase}.`);
    }
    if (!['preparing', 'backup-created', 'prepared', 'committing', 'recovery-needed'].includes(state.phase)) {
      throw new MigrationTransactionError('AMBIGUOUS_STATE', `O estado ${state.phase} não possui recuperação segura.`);
    }
    if (!state.backupManifest) {
      await removeTemporaryFiles(state);
      state.phase = 'recovered';
      state.updatedAt = now();
      await writeState(state);
      return clone(state);
    }

    if (!state.files || !state.temporaryFiles || state.backupPath !== path.join(backupDirectory, operationId)
      || Object.keys(state.files).length !== names.length
      || names.some(name => state.files[name] !== files[name])) {
      throw new MigrationTransactionError('AMBIGUOUS_STATE', 'O estado persistido contém caminhos que não pertencem à operação.');
    }
    await assertNoSymlinkPath(fsApi, state.backupManifest, { mustExist: true });
    let manifest;
    try {
      manifest = JSON.parse(await fsApi.readFile(state.backupManifest, 'utf8'));
    } catch (error) {
      throw new MigrationTransactionError('BACKUP_INVALID', 'O manifesto do backup é inválido.', error);
    }
    if (!manifest || manifest.format !== FORMAT || manifest.version !== VERSION
      || manifest.operationId !== operationId || !manifest.files
      || Object.keys(manifest.files).length !== names.length
      || names.some(name => !manifest.files[name])) {
      throw new MigrationTransactionError('BACKUP_INVALID', 'O manifesto do backup não corresponde à operação.');
    }
    for (const name of names) {
      const entry = manifest.files[name];
      if (entry.originalPath !== files[name] || typeof entry.backupPath !== 'string'
        || path.resolve(entry.backupPath) !== path.resolve(path.join(state.backupPath, `${name}.json`))
        || !isPathInside(state.backupPath, entry.backupPath)
        || typeof entry.checksum !== 'string' || !CHECKSUM_PATTERN.test(entry.checksum)) {
        throw new MigrationTransactionError('BACKUP_INVALID', `O manifesto do backup contém um caminho não autorizado para ${name}.`);
      }
      await assertNoSymlinkPath(fsApi, entry.backupPath, { mustExist: true });
      const original = await fsApi.readFile(entry.backupPath, 'utf8');
      if (checksum(original) !== entry.checksum) {
        throw new MigrationTransactionError('BACKUP_INVALID', `O backup de ${name} não passou pela verificação.`);
      }
      const restoreFile = `${files[name]}.${process.pid}.${randomId()}.restore`;
      await assertNoSymlinkPath(fsApi, files[name]);
      await assertNoSymlinkPath(fsApi, restoreFile);
      try {
        await fsApi.writeFile(restoreFile, original, { flag: 'wx' });
        await fsApi.rename(restoreFile, files[name]);
      } catch (error) {
        await fsApi.rm(restoreFile, { force: true }).catch(() => {});
        throw new MigrationTransactionError('RECOVERY_FAILED', `A recuperação de ${name} falhou; a operação continua pendente.`, error);
      }
    }
    for (const name of names) parseJson(await fsApi.readFile(files[name], 'utf8'), files[name]);
    await removeTemporaryFiles(state);
    state.phase = 'recovered';
    state.updatedAt = now();
    await writeState(state);
    return clone(state);
  }

  return { prepare, commit, recover, readState, validatePrepared };
}

module.exports = {
  FORMAT,
  VERSION,
  MigrationTransactionError,
  createMigrationTransaction
};
