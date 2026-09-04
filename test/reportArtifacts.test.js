'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

function freshDb(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'run18-synthetic-secret';
  delete require.cache[require.resolve('../server/db')];
  delete require.cache[require.resolve('../server/config/paths')];
  return require('../server/db').db;
}

function createFixture(db) {
  const actor = 'run18-exporter@synthetic.invalid';
  const actorIdentity = upsertCanonicalUser(db, {
    email: actor, role: 'Admin', isAdmin: true, displayName: 'RUN-18 Synthetic Exporter',
  });
  const supplier = db.prepare(`
    INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
    VALUES ('RUN18-NCC', 'RUN-18 Synthetic Supplier', 'ACTIVE', 'MANUAL')
  `).run();
  const questionVersion = db.prepare(`
    SELECT v.id, v.template_id
    FROM question_template_versions v
    JOIN question_templates t ON t.id=v.template_id
    WHERE t.template_code='BM01' AND v.status='PUBLISHED'
    ORDER BY v.version_no DESC LIMIT 1
  `).get();
  const ticketInfo = db.prepare(`
    INSERT INTO evaluation_tickets (
      ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type,
      template_id, question_template_version_id, facility_type, supplier_scale,
      planned_date, actual_evaluation_date, current_status, current_round_no,
      completed_round, score_percent, grade_code, result_label, created_by
    ) VALUES (
      'RUN18-EXPORT-001', ?, 'RUN18-NCC', 'RUN-18 Synthetic Supplier', 'Periodic',
      ?, ?, 'ALL', 'LARGE', '2026-07-14', '2026-07-14', 'Completed', 1,
      1, 100, 'A', 'Pass', ?
    )
  `).run(supplier.lastInsertRowid, questionVersion.template_id, questionVersion.id, actorIdentity.user_id);
  db.prepare(`
    INSERT INTO evaluation_rounds (
      ticket_id, round_no, assessment_code, assessment_date,
      status, completed_at, total_score, final_result, classification
    ) VALUES (?, 1, 'RUN18-EXPORT-001-R1', '2026-07-14', 'Completed', '2026-07-14', 100, 'Pass', 'A')
  `).run(ticketInfo.lastInsertRowid);
  return {
    actor,
    actorUserId: actorIdentity.user_id,
    ticket: db.prepare('SELECT * FROM evaluation_tickets WHERE id=?').get(ticketInfo.lastInsertRowid),
  };
}

test('RUN-18 migration creates durable job, snapshot and artifact provenance', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run18-schema-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    for (const table of ['report_export_jobs', 'report_artifacts', 'report_source_snapshots']) {
      assert.ok(tables.has(table), `missing ${table}`);
    }
    const exportColumns = new Set(db.prepare("PRAGMA table_info('report_exports')").all().map((row) => row.name));
    for (const column of ['job_id', 'artifact_id', 'availability_status', 'legacy_reconciliation_status', 'is_regenerated']) {
      assert.ok(exportColumns.has(column), `missing report_exports.${column}`);
    }
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    fs.rmSync(dbPath, { force: true });
  }
});

