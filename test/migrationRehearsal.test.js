'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('migration rehearsal upgrades a representative 0029 database without publishing database bytes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-rehearsal-contract-'));
  const outputDir = path.join(temp, 'public-report');
  try {
    const child = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'rehearse-database-migrations.js'),
      '--output-dir', outputDir,
    ], {
      cwd: root,
      env: {
        ...process.env,
        JWT_SECRET: 'synthetic-rehearsal-placeholder-only',
        EMAIL_MODE: 'console',
        USE_IN_MEMORY_OTP: 'true',
      },
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);

    const reportPath = path.join(outputDir, 'report.json');
    const summaryPath = path.join(outputDir, 'report.md');
    assert.equal(fs.existsSync(reportPath), true);
    assert.equal(fs.existsSync(summaryPath), true);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

    assert.equal(report.status, 'PASS');
    assert.equal(report.source.synthetic, true);
    assert.equal(report.source.schema_through, '0029');
    assert.match(report.backup.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.backup.integrity_check, 'ok');
    assert.equal(report.backup.foreign_key_violations, 0);
    assert.deepEqual(report.migration.applied_ids, ['0030']);
    assert.equal(report.migration.retry_pending_count, 0);
    assert.equal(report.parity.stage4c.status, 'PASS');
    assert.notEqual(report.parity.stage4d.status, 'FAILED');
    assert.notEqual(report.parity.stage5.status, 'FAIL');
    assert.equal(report.database.integrity_check, 'ok');
    assert.equal(report.database.foreign_key_violations, 0);
    assert.deepEqual(report.startup.map((item) => item.health_status), [200, 200]);
    assert.equal(report.authentication.pre_cutover_session_revoked, true);
    assert.equal(report.authentication.canonical_session_resolved, true);
    assert.equal(report.restore.sha256_matches_backup, true);
    assert.equal(report.restore.last_migration_id, '0029');

    const publishedFiles = fs.readdirSync(outputDir, { recursive: true })
      .map(String).filter((name) => /\.(?:db|db-wal|db-shm)$/i.test(name));
    assert.deepEqual(publishedFiles, []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('migration rehearsal workflow is isolated from production and publishes reports only', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'migration-rehearsal.yml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /node-version: 20/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npx playwright install --with-deps chromium/);
  assert.match(workflow, /--with-uat/);
  assert.match(workflow, /npm run rehearsal:stage5/);
  assert.match(workflow, /report\.json/);
  assert.match(workflow, /report\.md/);
  assert.match(workflow, /Reject database bytes[\s\S]*?if: always\(\)/);
  assert.match(workflow, /Upload sanitized rehearsal report[\s\S]*?if: always\(\)/);
  assert.match(workflow, /artifacts\/uat-runs\/\*\*\/report\.json/);
  assert.doesNotMatch(workflow, /railway|production database/i);
  assert.equal(pkg.scripts['rehearsal:stage4'], 'node scripts/rehearse-database-migrations.js');
  assert.equal(pkg.scripts['rehearsal:stage5'], 'node scripts/rehearse-database-migrations.js');
});
