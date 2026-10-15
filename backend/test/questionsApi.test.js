'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

let directory;
let questionsFile;
let userDataFile;
let historyFile;
let backupDirectory;
let server;
let baseUrl;

const initialQuestions = [
  {
    id: 'personal-002',
    source: 'Personal',
    tag: 'Conceitos de nuvem',
    question: 'Questão existente 2?',
    options: ['Alternativa A', 'Alternativa B'],
    correct_answer: 'Alternativa A',
    explanation: 'Explicação existente.'
  },
  {
    id: 'personal-088',
    source: 'Personal',
    tag: 'Conceitos de nuvem',
    question: 'Questão existente 88?',
    options: ['Alternativa A', 'Alternativa B'],
    correct_answer: 'A',
    explanation: 'Explicação existente.'
  }
];

const validQuestion = {
  source: 'Personal',
  tag: 'Conceitos de nuvem',
  question: 'Qual é outro nome para implantação on-premises?',
  options: ['Nuvem privada', 'Aplicativo baseado na nuvem', 'Implantação híbrida', 'Nuvem AWS'],
  correct_answer: 'A',
  explanation: 'Uma implantação on-premises também é chamada de implantação de nuvem privada.'
};

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'questions-api-'));
  questionsFile = path.join(directory, 'questions.json');
  userDataFile = path.join(directory, 'user-data.json');
  historyFile = path.join(directory, 'history.json');
  backupDirectory = path.join(directory, 'backups');

  await fs.writeFile(questionsFile, JSON.stringify(initialQuestions));
  await fs.writeFile(userDataFile, JSON.stringify({ version: 1, personalQuestions: [], errorBank: [], preferences: {}, updatedAt: null, createdAt: null }));
  await fs.writeFile(historyFile, JSON.stringify({ version: 1, attempts: [], updatedAt: null, createdAt: null }));

  process.env.QUESTIONS_FILE = questionsFile;
  process.env.USER_DATA_FILE = userDataFile;
  process.env.HISTORY_FILE = historyFile;
  process.env.BACKUP_DIRECTORY = backupDirectory;

  const app = require('../src/app');
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  delete process.env.QUESTIONS_FILE;
  delete process.env.USER_DATA_FILE;
  delete process.env.HISTORY_FILE;
  delete process.env.BACKUP_DIRECTORY;
});

test('GET retorna o banco e a questão pelo ID', async () => {
  const listResponse = await fetch(`${baseUrl}/api/questions`, {
    headers: { Origin: 'http://localhost:5500' }
  });
  const questions = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get('access-control-allow-origin'), 'http://localhost:5500');
  assert.equal(questions.length, 2);

  const itemResponse = await fetch(`${baseUrl}/api/questions/personal-088`);
  assert.equal(itemResponse.status, 200);
  assert.equal((await itemResponse.json()).id, 'personal-088');
});

test('GET responde 404 quando a questão não existe', async () => {
  const response = await fetch(`${baseUrl}/api/questions/inexistente`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'QUESTION_NOT_FOUND');
});

test('POST valida o payload e não aceita ID fornecido pelo cliente', async () => {
  const invalidQuestions = [
    { ...validQuestion, id: 'personal-999' },
    { ...validQuestion, options: ['Única alternativa'] },
    { ...validQuestion, correct_answer: 'Resposta inexistente' },
    { ...validQuestion, correct_answer: [] },
    { ...validQuestion, correct_answer: ['A', 'A'] },
    { ...validQuestion, correct_answer: ['A', 'Z'] }
  ];

  for (const question of invalidQuestions) {
    const response = await fetch(`${baseUrl}/api/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(question)
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_QUESTION');
  }

  assert.equal(JSON.parse(await fs.readFile(questionsFile, 'utf8')).length, 2);
});

test('POST gera IDs acima do maior existente mesmo em inclusões concorrentes', async () => {
  const responses = await Promise.all([validQuestion, { ...validQuestion, question: 'Segunda questão de teste?' }].map(question =>
    fetch(`${baseUrl}/api/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(question)
    })
  ));
  const created = await Promise.all(responses.map(response => response.json()));

  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  assert.deepEqual(created.map(question => question.id), ['personal-089', 'personal-090']);
  assert.deepEqual(created.map(question => question.correct_answer), ['A', 'A']);

  const persisted = JSON.parse(await fs.readFile(questionsFile, 'utf8'));
  assert.deepEqual(persisted.slice(-2).map(question => question.id), ['personal-089', 'personal-090']);
});