test('RUN-18 local storage persists atomically across instances and rejects traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run18-storage-'));
  try {
    const { LocalArtifactStorage } = require('../server/reporting/artifacts/LocalArtifactStorage');
    const first = new LocalArtifactStorage({ root });
    const payload = Buffer.from('<!doctype html><title>RUN-18 synthetic</title>', 'utf8');
    const stored = first.putAtomic({ storageKey: 'reports/2026/07/job-1/a.html', buffer: payload });
    assert.match(stored.sha256, /^[a-f0-9]{64}$/);
    assert.equal(stored.size_bytes, payload.length);
    const afterRestart = new LocalArtifactStorage({ root });
    assert.deepEqual(afterRestart.get('reports/2026/07/job-1/a.html'), payload);
    assert.throws(() => afterRestart.get('../outside.txt'), (error) => error.code === 'report_storage_key_invalid');
    assert.throws(() => afterRestart.putAtomic({ storageKey: 'C:/outside.pdf', buffer: payload }),
      (error) => error.code === 'report_storage_key_invalid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RUN-18 canonical retry returns one durable artifact with complete provenance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run18-job-'));
  const dbPath = path.join(root, 'run18.db');
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const { actor, actorUserId, ticket } = createFixture(db);
    const { LocalArtifactStorage } = require('../server/reporting/artifacts/LocalArtifactStorage');
    const { ReportExportJobService } = require('../server/reporting/artifacts/ReportExportJobService');
    const storage = new LocalArtifactStorage({ root: path.join(root, 'artifacts') });
    const service = new ReportExportJobService({ db, storage, executionMode: 'inline' });
    const request = {
      ticket,
      definitionCode: 'ROUND1_RESULT',
      format: 'HTML',
      roundNo: 1,
      requestedBy: actor,
      idempotencyKey: 'run18-retry-0001',
      requestId: 'run18-request-0001',
      correlationId: 'run18-correlation-0001',
      at: '2026-07-14',
    };
    const first = service.requestExport(request);
    const retry = new ReportExportJobService({ db, storage, executionMode: 'inline' }).requestExport(request);
    assert.equal(retry.job_id, first.job_id);
    assert.equal(retry.artifact_id, first.artifact_id);
    assert.equal(retry.id, first.id);
    assert.deepEqual(retry.buffer, first.buffer);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_export_jobs').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_artifacts').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_exports').get().n, 1);

    const job = db.prepare('SELECT * FROM report_export_jobs WHERE id=?').get(first.job_id);
    const artifact = db.prepare('SELECT * FROM report_artifacts WHERE id=?').get(first.artifact_id);
    const snapshot = db.prepare('SELECT * FROM report_source_snapshots WHERE job_id=?').get(first.job_id);
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.scoring_rules_marker, null);
    assert.match(job.scoring_policy_version_id, /^\d+$/);
    assert.match(job.scoring_policy_checksum, /^[a-f0-9]{64}$/);
    assert.match(job.scoring_rules_checksum, /^[a-f0-9]{64}$/);
    assert.match(job.template_checksum, /^[a-f0-9]{64}$/);
    assert.match(job.context_checksum, /^[a-f0-9]{64}$/);
    assert.equal(job.requester_user_id, actorUserId);
    assert.equal(job.idempotency_key, request.idempotencyKey);
    assert.equal(artifact.availability_status, 'AVAILABLE');
    assert.equal(path.isAbsolute(artifact.storage_key), false);
    assert.doesNotMatch(artifact.storage_key, /(^|\/)\.\.(\/|$)|:/);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.context_checksum, job.context_checksum);
    assert.equal(snapshot.question_template_version_id, ticket.question_template_version_id);
    assert.deepEqual(new LocalArtifactStorage({ root: path.join(root, 'artifacts') }).get(artifact.storage_key), first.buffer);
    assert.throws(() => db.prepare("UPDATE report_source_snapshots SET source_snapshot_json='{}' WHERE id=?").run(snapshot.id),
      /report_source_snapshot_immutable/);
    assert.throws(() => db.prepare('DELETE FROM evaluation_tickets WHERE id=?').run(ticket.id));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_artifacts').get().n, 1);
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RUN-18 failed byte persistence never creates a COMPLETED job or artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run18-failure-'));
  const dbPath = path.join(root, 'run18.db');
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const { actor, actorUserId, ticket } = createFixture(db);
    const { ReportExportJobService } = require('../server/reporting/artifacts/ReportExportJobService');
    const service = new ReportExportJobService({
      db,
      executionMode: 'inline',
      storage: {
        adapterName: 'LOCAL',
        putAtomic() {
          const error = new Error('synthetic storage failure');
          error.code = 'report_storage_write_failed';
          throw error;
        },
      },
    });
    assert.throws(() => service.requestExport({
      ticket,
      definitionCode: 'ROUND1_RESULT',
      format: 'HTML',
      roundNo: 1,
      requestedBy: actor,
      idempotencyKey: 'run18-failure-0001',
      at: '2026-07-14',
    }), (error) => error.code === 'report_storage_write_failed');
    const job = db.prepare('SELECT * FROM report_export_jobs').get();
    assert.equal(job.status, 'FAILED');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_export_jobs WHERE status='COMPLETED'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_artifacts').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_exports').get().n, 0);
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RUN-18 worker mode queues without inline rendering and completes exactly once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run18-worker-'));
  const dbPath = path.join(root, 'run18.db');
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const { actor, ticket } = createFixture(db);
    const { LocalArtifactStorage } = require('../server/reporting/artifacts/LocalArtifactStorage');
    const { ReportExportJobService } = require('../server/reporting/artifacts/ReportExportJobService');
    const storage = new LocalArtifactStorage({ root: path.join(root, 'artifacts') });
    const queue = new ReportExportJobService({ db, storage, executionMode: 'worker' });
    const pending = queue.requestExport({
      ticket,
      definitionCode: 'ROUND1_RESULT',
      format: 'HTML',
      roundNo: 1,
      requestedBy: actor,
      idempotencyKey: 'run18-worker-0001',
      at: '2026-07-14',
    });
    assert.equal(pending.pending, true);
    assert.equal(pending.status, 'QUEUED');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_artifacts').get().n, 0);
    const completed = queue.processNext();
    assert.equal(completed.job_id, pending.job_id);
    assert.equal(db.prepare("SELECT status FROM report_export_jobs WHERE id=?").get(pending.job_id).status, 'COMPLETED');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_artifacts').get().n, 1);
    assert.equal(queue.processNext(), null);
    const retry = queue.requestExport({
      ticket,
      definitionCode: 'ROUND1_RESULT',
      format: 'HTML',
      roundNo: 1,
      requestedBy: actor,
      idempotencyKey: 'run18-worker-0001',
      at: '2026-07-14',
    });
    assert.equal(retry.artifact_id, completed.artifact_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_artifacts').get().n, 1);
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    delete require.cache[require.resolve('../server/config/paths')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RUN-18 production config is fail-closed and does not pretend inline is async', () => {
  const { reportArtifactReadiness } = require('../server/reporting/artifacts/config');
  assert.equal(reportArtifactReadiness({ NODE_ENV: 'production' }).status, 'disabled');
  assert.equal(reportArtifactReadiness({
    NODE_ENV: 'production',
    REPORT_DURABLE_EXPORTS_ENABLED: 'REPORT-001-APPROVED',
    REPORT_STORAGE_MODE: 'local',
    REPORT_EXPORT_EXECUTION_MODE: 'inline',
  }).code, 'report_local_volume_not_approved');
  assert.equal(reportArtifactReadiness({
    NODE_ENV: 'production',
    REPORT_DURABLE_EXPORTS_ENABLED: 'REPORT-001-APPROVED',
    REPORT_STORAGE_MODE: 'object',
    REPORT_OBJECT_STORAGE_ENABLED: '0',
    REPORT_EXPORT_EXECUTION_MODE: 'worker',
  }).code, 'report_object_storage_disabled');
  assert.equal(reportArtifactReadiness({
    NODE_ENV: 'production',
    REPORT_DURABLE_EXPORTS_ENABLED: 'REPORT-001-APPROVED',
    REPORT_STORAGE_MODE: 'local',
    REPORT_LOCAL_VOLUME_APPROVAL: 'REPORT-001:APPROVED_PERSISTENT_VOLUME',
    REPORT_STORAGE_ROOT: path.resolve(os.tmpdir(), 'run18-approved-volume'),
    REPORT_EXPORT_EXECUTION_MODE: 'inline',
  }).code, 'report_worker_required');
});

