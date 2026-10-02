'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

let directory;
let questionsFile;
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
  await fs.writeFile(questionsFile, JSON.stringify(initialQuestions));
  process.env.QUESTIONS_FILE = questionsFile;

  const app = require('../src/app');
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  delete process.env.QUESTIONS_FILE;
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
    { ...validQuestion, correct_answer: 'Resposta inexistente' }
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