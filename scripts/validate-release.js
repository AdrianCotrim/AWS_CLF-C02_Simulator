'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const releaseDirectory = path.resolve(__dirname, '..', 'release');
const metadataPath = path.join(releaseDirectory, 'latest.yml');
const metadata = fs.readFileSync(metadataPath, 'utf8');
const read = (key) => {
  const match = metadata.match(new RegExp(`^${key}: (.+)$`, 'm'));
  assert.ok(match, `latest.yml não contém ${key}.`);
  return match[1].replace(/^'|'$/g, '');
};

const artifactName = read('path');
const artifactPath = path.join(releaseDirectory, artifactName);
const artifact = fs.readFileSync(artifactPath);
const digest = crypto.createHash('sha512').update(artifact).digest('base64');
const size = artifact.length;
const sizeMatch = metadata.match(/^\s+size: (\d+)$/m);

assert.equal(path.basename(artifactPath), artifactName);
assert.equal(read('sha512'), digest, 'SHA-512 do instalador diverge de latest.yml.');
assert.ok(sizeMatch, 'latest.yml não contém o tamanho do instalador.');
assert.equal(Number(sizeMatch[1]), size, 'Tamanho do instalador diverge de latest.yml.');
assert.ok(fs.existsSync(`${artifactPath}.blockmap`), 'O .blockmap do instalador não foi encontrado.');

console.log(`Artefato validado: ${artifactName}`);
console.log(`Tamanho validado: ${size} bytes`);
console.log(`SHA-512 validado: ${digest}`);
