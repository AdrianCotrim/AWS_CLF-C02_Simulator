'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function readJsonFile(filePath, fallbackValue) {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(contents);
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallbackValue;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`JSON inválido em ${filePath}.`);
    }
    throw error;
  }
}

async function writeJsonFile(filePath, payload) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });

  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporaryFile, filePath);
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeArray(value, fallback) {
  return Array.isArray(value) ? value : fallback;
}

module.exports = { readJsonFile, writeJsonFile, normalizeArray };
