'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { AuthorizationService } = require('../server/services/AuthorizationService');
const { AuditEventService } = require('../server/services/AuditEventService');
const { AuditEventRepository } = require('../server/repositories/AuditEventRepository');
const { getDefinition } = require('../server/reporting/definitionCatalog');
const { buildSyntheticReportContext } = require('../server/reporting/reportPreviewFixture');
const { buildSemanticModel } = require('../server/reporting/componentRegistry');
const { renderHtml } = require('../server/reporting/htmlRenderer');
const { renderXlsx } = require('../server/reporting/xlsxAdapter');
const { redact } = require('../server/observability/redact');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'release', 'run23', 'nfr-report.json');
const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'release-nfr-targets.json'), 'utf8'));
const MIGRATIONS = path.join(ROOT, 'migrations');

function elapsed(start) {
  return Number((performance.now() - start).toFixed(3));
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)].toFixed(3));
}

function target(id) {
  const value = TARGETS.targets.find((item) => item.id === id);
  if (!value) throw new Error(`nfr_target_missing:${id}`);
  return { ...value, set_at: TARGETS.set_at };
}

function result(id, value, measuredAt, details = {}) {
  const expected = target(id);
  return {
    id,
    target: expected,
    observed: { metric: expected.metric, value },
    measured_at: measuredAt,
    status: value <= expected.value ? 'PASS' : 'FAIL',
    details,
  };
}

function createDatabase(file = ':memory:') {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir: MIGRATIONS, appVersion: 'RUN-23-NFR' });
  return db;
}

