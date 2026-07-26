'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'release', 'run23');
const OUT = path.join(OUT_DIR, 'security-scan.json');
const manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'release-manifest.json'), 'utf8'));
const patterns = [
  { id: 'private_key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
  { id: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github_token', regex: /\bgh[ps]_[A-Za-z0-9]{30,}\b/ },
  { id: 'bearer_value', regex: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+\/-]{20,}/i },
];
const binary = /\.(?:png|jpe?g|gif|woff2?|xlsx|pdf|zip|tgz)$/i;
const findings = [];

function scanText(scope, file, content) {
  for (const pattern of patterns) {
    if (pattern.regex.test(content)) findings.push({ scope, file, code: pattern.id });
  }
}

for (const entry of manifest.package.files) {
  if (binary.test(entry)) continue;
  const file = path.join(ROOT, entry);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  scanText('source', entry, fs.readFileSync(file, 'utf8'));
}

const history = spawnSync('git', ['log', '--all', '--format=', '-p', '--', '.', ':(exclude)*.xlsx', ':(exclude)*.png', ':(exclude)*.woff2'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
});
if (history.status === 0) scanText('history', 'git-log-patch', String(history.stdout));

for (const name of fs.readdirSync(OUT_DIR)) {
  if (name === path.basename(OUT) || binary.test(name)) continue;
  const file = path.join(OUT_DIR, name);
  if (fs.statSync(file).isFile()) scanText('artifact', name, fs.readFileSync(file, 'utf8'));
}

const output = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source_scanned: true,
  history_scanned: history.status === 0,
  artifacts_scanned: true,
  secret_findings: findings,
  package_forbidden_entries: manifest.package.forbidden_entries,
  history_scan_error: history.status === 0 ? null : 'git_history_scan_failed',
  status: findings.length === 0 && manifest.package.forbidden_entries.length === 0 && history.status === 0 ? 'PASS' : 'FAIL',
};
fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (output.status !== 'PASS') process.exitCode = 1;

