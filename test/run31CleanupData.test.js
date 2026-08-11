'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createRehearsalDatabase } = require('../scripts/create-rehearsal-database');
const {
  DELETE_ORDER,
  KEEP_GROUPS,
  runCleanup,
} = require('../scripts/cleanup-ncc-evaluation-test-data');

function safeRemoveTemp(directory) {
  const resolved = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`));
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('RUN-31 cleanup backs up, removes the complete NCC/evaluation graph and is idempotent', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run31-'));
  try {
    const rehearsal = path.join(temp, 'rehearsal');
    const dbPath = path.join(rehearsal, 'fixture.db');
    createRehearsalDatabase({ dbPath, workspace: rehearsal });
    const evidenceRoot = path.join(temp, 'evidence');
    const backupRoot = path.join(temp, 'backups');

    const first = await runCleanup({
      dbPath,
      evidenceRoot,
      backupRoot,
      runId: 'first',
      skipFiles: true,
    });
    assert.equal(first.status, 'PASS');
    assert.ok(Object.values(first.before_counts).some((count) => count > 0));
    assert.ok(Object.values(first.after_counts).every((count) => count === 0));
    assert.deepEqual(first.master_configuration_changed, []);
    assert.equal(first.foreign_key_violations, 0);
    assert.equal(first.integrity_check, 'ok');
    assert.ok(fs.statSync(first.backup).size > 0);
    for (const fileName of [
      'dependency-audit.json',
      'pre-cleanup-counts.json',
      'backup-verification.json',
      'post-cleanup-verification.json',
    ]) assert.ok(fs.existsSync(path.join(first.evidence_directory, fileName)));

    const backup = new Database(first.backup, { readonly: true, fileMustExist: true });
    try {
      assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM evaluation_tickets').get().n, 1);
      assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM supplier_master').get().n, 1);
      assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      backup.close();
    }

    const second = await runCleanup({
      dbPath,
      evidenceRoot,
      backupRoot,
      runId: 'second',
      skipFiles: true,
    });
    assert.ok(Object.values(second.before_counts).every((count) => count === 0));
    assert.ok(Object.values(second.after_counts).every((count) => count === 0));
    assert.deepEqual(second.master_configuration_changed, []);
  } finally {
    safeRemoveTemp(temp);
  }
});

test('RUN-31 keeps configuration and compliance data outside the delete plan', () => {
  const kept = new Set(Object.values(KEEP_GROUPS).flat());
  for (const table of [
    'users', 'roles', 'permissions', 'master_data_catalogs', 'merchandise_hierarchy',
    'question_items', 'scoring_policy_versions', 'approval_stage_assignments',
    'report_template_versions', 'audit_events', 'access_log',
  ]) assert.ok(kept.has(table), table);
  for (const table of ['evaluation_tickets', 'supplier_master', 'workflow_history', 'report_artifacts']) {
    assert.ok(DELETE_ORDER.includes(table), table);
    assert.ok(!kept.has(table), table);
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'cleanup-ncc-evaluation-test-data.js'), 'utf8');
  assert.doesNotMatch(source, /foreign_keys\s*=\s*OFF/i);
  assert.doesNotMatch(source, /DELETE FROM\s+["'`]?(audit_events|access_log)/i);
});
