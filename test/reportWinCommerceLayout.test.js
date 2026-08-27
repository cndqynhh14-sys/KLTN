'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { getDefinition, listDefinitions } = require('../server/reporting/definitionCatalog');
const { buildSemanticModel, validateComponentTree } = require('../server/reporting/componentRegistry');
const { buildSyntheticReportContext } = require('../server/reporting/reportPreviewFixture');
const { renderHtml } = require('../server/reporting/htmlRenderer');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_SQL = fs.readFileSync(path.join(ROOT, 'migrations', '0038_wincommerce_report_layout_versions.sql'), 'utf8');

function migrationFixture({ referencedDraft = false } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE report_template_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, definition_code TEXT NOT NULL,
      version_no INTEGER NOT NULL, version_name TEXT NOT NULL, status TEXT NOT NULL,
      definition_json TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
      checksum TEXT, version_note TEXT, effective_from TEXT, effective_to TEXT,
      lock_version INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
      created_by TEXT, updated_at TEXT, updated_by TEXT, submitted_at TEXT,
      submitted_by TEXT, published_at TEXT, published_by TEXT, retired_at TEXT, retired_by TEXT,
      UNIQUE(definition_code, version_no)
    );
    CREATE TABLE report_template_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, definition_code TEXT NOT NULL,
      report_template_version_id INTEGER NOT NULL, scope_type TEXT NOT NULL,
      scope_key TEXT NOT NULL, effective_from TEXT, effective_to TEXT,
      is_default INTEGER NOT NULL, active INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')),
      created_by TEXT, updated_at TEXT, updated_by TEXT,
      FOREIGN KEY(report_template_version_id) REFERENCES report_template_versions(id),
      UNIQUE(report_template_version_id, scope_type, scope_key)
    );
    CREATE UNIQUE INDEX one_default ON report_template_assignments(definition_code, scope_type, scope_key)
      WHERE active=1 AND is_default=1;
    CREATE TABLE report_exports (id INTEGER PRIMARY KEY, report_template_version_id INTEGER REFERENCES report_template_versions(id));
    CREATE TABLE report_export_jobs (id TEXT PRIMARY KEY, report_template_version_id INTEGER REFERENCES report_template_versions(id));
    CREATE TABLE report_source_snapshots (id INTEGER PRIMARY KEY, report_template_version_id INTEGER REFERENCES report_template_versions(id));
    CREATE TABLE report_legacy_template_links (id INTEGER PRIMARY KEY, report_template_version_id INTEGER REFERENCES report_template_versions(id));
    CREATE TABLE report_template_version_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_template_version_id INTEGER NOT NULL,
      action TEXT NOT NULL, actor_user_id TEXT, before_json TEXT, after_json TEXT,
      request_id TEXT, correlation_id TEXT, created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(report_template_version_id) REFERENCES report_template_versions(id)
    );
    CREATE TRIGGER trg_report_published_delete_immutable BEFORE DELETE ON report_template_versions
      WHEN OLD.status IN ('PUBLISHED','RETIRED') BEGIN SELECT RAISE(ABORT, 'published_report_template_immutable'); END;
    CREATE TRIGGER trg_report_template_event_append_only_delete BEFORE DELETE ON report_template_version_events
      BEGIN SELECT RAISE(ABORT, 'report_template_event_append_only'); END;
  `);
  const insert = db.prepare(`INSERT INTO report_template_versions
    (definition_code, version_no, version_name, status, definition_json, checksum)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run('WORKING_MINUTES', 1, 'Minutes v1', 'PUBLISHED', '{"old":"minutes"}', 'old-minutes');
  insert.run('ROUND1_RESULT', 1, 'R1 v1', 'PUBLISHED', '{"old":"r1-v1"}', 'old-r1-v1');
  insert.run('ROUND1_RESULT', 2, 'R1 v2', 'PUBLISHED', '{"same":"r1-v2"}', 'old-r1-v2');
  const draft3 = Number(insert.run('ROUND1_RESULT', 3, 'R1 v3 no-op', 'DRAFT', '{"same":"r1-v2"}', null).lastInsertRowid);
  const draft4 = Number(insert.run('ROUND1_RESULT', 4, 'R1 v4 no-op', 'DRAFT', '{"same":"r1-v2"}', null).lastInsertRowid);
  insert.run('ROUND2_RESULT', 1, 'R2 v1', 'PUBLISHED', '{"old":"r2-v1"}', 'old-r2-v1');
  insert.run('ROUND2_RESULT', 2, 'R2 v2', 'PUBLISHED', '{"old":"r2-v2"}', 'old-r2-v2');
  const defaults = db.prepare(`INSERT INTO report_template_assignments
    (definition_code, report_template_version_id, scope_type, scope_key, is_default, active)
    SELECT definition_code, id, 'GLOBAL', '*', 1, 1 FROM report_template_versions WHERE id=?`);
  defaults.run(db.prepare("SELECT id FROM report_template_versions WHERE definition_code='WORKING_MINUTES' AND version_no=1").pluck().get());
  defaults.run(db.prepare("SELECT id FROM report_template_versions WHERE definition_code='ROUND1_RESULT' AND version_no=2").pluck().get());
  defaults.run(db.prepare("SELECT id FROM report_template_versions WHERE definition_code='ROUND2_RESULT' AND version_no=2").pluck().get());
  db.prepare("INSERT INTO report_template_version_events (report_template_version_id, action) VALUES (?, 'CREATED_DRAFT')").run(draft3);
  db.prepare("INSERT INTO report_template_version_events (report_template_version_id, action) VALUES (?, 'CREATED_DRAFT')").run(draft4);
  if (referencedDraft) db.prepare("INSERT INTO report_export_jobs (id, report_template_version_id) VALUES ('unsafe-reference', ?)").run(draft3);
  return db;
}