test('POST aceita explicação vazia sem inventar conteúdo', async () => {
  const response = await fetch(`${baseUrl}/api/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...validQuestion, explanation: '' })
  });
  const created = await response.json();

  assert.equal(response.status, 201);
  assert.equal(created.explanation, '');
});

test('DELETE remove a questão, responde 404 para ID inexistente e não reutiliza o maior ID', async () => {
  const beforeDelete = JSON.parse(await fs.readFile(questionsFile, 'utf8'));
  const deletedId = beforeDelete[beforeDelete.length - 1].id;

  const deleteResponse = await fetch(`${baseUrl}/api/questions/${deletedId}`, { method: 'DELETE' });
  const deletion = await deleteResponse.json();
  assert.equal(deleteResponse.status, 200);
  assert.equal(deletion.id, deletedId);

  const missingResponse = await fetch(`${baseUrl}/api/questions/inexistente`, { method: 'DELETE' });
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error.code, 'QUESTION_NOT_FOUND');

  const createResponse = await fetch(`${baseUrl}/api/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validQuestion)
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);
  assert.notEqual(created.id, deletedId);
});

test('PUT atualiza os campos sem alterar o ID e responde 404 para ID inexistente', async () => {
  const response = await fetch(`${baseUrl}/api/questions/personal-088`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...validQuestion, question: 'Enunciado atualizado?' })
  });
  const updated = await response.json();

  assert.equal(response.status, 200);
  assert.equal(updated.id, 'personal-088');
  assert.equal(updated.question, 'Enunciado atualizado?');

  const invalidResponse = await fetch(`${baseUrl}/api/questions/personal-088`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...validQuestion, id: 'personal-999' })
  });
  assert.equal(invalidResponse.status, 400);

  const missingResponse = await fetch(`${baseUrl}/api/questions/inexistente`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validQuestion)
  });
  assert.equal(missingResponse.status, 404);

  const persisted = JSON.parse(await fs.readFile(questionsFile, 'utf8'));
  assert.equal(persisted.find(question => question.id === 'personal-088').question, 'Enunciado atualizado?');
  assert.equal(persisted.some(question => question.id === 'personal-999'), false);
});

