'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('catálogo distribuído vazio inicializa e aceita a primeira importação', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'distributed-seed-'));
  const files = {
    catalog: path.join(directory, 'questions.json'),
    changes: path.join(directory, 'questions.local.json'),
    sequence: path.join(directory, 'questions.json.sequence.json'),
    userData: path.join(directory, 'user-data.json'),
    history: path.join(directory, 'history.json')
  };
  await fs.writeFile(files.catalog, '[]\n');
  await fs.writeFile(files.userData, JSON.stringify({
    version: 1,
    personalQuestions: [],
    errorBank: [],
    preferences: {},
    updatedAt: null,
    createdAt: null
  }));
  await fs.writeFile(files.history, JSON.stringify({
    version: 1,
    attempts: [],
    updatedAt: null,
    createdAt: null
  }));

  const script = `
    const app = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'app.js'))});
    const server = app.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      try {
        const initial = await fetch(base + '/api/questions');
        if (initial.status !== 200 || (await initial.json()).length !== 0) throw new Error('catálogo inicial não está vazio');
        const imported = await fetch(base + '/api/questions/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confirm: true,
            questions: [{
              source: 'Personal',
              tag: 'Teste',
              question: 'Qual serviço oferece armazenamento de objetos?',
              options: ['Amazon S3', 'Amazon EC2'],
              correct_answer: 'Amazon S3',
              explanation: 'Teste de importação.'
            }]
          })
        });
        if (![200, 201].includes(imported.status)) throw new Error('importação rejeitada: ' + await imported.text());
        const final = await fetch(base + '/api/questions');
        if ((await final.json()).length !== 1) throw new Error('questão importada não ficou disponível');
        server.closeAllConnections();
        server.close();
      } catch (error) {
        console.error(error);
        server.close(() => process.exit(1));
      }
    });
  `;
  const child = spawn(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      QUESTIONS_FILE: files.catalog,
      LOCAL_QUESTIONS_FILE: files.changes,
      QUESTIONS_SEQUENCE_FILE: files.sequence,
      USER_DATA_FILE: files.userData,
      HISTORY_FILE: files.history
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  try {
    assert.equal(exitCode, 0, stderr);
    const sequence = JSON.parse(await fs.readFile(files.sequence, 'utf8'));
    assert.equal(sequence.lastIssued, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