test('WinCommerce canonical definitions render the approved structure without a Chữ ký heading', () => {
  for (const definition of listDefinitions()) {
    const tree = definition.validateTree(validateComponentTree(definition.componentTree));
    const context = buildSyntheticReportContext({ definition, roundNo: definition.defaultRoundNo });
    const semantic = buildSemanticModel(tree, context);
    const html = renderHtml({ semantic, title: definition.label });
    assert.equal(semantic.styles.report_profile, 'wincommerce_supplier_assessment');
    assert.match(html, /Win<\/span><span class="wc-commerce">Commerce/);
    assert.match(html, /data-component="signature_block"/);
    assert.doesNotMatch(html, />Chữ ký</);
    assert.doesNotMatch(html, /Phiên bản bộ câu hỏi/);
    assert.doesNotMatch(html, />Trạng thái</);
    assert.doesNotMatch(html, /Người duyệt/);
    assert.doesNotMatch(html, /Người duyệt mẫu/);
    assert.match(html, /15\/07\/2026/);
    assert.match(html, /table-header-group/);
    assert.match(html, /break-inside:avoid-page/);
    assert.match(html, /wc-report-tail/);
    assert.match(html, /break-before:avoid-page/);
  }
  const minutes = validateComponentTree(getDefinition('WORKING_MINUTES').componentTree);
  const bindings = JSON.stringify(minutes);
  assert.doesNotMatch(bindings, /final_score|compliance_summary|final_conclusion/);
});

test('migration 0038 removes exact no-op drafts and leaves the next ROUND1 version at v3', () => {
  const db = migrationFixture();
  try {
    db.transaction(() => db.exec(MIGRATION_SQL))();
    assert.deepEqual(
      db.prepare("SELECT version_no FROM report_template_versions WHERE definition_code='ROUND1_RESULT' ORDER BY version_no").pluck().all(),
      [1, 2, 3]
    );
    assert.equal(db.prepare("SELECT COUNT(*) FROM report_template_versions WHERE definition_code='ROUND1_RESULT' AND version_no=4").pluck().get(), 0);
    assert.equal(db.prepare("SELECT version_no FROM report_template_versions v JOIN report_template_assignments a ON a.report_template_version_id=v.id WHERE v.definition_code='ROUND1_RESULT' AND a.is_default=1").pluck().get(), 3);
    assert.equal(db.prepare("SELECT COUNT(*) FROM report_template_version_events WHERE action='CREATED_DRAFT'").pluck().get(), 0);
    assert.equal(db.pragma('foreign_key_check').length, 0);
    db.transaction(() => db.exec(MIGRATION_SQL))();
    assert.equal(db.prepare("SELECT COUNT(*) FROM report_template_versions WHERE definition_code='ROUND1_RESULT'").pluck().get(), 3);
    assert.equal(db.prepare("SELECT COUNT(*) FROM report_template_version_events WHERE correlation_id='MIGRATION-0038'").pluck().get(), 3);
  } finally {
    db.close();
  }
});

test('migration 0038 aborts instead of deleting a referenced no-op draft', () => {
  const db = migrationFixture({ referencedDraft: true });
  try {
    assert.throws(() => db.transaction(() => db.exec(MIGRATION_SQL))(), /CHECK constraint failed/);
    assert.deepEqual(
      db.prepare("SELECT version_no FROM report_template_versions WHERE definition_code='ROUND1_RESULT' ORDER BY version_no").pluck().all(),
      [1, 2, 3, 4]
    );
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_report_template_event_append_only_delete'").get());
  } finally {
    db.close();
  }
});