async function contentionBenchmark(directory) {
  const dbPath = path.join(directory, 'contention.db');
  const first = new Database(dbPath);
  first.pragma('journal_mode = WAL');
  first.exec('CREATE TABLE contention_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  first.exec('BEGIN IMMEDIATE');
  first.prepare('INSERT INTO contention_probe (id, value) VALUES (1, ?)').run('FIRST');
  const code = `const Database=require('better-sqlite3');const db=new Database(process.argv[1]);db.pragma('busy_timeout=1200');db.prepare('INSERT INTO contention_probe (id,value) VALUES (2,?)').run('SECOND');db.close();`;
  const started = performance.now();
  const child = spawn(process.execPath, ['-e', code, dbPath], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 120));
  first.exec('COMMIT');
  const [status] = await once(child, 'exit');
  const duration = elapsed(started);
  const count = first.prepare('SELECT COUNT(*) FROM contention_probe').pluck().get();
  first.close();
  if (status !== 0 || count !== 2) throw new Error('sqlite_contention_recovery_failed');
  return duration;
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run23-nfr-'));
  const db = createDatabase();
  const measuredAt = new Date().toISOString();
  const measurements = [];
  try {
    db.prepare(`INSERT INTO users (email, is_active, display_name, created_at, created_by)
      VALUES ('nfr.admin@example.invalid', 1, 'RUN23 NFR ADMIN', datetime('now'), NULL)`).run();
    db.prepare(`INSERT INTO user_roles (user_id, role_id, active, source, created_by)
      SELECT 'nfr.admin@example.invalid', id, 1, 'MANUAL', NULL
      FROM roles WHERE role_code='SYS_ADMIN'`).run();
    const authz = new AuthorizationService(db);
    const authTimings = [];
    for (let index = 0; index < 200; index += 1) {
      authz.cache.clear();
      const start = performance.now();
      authz.effectivePermissions('nfr.admin@example.invalid');
      authTimings.push(performance.now() - start);
    }
    measurements.push(result('authz_resolution', p95(authTimings), measuredAt, { samples: authTimings.length, cache: 'cold' }));

    const audit = new AuditEventService(db);
    db.transaction(() => {
      for (let index = 0; index < 5000; index += 1) {
        audit.record({
          eventName: 'audit.read', actorUserId: 'nfr.admin@example.invalid', actorRoles: ['SYS_ADMIN'],
          entityType: 'AUDIT_EVENT', entityId: `NFR-${index}`, action: 'READ', outcome: 'SUCCESS',
          summary: 'Synthetic RUN-23 audit volume', metadata: { access_type: 'LIST', row_count: 100 },
        });
      }
    })();
    const auditRepo = new AuditEventRepository(db);
    const auditTimings = [];
    for (let index = 0; index < 40; index += 1) {
      const start = performance.now();
      auditRepo.list({ limit: 100 });
      auditTimings.push(performance.now() - start);
    }
    measurements.push(result('audit_pagination', p95(auditTimings), measuredAt, { rows: 5000, page_size: 100, samples: auditTimings.length }));

    const template = db.prepare("INSERT INTO question_templates (template_code, template_name, active) VALUES ('NFR1000', 'Synthetic 1000', 1)").run();
    const version = db.prepare("INSERT INTO question_template_versions (template_id, version_no, status) VALUES (?, 1, 'DRAFT')").run(template.lastInsertRowid);
    const insertQuestion = db.prepare(`INSERT INTO question_items
      (question_template_version_id, facility_type, supplier_scale, question_code, question_text, category, order_index)
      VALUES (?, 'ALL', 'ALL', ?, ?, 'SYNTHETIC', ?)`);
    db.transaction(() => {
      for (let index = 1; index <= 1000; index += 1) insertQuestion.run(version.lastInsertRowid, `NFR-Q-${index}`, `Synthetic question ${index}`, index);
    })();
    let start = performance.now();
    const questionRows = db.prepare('SELECT * FROM question_items WHERE question_template_version_id=? ORDER BY order_index').all(version.lastInsertRowid);
    measurements.push(result('questions_1000', elapsed(start), measuredAt, { rows: questionRows.length }));

    const workbookRows = Array.from({ length: 1000 }, (_unused, index) => ({
      template_code: 'NFR1000', variant_code: 'ALL_ALL', category_code: 'SYNTHETIC',
      question_code: `NFR-Q-${index + 1}`, question_text: `Synthetic question ${index + 1}`,
      clause_code: `NFR-C-${index + 1}`, allowed_scores: 'A/B/C/D/NA', weight: 1, order: index + 1, active: 1,
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(workbookRows), 'Questions');
    const workbookBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    start = performance.now();
    const parsed = XLSX.utils.sheet_to_json(XLSX.read(workbookBuffer, { type: 'buffer' }).Sheets.Questions);
    measurements.push(result('workbook_import', elapsed(start), measuredAt, { rows: parsed.length, bytes: workbookBuffer.length, formulas_evaluated: false }));

    const definition = getDefinition('ROUND1_RESULT');
    const context = buildSyntheticReportContext({ definition, roundNo: 1 });
    start = performance.now();
    const byteSizes = [];
    for (let index = 0; index < 5; index += 1) {
      const semantic = buildSemanticModel(definition.componentTree, context);
      const html = renderHtml({ semantic, title: 'RUN-23 synthetic' });
      const xlsx = renderXlsx(semantic);
      byteSizes.push(Buffer.byteLength(html), xlsx.length);
    }
    measurements.push(result('preview_export_concurrency', elapsed(start), measuredAt, { sets: 5, formats: ['HTML', 'XLSX'], byte_sizes: byteSizes }));

    db.exec('CREATE TEMP TABLE nfr_jobs (id INTEGER PRIMARY KEY, status TEXT, started_at TEXT)');
    const insertJob = db.prepare("INSERT INTO nfr_jobs (id, status, started_at) VALUES (?, 'RUNNING', '2026-01-01 00:00:00')");
    db.transaction(() => { for (let index = 1; index <= 100; index += 1) insertJob.run(index); })();
    start = performance.now();
    const recovered = db.prepare("UPDATE nfr_jobs SET status='QUEUED', started_at=NULL WHERE status='RUNNING' AND started_at < '2026-07-15'").run();
    measurements.push(result('job_recovery', elapsed(start), measuredAt, { jobs: recovered.changes, rule: 'stale RUNNING to QUEUED synthetic recovery probe' }));

    const contention = await contentionBenchmark(directory);
    measurements.push(result('sqlite_contention', contention, measuredAt, { writers: 2, lock_release_after_ms: 120, busy_timeout_ms: 1200 }));

    const logPayload = { event: 'RUN23', otp: 'synthetic-value', authorization: 'synthetic-value', text: 'safe\nlog injection probe' };
    start = performance.now();
    for (let index = 0; index < 1000; index += 1) redact(logPayload);
    measurements.push(result('logging_evidence_overhead', elapsed(start), measuredAt, { records: 1000, redaction: true }));

    const output = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      runtime: process.version,
      fixture: 'deterministic synthetic only',
      measurements,
      status: measurements.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (output.status !== 'PASS') process.exitCode = 1;
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
