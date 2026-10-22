'use strict';

const { spawn: defaultSpawn } = require('node:child_process');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_HEALTH_PATH = '/health';
const DEFAULT_RETRY_DELAY_MS = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 1000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;

class BackendStartupError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'BackendStartupError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function delay(ms, setTimeoutImpl) {
  return new Promise(resolve => setTimeoutImpl(resolve, ms));
}

function createBackendLifecycle({
  spawnImpl = defaultSpawn,
  fetchImpl = globalThis.fetch,
  logger = console,
  host = DEFAULT_HOST,
  healthPath = DEFAULT_HEALTH_PATH,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = Date.now
} = {}) {
  let child = null;
  let startPromise = null;
  let stopping = false;
  let childFailure = null;

  function attachOutputLogging(process) {
    for (const [stream, level] of [['stdout', 'info'], ['stderr', 'error']]) {
      if (!process[stream]) continue;
      process[stream].setEncoding('utf8');
      process[stream].on('data', chunk => {
        const text = String(chunk).trimEnd();
        if (text) logger[level](`[backend:${stream}] ${text}`);
      });
    }
  }

  function startProcess({ executable, args = ['server.js'], cwd, env }) {
    logger.info(`Iniciando backend: executable=${executable}, cwd=${cwd}`);
    let process;
    try {
      process = spawnImpl(executable, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      throw new BackendStartupError('spawn-failed', `Não foi possível criar o processo do backend: ${error.message}`, error);
    }

    child = process;
    attachOutputLogging(process);
    process.once('error', error => {
      childFailure = new BackendStartupError('spawn-failed', `Não foi possível criar o processo do backend: ${error.message}`, error);
    });
    process.once('exit', (code, signal) => {
      logger.info(`Backend encerrado: code=${code}, signal=${signal || 'none'}`);
      if (!stopping && code !== 0) {
        childFailure = new BackendStartupError(
          'process-exited',
          `O backend encerrou antes de ficar pronto (código ${code}, sinal ${signal || 'none'}).`
        );
      }
    });
    return process;
  }

  async function probe(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeoutImpl(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (response.status !== 200) {
        return { ready: false, reason: `status=${response.status}` };
      }
      let body;
      try {
        body = await response.json();
      } catch {
        return { ready: false, reason: 'invalid-json' };
      }
      if (!body || body.ready !== true) {
        return { ready: false, reason: 'invalid-contract' };
      }
      return { ready: true };
    } catch (error) {
      return { ready: false, reason: error.name === 'AbortError' ? 'request-timeout' : error.message };
    } finally {
      clearTimeoutImpl(timeout);
    }
  }

  async function waitForReady(port) {
    const url = `http://${host}:${port}${healthPath}`;
    const startedAt = now();
    let attempts = 0;
    let lastReason = 'indisponível';
    while (now() - startedAt < startupTimeoutMs) {
      if (childFailure) throw childFailure;
      attempts += 1;
      const remainingBeforeProbe = startupTimeoutMs - (now() - startedAt);
      const result = await probe(url, Math.min(requestTimeoutMs, remainingBeforeProbe));
      logger.info(`Verificação de saúde #${attempts}: ${result.ready ? 'pronto' : result.reason}`);
      if (result.ready) {
        logger.info(`Backend pronto em ${now() - startedAt}ms`);
        return;
      }
      lastReason = result.reason;
      if (childFailure) throw childFailure;
      if (child && child.exitCode !== null) {
        throw new BackendStartupError('process-exited', `O backend encerrou antes de ficar pronto (código ${child.exitCode}).`);
      }
      const remaining = startupTimeoutMs - (now() - startedAt);
      if (remaining <= 0) break;
      await delay(Math.min(retryDelayMs, remaining), setTimeoutImpl);
    }
    throw new BackendStartupError('health-timeout', `O backend não ficou disponível dentro do tempo esperado (último resultado: ${lastReason}).`);
  }

  function start(options) {
    if (startPromise) return startPromise;
    stopping = false;
    childFailure = null;
    startPromise = (async () => {
      const process = await startProcess(options);
      await waitForReady(options.port);
      if (childFailure) throw childFailure;
      return process;
    })().catch(error => {
      startPromise = null;
      throw error;
    });
    return startPromise;
  }

  async function stop() {
    stopping = true;
    const process = child;
    child = null;
    startPromise = null;
    if (!process || process.exitCode !== null || process.signalCode !== null) return;
    await new Promise(resolve => {
      process.once('exit', resolve);
      process.kill();
    });
  }

  return { start, stop, waitForReady };
}

module.exports = {
  BackendStartupError,
  createBackendLifecycle,
  DEFAULT_STARTUP_TIMEOUT_MS
};
