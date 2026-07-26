'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const roots = ['server', 'scripts', 'public/js', 'test', 'uat'];
const files = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(target);
  }
}
roots.forEach((relative) => visit(path.join(root, relative)));
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file: path.relative(root, file), message: String(result.stderr || result.stdout).trim() });
}
process.stdout.write(`${JSON.stringify({ checked: files.length, failures }, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

