'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function freshDb(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'stage4d-synthetic-secret';
  delete require.cache[require.resolve('../server/db')];
  delete require.cache[require.resolve('../server/config/paths')];
  return require('../server/db').db;
}

function createTicket(db) {
  const actor = 'stage4d-exporter@synthetic.invalid';
  db.prepare(`
    INSERT INTO users (email, is_admin, role, is_active, display_name, created_by)
    VALUES (?, 1, 'Admin', 1, 'Stage 4D Synthetic Exporter', 'STAGE4D')
  `).run(actor);
  const supplier = db.prepare(`
    INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
    VALUES ('STAGE4D-NCC', 'Stage 4D Synthetic Supplier', 'ACTIVE', 'MANUAL')
  `).run();
  const questionVersion = db.prepare(`
    SELECT v.id, v.template_id
    FROM question_template_versions v
    JOIN question_templates t ON t.id=v.template_id
    WHERE t.template_code='BM01' AND v.status='PUBLISHED'
    ORDER BY v.version_no DESC LIMIT 1
  `).get();
  const ticket = db.prepare(`
    INSERT INTO evaluation_tickets (
      ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type,
      template_id, question_template_version_id, facility_type, supplier_scale,
      current_status, current_round_no, created_by
    ) VALUES ('STAGE4D-TICKET-001', ?, 'STAGE4D-NCC', 'Stage 4D Synthetic Supplier',
      'Periodic', ?, ?, 'ALL', 'LARGE', 'Completed', 1, ?)
  `).run(supplier.lastInsertRowid, questionVersion.template_id, questionVersion.id, actor);
  const round = db.prepare(`
    INSERT INTO evaluation_rounds (
      ticket_id, round_no, assessment_code, status, total_score, final_result, classification
    ) VALUES (?, 1, 'STAGE4D-R1', 'Completed', 100, 'Pass', 'A')
  `).run(ticket.lastInsertRowid);
  return {
    actor,
    ticketId: Number(ticket.lastInsertRowid),
    roundId: Number(round.lastInsertRowid),
    questionVersionId: Number(questionVersion.id),
  };
}

function insertLegacyExport(db, fixture, filePath) {
  return Number(db.prepare(`
    INSERT INTO report_exports (
      ticket_id, round_id, report_type, file_format, export_scope, file_path, exported_by
    ) VALUES (?, ?, 'ROUND1_RESULT', 'HTML', 'TICKET', ?, ?)
  `).run(fixture.ticketId, fixture.roundId, filePath, fixture.actor).lastInsertRowid);
}

