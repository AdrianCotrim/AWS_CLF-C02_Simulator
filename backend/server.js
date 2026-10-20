'use strict';

const app = require('./src/app');
const historyStore = require('./src/data/historyStore');
const userDataStore = require('./src/data/userDataStore');
const { checkMigrationStartup } = require('./src/migrationStartupCheck');

const port = Number(process.env.PORT) || 3000;

checkMigrationStartup({ enabled: process.env.MIGRATION_STARTUP_GUARD === 'test' })
  .then(() => Promise.all([
    historyStore.ensureHistoryFile(),
    userDataStore.ensureUserDataFile()
  ])).then(() => {
  app.listen(port, '127.0.0.1', () => {
    console.log(`Questions API listening at http://127.0.0.1:${port}`);
  });
}).catch(error => {
  console.error(`Unable to initialize persistent data: ${error.message}`);
  process.exitCode = 1;
});