test('RUN-18 legacy and retention reconciliation are dry-run by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run18-reconcile-'));
  const dbPath = path.join(root, 'run18.db');
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const { actor, actorUserId, ticket } = createFixture(db);
    const legacy = db.prepare(`
      INSERT INTO report_exports (
        ticket_id, report_type, file_format, export_scope, file_path, exported_by
      ) VALUES (?, 'INTERNAL', 'PDF', 'TICKET', ?, ?)
    `).run(ticket.id, path.join(root, 'missing-legacy.pdf'), actorUserId);
    const { LegacyReportArtifactReconciler } = require('../server/reporting/artifacts/LegacyReportArtifactReconciler');
    const reconciler = new LegacyReportArtifactReconciler({ db, legacyRoot: root });
    const before = db.prepare('SELECT * FROM report_exports WHERE id=?').get(legacy.lastInsertRowid);
    const legacyReport = reconciler.dryRunLegacyMapping();
    const retentionReport = reconciler.dryRunRetention({ asOf: '2099-01-01T00:00:00.000Z' });
    const after = db.prepare('SELECT * FROM report_exports WHERE id=?').get(legacy.lastInsertRowid);
    assert.equal(legacyReport.items[0].status, 'MISSING');
    assert.equal(legacyReport.mutated, false);
    assert.equal(retentionReport.mutated, false);
    assert.deepEqual(after, before);
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RUN-18 explicit legacy repair imports bytes and replaces absolute path with a relative storage key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run18-legacy-repair-'));
  const dbPath = path.join(root, 'run18.db');
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const { actor, actorUserId, ticket } = createFixture(db);
    const legacyPath = path.join(root, 'legacy-synthetic.html');
    fs.writeFileSync(legacyPath, '<!doctype html><title>RUN-18 legacy synthetic</title>', 'utf8');
    const legacy = db.prepare(`
      INSERT INTO report_exports (
        ticket_id, report_type, file_format, export_scope, file_path, exported_by
      ) VALUES (?, 'INTERNAL', 'HTML', 'TICKET', ?, ?)
    `).run(ticket.id, legacyPath, actorUserId);
    const { LocalArtifactStorage } = require('../server/reporting/artifacts/LocalArtifactStorage');
    const { LegacyReportArtifactReconciler } = require('../server/reporting/artifacts/LegacyReportArtifactReconciler');
    const storage = new LocalArtifactStorage({ root: path.join(root, 'artifacts') });
    const reconciler = new LegacyReportArtifactReconciler({ db, legacyRoot: root, storage });
    assert.equal(reconciler.dryRunLegacyMapping().items[0].status, 'IMPORTABLE');
    const repaired = reconciler.repairLegacyExport(legacy.lastInsertRowid, {
      actor,
      requestId: 'run18-legacy-repair-0001',
    });
    const row = db.prepare('SELECT * FROM report_exports WHERE id=?').get(legacy.lastInsertRowid);
    assert.ok(row.job_id);
    assert.ok(row.artifact_id);
    assert.equal(row.availability_status, 'AVAILABLE');
    assert.equal(row.legacy_reconciliation_status, 'IMPORTED');
    assert.equal(path.isAbsolute(row.file_path), false);
    assert.equal(repaired.storage_key, row.file_path);
    assert.match(storage.get(row.file_path).toString('utf8'), /RUN-18 legacy synthetic/);
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    delete require.cache[require.resolve('../server/config/paths')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RUN-18 history download rechecks auth/scope and verifies the same stored bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run18-download-'));
  const dbPath = path.join(root, 'run18.db');
  const previous = {
    DB_PATH: process.env.DB_PATH,
    REPORT_DURABLE_EXPORTS_ENABLED: process.env.REPORT_DURABLE_EXPORTS_ENABLED,
    REPORT_STORAGE_MODE: process.env.REPORT_STORAGE_MODE,
    REPORT_STORAGE_ROOT: process.env.REPORT_STORAGE_ROOT,
  };
  process.env.REPORT_DURABLE_EXPORTS_ENABLED = '1';
  process.env.REPORT_STORAGE_MODE = 'local';
  process.env.REPORT_STORAGE_ROOT = path.join(root, 'artifacts');
  const db = freshDb(dbPath);
  let server;
  try {
    const { actor, ticket } = createFixture(db);
    const deniedUser = 'run18-denied@synthetic.invalid';
    const { ROLES } = require('../server/domain/roles');
    upsertCanonicalUser(db, {
      email: deniedUser, role: ROLES.SPECIALIST, displayName: 'RUN-18 Denied Scope',
    });
    const dbModule = require('../server/db');
    const { LocalArtifactStorage } = require('../server/reporting/artifacts/LocalArtifactStorage');
    const { ReportExportJobService } = require('../server/reporting/artifacts/ReportExportJobService');
    const storage = new LocalArtifactStorage({ root: process.env.REPORT_STORAGE_ROOT });
    const exported = new ReportExportJobService({ db, storage, executionMode: 'inline' }).requestExport({
      ticket,
      definitionCode: 'ROUND1_RESULT',
      format: 'HTML',
      roundNo: 1,
      requestedBy: actor,
      idempotencyKey: 'run18-download-0001',
      requestId: 'run18-create-request-0001',
      at: '2026-07-14',
    });

    for (const moduleName of ['../server/middleware/auth', '../server/routes/reportExports']) {
      delete require.cache[require.resolve(moduleName)];
    }
    const auth = require('../server/middleware/auth');
    const signToken = canonicalTokenFactory(dbModule, auth);
    signToken({ email: deniedUser }, 3600);
    const deniedUserId = db.prepare('SELECT user_id FROM users WHERE email=?').get(deniedUser).user_id;
    db.prepare(`DELETE FROM user_scope_assignments WHERE user_id=?`).run(deniedUserId);
    db.prepare(`INSERT INTO user_scope_assignments
      (user_id, role_id, scope_type, scope_value, effect, source)
      SELECT ?, id, 'OWN', 'SELF', 'ALLOW', 'MANUAL' FROM roles WHERE role_code='QLCL_SPECIALIST'`
    ).run(deniedUserId);
    const { requestContext } = require('../server/middleware/requestContext');
    const app = express();
    app.use(requestContext());
    app.use(cookieParser());
    app.use('/report-exports', require('../server/routes/reportExports'));
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/report-exports`;
    const actorToken = signToken({ email: actor, isAdmin: true, role: 'Admin' }, 3600);
    const deniedToken = signToken({ email: deniedUser }, 3600);

    assert.equal((await fetch(`${baseUrl}/${exported.id}/download`)).status, 401);
    const denied = await fetch(`${baseUrl}/${exported.id}/download`, {
      headers: { Cookie: `qlcl_token=${deniedToken}`, 'X-Request-Id': 'run18-denied-request-0001' },
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'forbidden_scope');

    const history = await fetch(`${baseUrl}?ticket_id=${ticket.id}`, {
      headers: { Cookie: `qlcl_token=${actorToken}`, 'X-Request-Id': 'run18-history-request-0001' },
    });
    assert.equal(history.status, 200);
    const historyBody = await history.json();
    assert.equal(historyBody.items.length, 1);
    assert.equal(historyBody.items[0].artifact_id, exported.artifact_id);
    assert.equal(historyBody.items[0].download_url, `/qlcl/api/report-exports/${exported.id}/download`);

    const jobStatus = await fetch(`${baseUrl}/jobs/${exported.job_id}`, {
      headers: { Cookie: `qlcl_token=${actorToken}`, 'X-Request-Id': 'run18-job-status-0001' },
    });
    assert.equal(jobStatus.status, 200);
    const jobBody = await jobStatus.json();
    assert.equal(jobBody.status, 'COMPLETED');
    assert.equal(jobBody.artifact_id, exported.artifact_id);
    assert.equal(jobBody.scoring_rules_marker, null);
    assert.match(jobBody.scoring_policy_version_id, /^\d+$/);
    assert.match(jobBody.scoring_policy_checksum, /^[a-f0-9]{64}$/);
    assert.equal(jobBody.download_url, `/qlcl/api/report-exports/${exported.id}/download`);

    const downloaded = await fetch(`${baseUrl}/${exported.id}/download`, {
      headers: { Cookie: `qlcl_token=${actorToken}`, 'X-Request-Id': 'run18-download-request-0001' },
    });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('x-artifact-id'), String(exported.artifact_id));
    assert.equal(downloaded.headers.get('x-artifact-sha256'), exported.sha256);
    assert.doesNotMatch(downloaded.headers.get('content-disposition'), /[\r\n]/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), exported.buffer);

    process.env.REPORT_STORAGE_MODE = 'off';
    const unavailableStorage = await fetch(`${baseUrl}/${exported.id}/download`, {
      headers: { Cookie: `qlcl_token=${actorToken}`, 'X-Request-Id': 'run18-storage-down-0001' },
    });
    assert.equal(unavailableStorage.status, 503);
    assert.equal(db.prepare('SELECT availability_status FROM report_artifacts WHERE id=?').get(exported.artifact_id).availability_status, 'AVAILABLE');
    process.env.REPORT_STORAGE_MODE = 'local';

    const artifact = db.prepare('SELECT * FROM report_artifacts WHERE id=?').get(exported.artifact_id);
    const { target } = storage.resolve(artifact.storage_key);
    fs.writeFileSync(target, Buffer.from('<!doctype html><title>tampered</title>', 'utf8'));
    const tampered = await fetch(`${baseUrl}/${exported.id}/download`, {
      headers: { Cookie: `qlcl_token=${actorToken}`, 'X-Request-Id': 'run18-tamper-request-0001' },
    });
    assert.equal(tampered.status, 410);
    assert.equal((await tampered.json()).error, 'report_artifact_size_mismatch');
    assert.equal(db.prepare('SELECT availability_status FROM report_artifacts WHERE id=?').get(exported.artifact_id).availability_status, 'QUARANTINED');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    for (const moduleName of [
      '../server/db', '../server/config/paths', '../server/middleware/auth', '../server/routes/reportExports',
    ]) delete require.cache[require.resolve(moduleName)];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
