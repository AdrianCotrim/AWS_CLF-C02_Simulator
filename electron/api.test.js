'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function response(body, ok = true) {
  return {
    ok,
    json: async () => body
  };
}

function loadApi(fetch) {
  const window = {};
  const context = vm.createContext({ window, fetch });
  const source = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  vm.runInContext(source, context);
  return window.QuestionsApi;
}

test('expõe todos os métodos da API usados pelo frontend', () => {
  const methods = loadApi(async () => response({}));
  [
    'getQuestions', 'getCatalogStatus', 'acknowledgeCatalogUpdate', 'getQuestionMetadata',
    'createQuestion', 'importQuestions', 'deleteQuestion', 'deleteAllQuestions', 'updateQuestion',
    'restoreDefaultQuestion', 'createBackup', 'validateBackup', 'restoreBackup',
    'getProgress', 'getUserData', 'updatePreferences', 'saveProgress',
    'previewProgressMigration', 'migrateProgress', 'importProgress'
  ].forEach(method => assert.equal(typeof methods[method], 'function', method));
});

test('carrega e salva preferências pelo mesmo contrato de user-data', async () => {
  const calls = [];
  const methods = loadApi(async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'PATCH') return response({ preferences: { tags: ['Matemática'] } });
    return response({ preferences: { tags: ['Matemática'] } });
  });

  assert.deepEqual(await methods.getUserData(), { preferences: { tags: ['Matemática'] } });
  assert.deepEqual(await methods.updatePreferences({ tags: ['Matemática'] }), {
    preferences: { tags: ['Matemática'] }
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/user-data');
  assert.equal(calls[1].url, 'http://127.0.0.1:3000/api/user-data/preferences');
  assert.equal(calls[1].options.method, 'PATCH');
});
