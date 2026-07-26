'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'release', 'run23');
function read(name) { return JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8')); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

const manifest = read('release-manifest.json');
const report = read('test-report.json');
const migration = read('migration-rehearsal.json');
const nfr = read('nfr-report.json');
const security = read('security-scan.json');
const sbom = read('sbom.cdx.json');
const integrityFailures = [];
const archive = path.join(OUT, manifest.package.file);
if (!fs.existsSync(archive) || sha256(archive) !== manifest.package.sha256) integrityFailures.push('release_package_checksum_invalid');
if (manifest.package.forbidden_entries.length) integrityFailures.push('release_package_contains_forbidden_entries');
if (migration.status !== 'PASS') integrityFailures.push('migration_rehearsal_failed');
if (nfr.status !== 'PASS') integrityFailures.push('nfr_failed');
if (security.status !== 'PASS') integrityFailures.push('security_scan_failed');
if (sbom.bomFormat !== 'CycloneDX' || !sbom.components?.length) integrityFailures.push('sbom_invalid');
const gateFailures = [];
for (const item of report.commands.filter((entry) => !['release_verify'].includes(entry.id) && entry.status !== 'PASS')) gateFailures.push(`command_${item.id}_${item.status.toLowerCase()}`);
for (const blocker of manifest.go_no_go.blockers) gateFailures.push(blocker.code);
const unique = [...new Set([...integrityFailures, ...gateFailures])];
const output = {
  verification: integrityFailures.length ? 'FAIL' : 'PASS',
  status: unique.length ? 'NO-GO' : 'GO',
  failures: unique,
  app_commit: manifest.app_commit,
  package_sha256: manifest.package.sha256,
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (integrityFailures.length) process.exitCode = 1;