test('POST e PUT preservam respostas múltiplas como array e validam duplicidades', async () => {
  const multipleQuestion = {
    ...validQuestion,
    question: 'Quais são as respostas corretas? (Choose two.)',
    options: ['Alternativa A', 'Alternativa B', 'Alternativa C', 'Alternativa D', 'Alternativa E'],
    correct_answer: ['A', 'E']
  };
  const createResponse = await fetch(`${baseUrl}/api/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(multipleQuestion)
  });
  const created = await createResponse.json();

  assert.equal(createResponse.status, 201);
  assert.deepEqual(created.correct_answer, ['A', 'E']);

  const updateResponse = await fetch(`${baseUrl}/api/questions/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...multipleQuestion, correct_answer: ['B', 'D'] })
  });
  const updated = await updateResponse.json();
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(updated.correct_answer, ['B', 'D']);

  const oneAnswerArrayResponse = await fetch(`${baseUrl}/api/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...multipleQuestion, question: 'Uma resposta em modo múltiplo?', correct_answer: ['C'] })
  });
  const oneAnswerArray = await oneAnswerArrayResponse.json();
  assert.equal(oneAnswerArrayResponse.status, 201);
  assert.deepEqual(oneAnswerArray.correct_answer, ['C']);

  const persisted = JSON.parse(await fs.readFile(questionsFile, 'utf8'));
  assert.deepEqual(persisted.find(question => question.id === created.id).correct_answer, ['B', 'D']);
});

test('GET e POST de dados do usuário mantêm banco de erros e preferências separadamente', async () => {
  const userDataResponse = await fetch(`${baseUrl}/api/user-data`);
  const userData = await userDataResponse.json();
  assert.equal(userDataResponse.status, 200);
  assert.equal(userData.version, 1);
  assert.deepEqual(userData.errorBank, []);

  const addToBankResponse = await fetch(`${baseUrl}/api/user-data/error-bank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: 'personal-088' })
  });
  const updatedUserData = await addToBankResponse.json();
  assert.equal(addToBankResponse.status, 200);
  assert.ok(updatedUserData.errorBank.includes('personal-088'));

  const preferencesResponse = await fetch(`${baseUrl}/api/user-data/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'dark' })
  });
  const preferences = await preferencesResponse.json();
  assert.equal(preferencesResponse.status, 200);
  assert.equal(preferences.preferences.theme, 'dark');

  const removeResponse = await fetch(`${baseUrl}/api/user-data/error-bank/personal-088`, { method: 'DELETE' });
  const removed = await removeResponse.json();
  assert.equal(removeResponse.status, 200);
  assert.ok(!removed.errorBank.includes('personal-088'));
});

test('POST em histórico registra tentativas em arquivo separado', async () => {
  const attempt = {
    id: 'attempt-001',
    startedAt: '2026-10-15T10:00:00.000Z',
    finishedAt: '2026-10-15T10:10:00.000Z',
    mode: 'exam',
    score: 8,
    totalQuestions: 10,
    answered: 8,
    unanswered: 2,
    correctAnswers: 8
  };

  const response = await fetch(`${baseUrl}/api/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(attempt)
  });
  const created = await response.json();

  assert.equal(response.status, 201);
  assert.equal(created.attempts[0].id, 'attempt-001');
  assert.equal(created.attempts[0].score, 8);
});

test('POST /api/questions/import faz pré-visualização e importa apenas itens válidos após confirmação', async () => {
  const beforeImport = JSON.parse(await fs.readFile(questionsFile, 'utf8'));

  const importPayload = [
    {
      source: 'Personal',
      tag: 'Conceitos de nuvem',
      question: 'Questão importada de teste?',
      options: ['Opção A', 'Opção B', 'Opção C'],
      correct_answer: 'Opção A',
      explanation: 'Explicação da importação.'
    },
    {
      source: 'Personal',
      tag: 'Conceitos de nuvem',
      question: 'Questão existente 2?',
      options: ['Opção A', 'Opção B'],
      correct_answer: 'Opção A'
    },
    {
      source: 'Personal',
      tag: 'Conceitos de nuvem',
      question: '',
      options: ['A'],
      correct_answer: 'A'
    }
  ];

  const previewResponse = await fetch(`${baseUrl}/api/questions/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questions: importPayload })
  });
  const preview = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(preview.total, 3);
  assert.equal(preview.addable, 1);
  assert.equal(preview.invalid, 1);
  assert.equal(preview.duplicates, 1);

  const confirmResponse = await fetch(`${baseUrl}/api/questions/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questions: importPayload, confirm: true })
  });
  const imported = await confirmResponse.json();

  assert.equal(confirmResponse.status, 201);
  assert.equal(imported.imported, 1);

  const persisted = JSON.parse(await fs.readFile(questionsFile, 'utf8'));
  assert.equal(persisted.length, beforeImport.length + 1);
  assert.equal(persisted[persisted.length - 1].question, 'Questão importada de teste?');
});

const backupProgress = {
  version: 1,
  questionProgress: {
    'personal-002': { timesAnswered: 3, timesWrong: 1, inErrorBank: true, lastCorrect: false }
  },
  history: [{ id: 'personal-002', ok: false, mode: 'exam', date: '2026-10-15T10:00:00.000Z' }],
  session: {
    mode: 'exam',
    ids: ['personal-002'],
    idx: 0,
    answers: {},
    persist: true,
    done: false
  }
};

