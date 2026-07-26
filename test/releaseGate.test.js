'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'artifacts', 'release', 'run23');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function json(relative) {
  return JSON.parse(read(relative));
}

test('RUN-23 exposes one documented release gate and every required project command', () => {
  const pkg = json('package.json');
  for (const script of [
    'uat:full', 'test:a11y', 'test:security', 'test:nfr',
    'release:prepare', 'release:verify', 'release:gate',
  ]) {
    assert.equal(typeof pkg.scripts[script], 'string', `missing npm script ${script}`);
  }
  assert.match(pkg.scripts['release:gate'], /run-release-gate/);
  assert.equal(pkg.engines.node, '20.x');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('server/') && pkg.files.includes('public/'));
});

test('RUN-23 publishes the five release documents with traceable Vietnamese operating contracts', () => {
  const files = [
    'docs/release/traceability.md',
    'docs/release/migration-rehearsal.md',
    'docs/release/security-review.md',
    'docs/release/uat-signoff.md',
    'docs/release/pilot-and-rollback-runbook.md',
  ];
  for (const file of files) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), true, file);
    const source = read(file);
    assert.match(source, /[ăâđêôơưĂÂĐÊÔƠƯ]/, file);
    assert.match(source, /GO|NO-GO/);
    assert.match(source, /request_id/);
  }

  const traceability = read(files[0]);
  for (let run = 0; run <= 23; run += 1) {
    assert.match(traceability, new RegExp(`RUN-${String(run).padStart(2, '0')}`));
  }
  for (const term of ['commit', 'migration', 'API', 'UI', 'test', 'decision', 'evidence']) {
    assert.match(traceability, new RegExp(term, 'i'), term);
  }

  const migrations = read(files[1]);
  for (const term of ['fresh', 'upgrade', 'retry', 'checksum', 'backup', 'restore', 'rollback', 'reconciliation']) {
    assert.match(migrations, new RegExp(term, 'i'), term);
  }

  const security = read(files[2]);
  for (const term of ['privilege escalation', 'mass assignment', 'stale token', 'IDOR', 'XLSX', 'ZIP', 'traversal', 'PII', 'secret']) {
    assert.match(security, new RegExp(term, 'i'), term);
  }

  const signoff = read(files[3]);
  for (const role of ['SYS_ADMIN', 'Role Admin', 'Auditor', 'Specialist', 'Lead', 'TBP', 'GDK', 'Question Designer', 'Question Publisher', 'Report Designer', 'Report Publisher', 'custom scoped role']) {
    assert.match(signoff, new RegExp(role, 'i'), role);
  }

  const rollback = read(files[4]);
  for (const incident of ['wrong permission', 'migration failure', 'OTP', 'import', 'report mismatch', 'stuck job', 'missing artifact', 'template', 'policy', 'release rollback']) {
    assert.match(rollback, new RegExp(incident, 'i'), incident);
  }
});

test('RUN-23 machine outputs contain tests, migration rehearsal, NFR targets, SBOM and a reproducible package manifest', () => {
  const outputFiles = [
    'artifacts/release/run23/test-report.json',
    'artifacts/release/run23/migration-rehearsal.json',
    'artifacts/release/run23/nfr-report.json',
    'artifacts/release/run23/security-scan.json',
    'artifacts/release/run23/sbom.cdx.json',
    'artifacts/release/run23/release-manifest.json',
  ];
  for (const file of outputFiles) assert.equal(fs.existsSync(path.join(ROOT, file)), true, file);

  const report = json(outputFiles[0]);
  assert.equal(report.schema_version, 1);
  for (const command of ['node20_npm_ci', 'npm_test', 'build', 'test_webapp', 'uat_smoke', 'uat_full', 'migrations', 'a11y', 'security', 'nfr', 'npm_audit', 'release_verify']) {
    assert.ok(report.commands.some((item) => item.id === command && ['PASS', 'FAIL', 'BLOCKED'].includes(item.status)), command);
  }

  const migration = json(outputFiles[1]);
  for (const check of ['fresh', 'upgrade', 'retry', 'checksum', 'backup_restore', 'rollback_restore', 'reconciliation']) {
    assert.equal(migration.checks[check]?.status, 'PASS', check);
  }

  const nfr = json(outputFiles[2]);
  for (const id of ['authz_resolution', 'audit_pagination', 'questions_1000', 'workbook_import', 'preview_export_concurrency', 'job_recovery', 'sqlite_contention', 'logging_evidence_overhead']) {
    const item = nfr.measurements.find((entry) => entry.id === id);
    assert.ok(item, id);
    assert.equal(typeof item.target.value, 'number', `${id} target`);
    assert.equal(typeof item.observed.value, 'number', `${id} observed`);
    assert.ok(['PASS', 'FAIL'].includes(item.status), `${id} status`);
    assert.ok(new Date(item.target.set_at).getTime() <= new Date(item.measured_at).getTime(), `${id} target must precede measurement`);
  }

  const security = json(outputFiles[3]);
  assert.equal(security.secret_findings.length, 0);
  assert.equal(security.package_forbidden_entries.length, 0);
  assert.equal(security.source_scanned, true);
  assert.equal(security.history_scanned, true);
  assert.equal(security.artifacts_scanned, true);

  const sbom = json(outputFiles[4]);
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.match(sbom.specVersion, /^1\./);
  assert.ok(sbom.components.length >= 10);

  const manifest = json(outputFiles[5]);
  assert.match(manifest.app_commit, /^[a-f0-9]{40}$/);
  assert.ok(manifest.migrations.length >= 14);
  assert.ok(manifest.migrations.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.ok(Array.isArray(manifest.feature_flags));
  assert.match(manifest.package.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.package.forbidden_entries.length, 0);
  assert.ok(['GO', 'NO-GO'].includes(manifest.go_no_go.status));
});

test('RUN-23 never reports GO with an uncommitted tree, open decisions, failed NFRs or unsigned roles', () => {
  const manifest = json('artifacts/release/run23/release-manifest.json');
  const report = json('artifacts/release/run23/test-report.json');
  const nfr = json('artifacts/release/run23/nfr-report.json');
  const signoff = read('docs/release/uat-signoff.md');
  const hasBlocker = manifest.working_tree.dirty
    || manifest.decisions.some((item) => !['APPROVED', 'IMPLEMENTED', 'IMPLEMENTED-COMPAT', 'IMPLEMENTED-RUN21'].includes(item.status))
    || manifest.findings.some((item) => ['CRITICAL', 'HIGH'].includes(item.severity) && item.status !== 'CLOSED')
    || report.commands.some((item) => item.status !== 'PASS')
    || nfr.measurements.some((item) => item.status !== 'PASS')
    || /\|\s*(?:PENDING|NO-GO)\s*\|/i.test(signoff);
  if (hasBlocker) assert.equal(manifest.go_no_go.status, 'NO-GO');
});
