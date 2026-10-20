'use strict';

const { createMigrationStartupGuard } = require('./data/migrationStartupGuard');

const REQUIRED_PATH_ENV = [
  'QUESTIONS_FILE',
  'LOCAL_QUESTIONS_FILE',
  'PROGRESS_FILE',
  'USER_DATA_FILE',
  'HISTORY_FILE',
  'QUESTIONS_SEQUENCE_FILE',
  'MIGRATION_STATE_FILE',
  'MIGRATION_SCHEMA_FILE'
];

async function checkMigrationStartup({ enabled = false, env = process.env } = {}) {
  if (!enabled) return { status: 'disabled' };
  const missing = REQUIRED_PATH_ENV.filter(name => typeof env[name] !== 'string' || !env[name]);
  if (missing.length) {
    const error = new Error(`A verificação de migração exige os caminhos: ${missing.join(', ')}.`);
    error.code = 'MIGRATION_STARTUP_PATHS_MISSING';
    throw error;
  }
  const guard = createMigrationStartupGuard({
    stateFile: env.MIGRATION_STATE_FILE,
    schemaFile: env.MIGRATION_SCHEMA_FILE,
    files: {
      catalog: env.QUESTIONS_FILE,
      changes: env.LOCAL_QUESTIONS_FILE,
      progress: env.PROGRESS_FILE,
      userData: env.USER_DATA_FILE,
      history: env.HISTORY_FILE,
      questionSequence: env.QUESTIONS_SEQUENCE_FILE
    }
  });
  return guard.assertReady();
}

module.exports = { REQUIRED_PATH_ENV, checkMigrationStartup };
