'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { createBackendLifecycle } = require('./backendLifecycle');

function createChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  };
  return child;
}

function createHarness(fetchImpl) {
  const child = createChild();
  const logs = [];
  const lifecycle = createBackendLifecycle({
    spawnImpl: () => child,
    fetchImpl,
    logger: {
      info: message => logs.push(message),
      error: message => logs.push(message),
      warn: message => logs.push(message)
    },
    retryDelayMs: 1,
    requestTimeoutMs: 20,
    startupTimeoutMs: 50
  });
  return { child, lifecycle, logs };
}

test('aguarda health válido e não aguarda atraso adicional quando já está pronto', async () => {
  let probes = 0;
  const { lifecycle } = createHarness(async () => {
    probes += 1;
    return { status: 200, json: async () => ({ ready: true }) };
  });
  await lifecycle.start({ executable: 'node', cwd: '.', port: 1234 });
  assert.equal(probes, 1);
  await lifecycle.stop();
});

test('tolera backend lento e encerra imediatamente quando fica pronto', async () => {
  let probes = 0;
  const { lifecycle } = createHarness(async () => {
    probes += 1;
    if (probes < 3) throw new Error('connection refused');
    return { status: 200, json: async () => ({ ready: true }) };
  });
  await lifecycle.start({ executable: 'node', cwd: '.', port: 1234 });
  assert.equal(probes, 3);
  await lifecycle.stop();
});

test('rejeita status e contrato de saúde inválidos', async () => {
  const { lifecycle } = createHarness(async () => ({
    status: 503,
    json: async () => ({ ready: false })
  }));
  await assert.rejects(
    lifecycle.start({ executable: 'node', cwd: '.', port: 1234 }),
    error => error.code === 'health-timeout'
  );
  await lifecycle.stop();
});

test('distingue falha ao criar processo e encerramento antes da prontidão', async () => {
  const spawnFailure = createBackendLifecycle({
    spawnImpl: () => { throw new Error('arquivo não encontrado'); },
    fetchImpl: async () => ({ status: 200, json: async () => ({ ready: true }) })
  });
  await assert.rejects(
    spawnFailure.start({ executable: 'node', cwd: '.', port: 1234 }),
    error => error.code === 'spawn-failed'
  );

  const { child, lifecycle } = createHarness(async () => {
    child.exitCode = 1;
    child.emit('exit', 1, null);
    return { status: 503, json: async () => ({ ready: false }) };
  });
  await assert.rejects(
    lifecycle.start({ executable: 'node', cwd: '.', port: 1234 }),
    error => error.code === 'process-exited'
  );
  await lifecycle.stop();
});

test('não inicia dois processos e encerra o filho no fechamento', async () => {
  let starts = 0;
  const child = createChild();
  const lifecycle = createBackendLifecycle({
    spawnImpl: () => {
      starts += 1;
      return child;
    },
    fetchImpl: async () => ({ status: 200, json: async () => ({ ready: true }) })
  });
  const options = { executable: 'node', cwd: '.', port: 1234 };
  const first = lifecycle.start(options);
  const second = lifecycle.start(options);
  assert.strictEqual(first, second);
  await first;
  await lifecycle.stop();
  assert.equal(starts, 1);
  assert.equal(child.exitCode, 0);
});
