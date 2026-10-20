'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const TRANSACTION_FORMAT = 'aws-clf-c02-migration-transaction';
const TRANSACTION_VERSION = 1;
const SCHEMA_FORMAT = 'aws-clf-c02-data-schema';
const SCHEMA_VERSION = 1;
const MIGRATED_SCHEMA_VERSION = 2;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

class MigrationStartupError extends Error {
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

function createMigrationStartupGuard({ stateFile, schemaFile, files = {}, fsApi = fs, expectedSchemaVersion = MIGRATED_SCHEMA_VERSION }) {
  if (!path.isAbsolute(stateFile || '') || !path.isAbsolute(schemaFile || '')) {
    throw new MigrationStartupError('INVALID_STARTUP_PATHS', 'Estado transacional e marcador devem usar caminhos absolutos.');
  }
  if (!Number.isSafeInteger(expectedSchemaVersion) || expectedSchemaVersion < 1) {
    throw new MigrationStartupError('INVALID_SCHEMA_VERSION', 'A versão esperada do esquema é inválida.');
  }
  for (const [name, filePath] of Object.entries(files)) {
    if (!name || !path.isAbsolute(filePath)) {
      throw new MigrationStartupError('INVALID_STARTUP_PATHS', `O caminho de ${name || '(sem nome)'} é inválido.`);
    }
  }

  async function assertRegularFile(filePath, required) {
    let stat;
    try {
      stat = await fsApi.lstat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT' && !required) return false;
      throw new MigrationStartupError('STARTUP_STATE_UNREADABLE', `Não foi possível acessar ${filePath}.`, error);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new MigrationStartupError('STARTUP_PATH_UNSAFE', `O caminho ${filePath} não é um arquivo regular seguro.`);
    }
    return true;
  }

  async function readJson(filePath, code) {
    await assertRegularFile(filePath, true);
    try {
      return JSON.parse(await fsApi.readFile(filePath, 'utf8'));
    } catch (error) {
      throw new MigrationStartupError(code, `O arquivo ${filePath} contém JSON inválido.`, error);
    }
  }

  async function readOptionalJson(filePath, code) {
    if (!(await assertRegularFile(filePath, false))) return null;
    return readJson(filePath, code);
  }

  function validateTransaction(state) {
    if (!state || state.format !== TRANSACTION_FORMAT || state.version !== TRANSACTION_VERSION
      || typeof state.operationId !== 'string' || !OPERATION_ID_PATTERN.test(state.operationId)
      || !['preparing', 'backup-created', 'prepared', 'committing', 'recovery-needed', 'completed', 'recovered'].includes(state.phase)
      || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)) {
      throw new MigrationStartupError('AMBIGUOUS_STATE', 'O estado transacional é inválido ou ambíguo.');
    }
    for (const [name, filePath] of Object.entries(state.files)) {
      if (!name || !path.isAbsolute(filePath)) {
        throw new MigrationStartupError('AMBIGUOUS_STATE', 'O estado transacional contém caminho inválido.');
      }
    }
    return state;
  }