test('POST /api/backup/create inclui os JSONs do backend e o progresso enviado pelo frontend', async () => {
  const response = await fetch(`${baseUrl}/api/backup/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ progress: backupProgress })
  });
  const backup = await response.json();

  assert.equal(response.status, 200);
  assert.equal(backup.format, 'aws-clf-c02-backup');
  assert.equal(backup.version, 1);
  assert.deepEqual(backup.includes, ['questions', 'questionSequence', 'userData', 'history', 'progress']);
  assert.ok(backup.data.questions.length > 0);
  assert.ok(backup.data.questionSequence.lastIssued >= 90);
  assert.equal(backup.data.progress.session.ids[0], 'personal-002');
  assert.equal(backup.data.userData.version, 1);
  assert.equal(backup.data.history.version, 1);
  assert.ok(backup.data.history.attempts.length > 0);

  const validationResponse = await fetch(`${baseUrl}/api/backup/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup })
  });
  const validation = await validationResponse.json();
  assert.equal(validationResponse.status, 200);
  assert.equal(validation.valid, true);
  assert.equal(validation.summary.hasActiveSession, true);
  assert.equal(validation.summary.responseHistory, 1);
});

test('POST /api/backup/validate rejeita backup corrompido sem alterar os dados atuais', async () => {
  const backupResponse = await fetch(`${baseUrl}/api/backup/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ progress: backupProgress })
  });
  const backup = await backupResponse.json();
  backup.data.questions[0].question = 'Conteúdo adulterado sem atualizar checksum';

  const sourceFiles = [questionsFile, `${questionsFile}.sequence.json`, userDataFile, historyFile];
  const beforeFiles = await Promise.all(sourceFiles.map(filePath => fs.readFile(filePath, 'utf8')));
  const response = await fetch(`${baseUrl}/api/backup/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup })
  });
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.error.code, 'BACKUP_CHECKSUM_MISMATCH');

  const restoreResponse = await fetch(`${baseUrl}/api/backup/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup, currentProgress: backupProgress })
  });
  assert.equal(restoreResponse.status, 400);
  assert.equal((await restoreResponse.json()).error.code, 'BACKUP_CHECKSUM_MISMATCH');
  const afterFiles = await Promise.all(sourceFiles.map(filePath => fs.readFile(filePath, 'utf8')));
  assert.deepEqual(afterFiles, beforeFiles);
});

test('POST /api/backup/validate rejeita versão incompatível e componentes obrigatórios ausentes', async () => {
  const createResponse = await fetch(`${baseUrl}/api/backup/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ progress: backupProgress })
  });
  const backup = await createResponse.json();

  const incompatibleResponse = await fetch(`${baseUrl}/api/backup/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup: { ...backup, version: 2 } })
  });
  assert.equal(incompatibleResponse.status, 400);
  assert.equal((await incompatibleResponse.json()).error.code, 'UNSUPPORTED_BACKUP_VERSION');

  const missingHistoryBackup = structuredClone(backup);
  delete missingHistoryBackup.data.history;
  const missingResponse = await fetch(`${baseUrl}/api/backup/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup: missingHistoryBackup })
  });
  assert.equal(missingResponse.status, 400);
  assert.equal((await missingResponse.json()).error.code, 'INVALID_BACKUP_HISTORY');
});

test('POST /api/backup/create distingue arquivo fonte obrigatório ausente', async () => {
  const missingFile = `${historyFile}.missing`;
  await fs.rename(historyFile, missingFile);
  try {
    const response = await fetch(`${baseUrl}/api/backup/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress: backupProgress })
    });
    const result = await response.json();
    assert.equal(response.status, 500);
    assert.equal(result.error.code, 'BACKUP_SOURCE_MISSING');
  } finally {
    await fs.rename(missingFile, historyFile);
  }
});

test('POST /api/backup/create rejeita arquivo fonte corrompido sem substituí-lo', async () => {
  const originalHistory = await fs.readFile(historyFile, 'utf8');
  await fs.writeFile(historyFile, '{ JSON inválido');
  try {
    const response = await fetch(`${baseUrl}/api/backup/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress: backupProgress })
    });
    const result = await response.json();
    assert.equal(response.status, 500);
    assert.equal(result.error.code, 'BACKUP_SOURCE_INVALID');
    assert.equal(await fs.readFile(historyFile, 'utf8'), '{ JSON inválido');
  } finally {
    await fs.writeFile(historyFile, originalHistory);
  }
});