test('Stage 4D dry-run verifies approved legacy bytes without exposing report names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-stage4d-dry-'));
  const dbPath = path.join(root, 'stage4d.db');
  const legacyRoot = path.join(root, 'legacy');
  fs.mkdirSync(legacyRoot);
  const previousDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const fixture = createTicket(db);
    const bytes = Buffer.from('<!doctype html><title>Stage 4D synthetic</title>', 'utf8');
    const insidePath = path.join(legacyRoot, 'synthetic-report.html');
    fs.writeFileSync(insidePath, bytes);
    insertLegacyExport(db, fixture, insidePath);
    insertLegacyExport(db, fixture, path.join(root, 'outside', 'unapproved.html'));
    const outsideDirectory = path.join(root, 'outside-real');
    const linkedDirectory = path.join(legacyRoot, 'linked-outside');
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(path.join(outsideDirectory, 'linked.html'), bytes);
    fs.symlinkSync(outsideDirectory, linkedDirectory, 'junction');
    insertLegacyExport(db, fixture, path.join(linkedDirectory, 'linked.html'));
    const { LegacyReportArtifactReconciler } = require('../server/reporting/artifacts/LegacyReportArtifactReconciler');
    const reconciler = new LegacyReportArtifactReconciler({ db, legacyRoot });
    const before = db.prepare('SELECT * FROM report_exports ORDER BY id').all();
    const report = reconciler.dryRunLegacyMapping();
    const after = db.prepare('SELECT * FROM report_exports ORDER BY id').all();
    assert.equal(report.mode, 'DRY_RUN');
    assert.equal(report.mutated, false);
    assert.equal(report.counts.IMPORTABLE, 1);
    assert.equal(report.counts.OUTSIDE_ROOT, 2);
    assert.match(report.inventory_checksum, /^[a-f0-9]{64}$/);
    const importable = report.items.find((item) => item.status === 'IMPORTABLE');
    assert.equal(importable.size_bytes, bytes.length);
    assert.equal(importable.sha256, hash(bytes));
    assert.match(importable.path_hash, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(importable, 'candidate_name'), false);
    const stage4d = reconciler.stage4dReport();
    assert.equal(stage4d.status, 'RECONCILIATION_COMPLETE_CLEANUP_DEFERRED');
    assert.equal(stage4d.cleanup.allowed, false);
    assert.equal(stage4d.cleanup.blocker_count, 3);
    assert.equal(stage4d.cleanup.migration_0029_created, false);
    assert.deepEqual(after, before);
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Stage 4D apply only classifies legacy rows and is checksum-guarded and idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-stage4d-apply-'));
  const dbPath = path.join(root, 'stage4d.db');
  const legacyRoot = path.join(root, 'legacy');
  fs.mkdirSync(legacyRoot);
  const previousDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const fixture = createTicket(db);
    const insidePath = path.join(legacyRoot, 'synthetic-report.html');
    fs.writeFileSync(insidePath, '<!doctype html><title>Stage 4D synthetic</title>', 'utf8');
    const insideId = insertLegacyExport(db, fixture, insidePath);
    const outsidePath = path.join(root, 'outside', 'unapproved.html');
    const outsideId = insertLegacyExport(db, fixture, outsidePath);
    const { LegacyReportArtifactReconciler } = require('../server/reporting/artifacts/LegacyReportArtifactReconciler');
    const reconciler = new LegacyReportArtifactReconciler({ db, legacyRoot });
    const dry = reconciler.dryRunLegacyMapping();
    assert.throws(
      () => reconciler.applyLegacyClassifications({ expectedInventoryChecksum: '0'.repeat(64) }),
      (error) => error.code === 'report_reconciliation_inventory_changed'
    );
    const applied = reconciler.applyLegacyClassifications({ expectedInventoryChecksum: dry.inventory_checksum });
    assert.equal(applied.mutated, true);
    assert.equal(applied.updated_count, 2);
    const inside = db.prepare('SELECT * FROM report_exports WHERE id=?').get(insideId);
    const outside = db.prepare('SELECT * FROM report_exports WHERE id=?').get(outsideId);
    assert.equal(inside.legacy_reconciliation_status, 'IMPORTABLE');
    assert.equal(outside.legacy_reconciliation_status, 'OUTSIDE_ROOT');
    assert.equal(inside.file_path, insidePath);
    assert.equal(outside.file_path, outsidePath);
    assert.equal(inside.job_id, null);
    assert.equal(inside.artifact_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_exports').get().n, 2);
    const repeated = reconciler.applyLegacyClassifications({ expectedInventoryChecksum: dry.inventory_checksum });
    assert.equal(repeated.updated_count, 0);
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Stage 4D canonical audit verifies stored bytes and detects checksum drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-stage4d-audit-'));
  const dbPath = path.join(root, 'stage4d.db');
  const legacyRoot = path.join(root, 'legacy');
  const artifactRoot = path.join(root, 'artifacts');
  fs.mkdirSync(legacyRoot);
  const previousDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const fixture = createTicket(db);
    const { LocalArtifactStorage } = require('../server/reporting/artifacts/LocalArtifactStorage');
    const { LegacyReportArtifactReconciler } = require('../server/reporting/artifacts/LegacyReportArtifactReconciler');
    const storage = new LocalArtifactStorage({ root: artifactRoot });
    const bytes = Buffer.from('<!doctype html><title>Stage 4D canonical</title>', 'utf8');
    const stored = storage.putAtomic({ storageKey: 'reports/stage4d/canonical.html', buffer: bytes });
    const at = '2026-08-02T00:00:00.000Z';
    const jobId = 'stage4d-job-0001';
    const checksum = hash('stage4d');
    db.prepare(`
      INSERT INTO report_export_jobs (
        id, idempotency_key, definition_code, definition_version,
        report_template_version_id, template_version_marker, template_checksum,
        ticket_id, round_id, round_no, file_format, data_contract_version,
        context_checksum, renderer_version, app_commit, scoring_policy_version_id,
        scoring_rules_marker, scoring_rules_checksum, requester_user_id, generator_id,
        execution_mode, status, outcome, attempt_count, requested_at, generated_at, completed_at
      ) VALUES (?, 'stage4d-idempotency', 'ROUND1_RESULT', '1', NULL,
        'STAGE4D_TEMPLATE', ?, ?, ?, 1, 'HTML', 1, ?, 'STAGE4D_RENDERER',
        'STAGE4D_COMMIT', '1', NULL, ?, ?, 'stage4d-generator', 'INLINE',
        'COMPLETED', 'SUCCESS', 1, ?, ?, ?)
    `).run(jobId, checksum, fixture.ticketId, fixture.roundId, checksum, checksum, fixture.actor, at, at, at);
    const snapshotId = Number(db.prepare(`
      INSERT INTO report_source_snapshots (
        job_id, ticket_id, round_id, round_no, question_template_version_id,
        definition_code, definition_version, data_contract_version, context_checksum,
        source_checksum, source_snapshot_json, created_at
      ) VALUES (?, ?, ?, 1, ?, 'ROUND1_RESULT', '1', 1, ?, ?, '{}', ?)
    `).run(jobId, fixture.ticketId, fixture.roundId, fixture.questionVersionId, checksum, checksum, at).lastInsertRowid);
    const artifactId = Number(db.prepare(`
      INSERT INTO report_artifacts (
        job_id, source_snapshot_id, storage_adapter, storage_key, sha256, size_bytes,
        mime_type, file_name, file_format, retention_class, availability_status,
        created_at, last_verified_at
      ) VALUES (?, ?, 'LOCAL', ?, ?, ?, 'text/html; charset=utf-8',
        'stage4d-canonical.html', 'HTML', 'REPORT_ARTIFACT_STANDARD_V1', 'AVAILABLE', ?, ?)
    `).run(jobId, snapshotId, 'reports/stage4d/canonical.html', stored.sha256, stored.size_bytes, at, at).lastInsertRowid);
    db.prepare(`
      INSERT INTO report_exports (
        ticket_id, round_id, report_type, file_format, export_scope, file_path,
        exported_by, job_id, artifact_id, availability_status, legacy_reconciliation_status
      ) VALUES (?, ?, 'ROUND1_RESULT', 'HTML', 'TICKET', ?, ?, ?, ?, 'AVAILABLE', 'IMPORTED')
    `).run(fixture.ticketId, fixture.roundId, 'reports/stage4d/canonical.html', fixture.actor, jobId, artifactId);
    const reconciler = new LegacyReportArtifactReconciler({ db, legacyRoot, storage });
    const clean = reconciler.auditCanonicalProvenance();
    assert.equal(clean.status, 'PASS');
    assert.equal(clean.counts.verified, 1);
    assert.equal(clean.hard_failures.total, 0);
    const changed = Buffer.from(bytes);
    changed[changed.length - 8] = changed[changed.length - 8] === 97 ? 98 : 97;
    fs.writeFileSync(storage.resolve('reports/stage4d/canonical.html').target, changed);
    const drift = reconciler.auditCanonicalProvenance();
    assert.equal(drift.status, 'FAIL');
    assert.equal(drift.counts.checksum_mismatch, 1);
    assert.equal(drift.hard_failures.total, 1);
    const cli = spawnSync(process.execPath, [
      path.resolve(__dirname, '../scripts/report-artifact-reconcile.js'),
      `--db=${dbPath}`,
      `--legacy-root=${legacyRoot}`,
      `--artifact-root=${artifactRoot}`,
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.equal(JSON.parse(cli.stdout).stage4d.status, 'FAILED');
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
