'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

test('o seed distribuído é vazio e o catálogo de desenvolvimento permanece separado', () => {
  const distributedQuestions = JSON.parse(fs.readFileSync(
    path.join(root, 'distribution', 'questions.json'),
    'utf8'
  ));
  const developmentQuestions = JSON.parse(fs.readFileSync(
    path.join(root, 'data', 'questions.json'),
    'utf8'
  ));

  assert.deepEqual(distributedQuestions, []);
  assert.ok(developmentQuestions.length > 0);
});

test('o Electron Builder inclui somente o seed distribuído de questões', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(packageJson.build.files.includes('distribution/questions.json'));
  assert.ok(!packageJson.build.files.includes('data/questions.json'));

  const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  assert.match(mainSource, /path\.join\(app\.getAppPath\(\), 'distribution', 'questions\.json'\)/);
  assert.match(mainSource, /QUESTIONS_SEQUENCE_FILE = path\.join\(userDataDirectory, 'questions\.json\.sequence\.json'\)/);
});