test('backup aceita arquivos JSON válidos com listas vazias', async () => {
  const originalFiles = await Promise.all([questionsFile, userDataFile, historyFile].map(filePath => fs.readFile(filePath, 'utf8')));
  const emptyProgress = { version: 1, questionProgress: {}, history: [], session: null };
  try {
    await fs.writeFile(questionsFile, '[]');
    await fs.writeFile(userDataFile, JSON.stringify({ version: 1, personalQuestions: [], errorBank: [], preferences: {}, updatedAt: null, createdAt: null }));
    await fs.writeFile(historyFile, JSON.stringify({ version: 1, attempts: [], updatedAt: null, createdAt: null }));
    const response = await fetch(`${baseUrl}/api/backup/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress: emptyProgress })
    });
    const backup = await response.json();
    assert.equal(response.status, 200);
    assert.equal(backup.data.questions.length, 0);
    assert.equal(backup.data.history.attempts.length, 0);
  } finally {
    await Promise.all([questionsFile, userDataFile, historyFile].map((filePath, index) => fs.writeFile(filePath, originalFiles[index])));
  }
});

test('POST /api/backup/restore cria backup de segurança e restaura os arquivos e a sequência', async () => {
  const createResponse = await fetch(`${baseUrl}/api/backup/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ progress: backupProgress })
  });
  const backup = await createResponse.json();
  const savedQuestions = JSON.stringify(backup.data.questions);
  const savedUserData = JSON.stringify(backup.data.userData);
  const savedHistory = JSON.stringify(backup.data.history);

  await fs.writeFile(questionsFile, JSON.stringify([{ ...initialQuestions[0], question: 'Estado temporário?' }]));
  await fs.writeFile(userDataFile, JSON.stringify({ version: 1, personalQuestions: [], errorBank: [], preferences: { changed: true } }));
  await fs.writeFile(historyFile, JSON.stringify({ version: 1, attempts: [{ id: 'temporary' }] }));

  const response = await fetch(`${baseUrl}/api/backup/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup, currentProgress: backupProgress })
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.restored.questions, backup.data.questions.length);
  assert.match(result.safetyBackup, /^safety-/);
  assert.equal(JSON.stringify(JSON.parse(await fs.readFile(questionsFile, 'utf8'))), savedQuestions);
  assert.equal(JSON.stringify(JSON.parse(await fs.readFile(userDataFile, 'utf8'))), savedUserData);
  assert.equal(JSON.stringify(JSON.parse(await fs.readFile(historyFile, 'utf8'))), savedHistory);
  assert.equal(JSON.parse(await fs.readFile(`${questionsFile}.sequence.json`, 'utf8')).lastIssued, backup.data.questionSequence.lastIssued);

  const safetyBundle = JSON.parse(await fs.readFile(path.join(backupDirectory, result.safetyBackup), 'utf8'));
  assert.equal(safetyBundle.format, 'aws-clf-c02-backup');
  assert.deepEqual(safetyBundle.data.progress, backupProgress);
});

test('falha na substituição de um dos arquivos reverte os anteriores', async () => {
  const backupStore = require('../src/data/backupStore');
  const backup = await backupStore.createBackup(backupProgress);
  const targetPaths = [questionsFile, `${questionsFile}.sequence.json`, userDataFile, historyFile];
  const originalContents = await Promise.all(targetPaths.map(filePath => fs.readFile(filePath, 'utf8')));
  const originalRename = fs.rename;
  let injectedFailure = false;

  fs.rename = async (source, destination) => {
    if (!injectedFailure && destination === `${questionsFile}.sequence.json` && source.endsWith('.restore')) {
      injectedFailure = true;
      const error = new Error('falha de escrita simulada');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(source, destination);
  };

  try {
    await assert.rejects(
      backupStore.restoreBackup(backup, backupProgress),
      error => error.code === 'BACKUP_RESTORE_FAILED' && error.message.includes('arquivos anteriores foram recuperados')
    );
  } finally {
    fs.rename = originalRename;
  }

  const restoredContents = await Promise.all(targetPaths.map(filePath => fs.readFile(filePath, 'utf8')));
  assert.deepEqual(restoredContents, originalContents);
});