  function validateSchema(marker) {
    if (!marker || marker.format !== SCHEMA_FORMAT || marker.version !== SCHEMA_VERSION
      || marker.schemaVersion !== expectedSchemaVersion
      || typeof marker.operationId !== 'string' || !OPERATION_ID_PATTERN.test(marker.operationId)
      || marker.transactionState !== 'completed'
      || typeof marker.completedAt !== 'string' || !Number.isFinite(Date.parse(marker.completedAt))
      || !marker.files || typeof marker.files !== 'object' || Array.isArray(marker.files)) {
      throw new MigrationStartupError('INVALID_SCHEMA_MARKER', 'O marcador global de esquema é inválido.');
    }
    for (const [name, entry] of Object.entries(marker.files)) {
      if (!name || !entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)
        || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new MigrationStartupError('INVALID_SCHEMA_MARKER', 'O marcador global contém checksum ou caminho inválido.');
      }
    }
    return marker;
  }

  async function validateSchemaFiles(marker) {
    for (const [name, entry] of Object.entries(marker.files)) {
      if (files[name] !== undefined && files[name] !== entry.path) {
        throw new MigrationStartupError('UNAUTHORIZED_PATH', `O marcador contém caminho não autorizado para ${name}.`);
      }
      const contents = await fsApi.readFile(entry.path, 'utf8');
      if (checksum(contents) !== entry.sha256) {
        throw new MigrationStartupError('SCHEMA_DATA_MISMATCH', `O arquivo marcado ${name} não corresponde ao checksum registrado.`);
      }
    }
  }

  async function inspect() {
    const transaction = await readOptionalJson(stateFile, 'AMBIGUOUS_STATE');
    const schema = await readOptionalJson(schemaFile, 'INVALID_SCHEMA_MARKER');
    if (transaction) validateTransaction(transaction);
    if (schema) {
      validateSchema(schema);
      await validateSchemaFiles(schema);
    }

    if (transaction && ['preparing', 'backup-created', 'prepared', 'committing', 'recovery-needed'].includes(transaction.phase)) {
      return { status: 'migration-pending', transaction: clone(transaction), schema: schema ? clone(schema) : null };
    }
    if (transaction && transaction.phase === 'completed') {
      if (!schema) return { status: 'ambiguous', transaction: clone(transaction), schema: null };
      if (schema.operationId !== transaction.operationId) {
        throw new MigrationStartupError('AMBIGUOUS_STATE', 'O marcador e o estado transacional pertencem a operações diferentes.');
      }
      return { status: 'migration-completed', transaction: clone(transaction), schema: clone(schema) };
    }
    if (transaction && transaction.phase === 'recovered') {
      return { status: 'recovered', transaction: clone(transaction), schema: schema ? clone(schema) : null };
    }
    if (schema) return { status: 'ambiguous', transaction: null, schema: clone(schema) };
    return { status: 'legacy', transaction: null, schema: null };
  }

  async function writeCompletedMarker(transactionState) {
    const state = validateTransaction(transactionState);
    if (state.phase !== 'completed') {
      throw new MigrationStartupError('TRANSACTION_NOT_COMPLETE', 'O marcador só pode ser gravado após a transação concluída.');
    }
    if (Object.keys(files).length && (Object.keys(state.files).length !== Object.keys(files).length
      || Object.entries(files).some(([name, filePath]) => state.files[name] !== filePath))) {
      throw new MigrationStartupError('UNAUTHORIZED_PATH', 'A transação não corresponde aos caminhos autorizados.');
    }
    for (const [name, filePath] of Object.entries(state.files)) {
      if (files[name] !== undefined && files[name] !== filePath) {
        throw new MigrationStartupError('UNAUTHORIZED_PATH', `O caminho de ${name} não pertence ao conjunto autorizado.`);
      }
      const contents = await fsApi.readFile(filePath, 'utf8');
      try {
        JSON.parse(contents);
      } catch (error) {
        throw new MigrationStartupError('FINAL_DATA_INVALID', `O arquivo final ${name} não é JSON válido.`, error);
      }
    }
    const fileChecksums = {};
    for (const [name, filePath] of Object.entries(state.files)) {
      fileChecksums[name] = { path: filePath, sha256: checksum(await fsApi.readFile(filePath, 'utf8')) };
    }
    const marker = {
      format: SCHEMA_FORMAT,
      version: SCHEMA_VERSION,
      schemaVersion: expectedSchemaVersion,
      operationId: state.operationId,
      transactionState: 'completed',
      completedAt: new Date().toISOString(),
      files: fileChecksums
    };
    await fsApi.mkdir(path.dirname(schemaFile), { recursive: true });
    const temporaryFile = `${schemaFile}.${process.pid}.tmp`;
    try {
      await fsApi.writeFile(temporaryFile, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
      await fsApi.rename(temporaryFile, schemaFile);
    } catch (error) {
      await fsApi.rm(temporaryFile, { force: true }).catch(() => {});
      throw new MigrationStartupError('SCHEMA_MARKER_WRITE_FAILED', 'Não foi possível gravar o marcador de esquema.', error);
    }
    return clone(marker);
  }

  function assertReady({ allowLegacy = true } = {}) {
    return inspect().then(result => {
      if (result.status === 'legacy' && allowLegacy) return result;
      if (result.status !== 'migration-completed' && result.status !== 'legacy') {
        throw new MigrationStartupError('STARTUP_BLOCKED', `A inicialização está bloqueada pelo estado ${result.status}.`);
      }
      return result;
    });
  }

  function middleware(options) {
    return async (request, response, next) => {
      try {
        await assertReady(options);
        next();
      } catch (error) {
        response.status(503).json({ error: { code: error.code, message: error.message } });
      }
    };
  }

  return { inspect, assertReady, writeCompletedMarker, middleware };
}

module.exports = {
  MIGRATED_SCHEMA_VERSION,
  MigrationStartupError,
  createMigrationStartupGuard
};
