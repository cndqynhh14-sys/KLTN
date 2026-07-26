'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyCriteriaSeedSource } = require('../server/services/criteriaImporter');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const manifestPath = path.resolve(argument('--manifest') || path.join(__dirname, '..', 'database', 'seeds', 'question-criteria-source.json'));
if (!fs.existsSync(manifestPath)) {
  process.stderr.write(`${JSON.stringify({ status: 'degraded', code: 'question_seed_manifest_missing' })}\n`);
  process.exitCode = 1;
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sourcePath = path.resolve(path.dirname(path.dirname(path.dirname(manifestPath))), manifest.source);
  const result = verifyCriteriaSeedSource(sourcePath, argument('--sha256') || manifest.sha256);
  process.stdout.write(`${JSON.stringify({ ...result, source: manifest.source, mode: manifest.mode })}\n`);
  if (result.status !== 'ready') process.exitCode = 1;
}
