'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const THROUGH_ID = '0027';

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseArgs(argv) {
  const valueAfter = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  };
  return {
    dbPath: valueAfter('--db') ? path.resolve(valueAfter('--db')) : null,
    workspace: valueAfter('--workspace') ? path.resolve(valueAfter('--workspace')) : null,
    migrationsDir: valueAfter('--migrations-dir')
      ? path.resolve(valueAfter('--migrations-dir'))
      : MIGRATIONS_DIR,
  };
}

function copyHistoricalMigrations({ sourceDir, targetDir, throughId = THROUGH_ID }) {
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];
  for (const fileName of fs.readdirSync(sourceDir).sort()) {
    if (!/^\d{4}_.+\.sql$/.test(fileName) || fileName.slice(0, 4) > throughId) continue;
    fs.copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName));
    copied.push(fileName.slice(0, 4));
  }
  if (!copied.length || copied.at(-1) !== throughId) throw new Error('historical_migration_boundary_missing');
  return copied;
}

function addCanonicalRole(db, email, roleCode, scopeType, scopeValue = null) {
  db.prepare(`INSERT INTO user_roles (user_id, role_id, source, created_by)
    SELECT ?, id, 'MANUAL', ? FROM roles WHERE role_code=?`).run(email, email, roleCode);
  db.prepare(`INSERT INTO user_scope_assignments
    (user_id, role_id, scope_type, scope_value, effect, source, created_by)
    SELECT ?, id, ?, ?, 'ALLOW', 'MANUAL', ?
    FROM roles WHERE role_code=?`).run(email, scopeType, scopeValue, email, roleCode);
}

function seedRepresentativeData(db, { legacyRoot }) {
  const admin = 'rehearsal.admin@example.invalid';
  const specialist = 'rehearsal.specialist@example.invalid';
  db.prepare(`INSERT INTO users
    (email, is_admin, is_active, display_name, created_by)
    VALUES (?, 1, 1, 'Synthetic rehearsal administrator', NULL)`).run(admin);
  db.prepare(`INSERT INTO users
    (email, is_admin, is_active, display_name, created_by)
    VALUES (?, 0, 1, 'Synthetic rehearsal specialist', ?)`).run(specialist, admin);
  addCanonicalRole(db, admin, 'SYS_ADMIN', 'GLOBAL');
  addCanonicalRole(db, specialist, 'QLCL_SPECIALIST', 'OWN', 'SELF');
  db.prepare(`INSERT INTO user_scope_assignments
    (user_id, role_id, scope_type, scope_value, effect, source, created_by)
    SELECT ?, id, 'ASSIGNED', 'SELF', 'ALLOW', 'MANUAL', ?
    FROM roles WHERE role_code='QLCL_SPECIALIST'`).run(specialist, admin);

  const sessions = [];
  for (const email of [admin, specialist]) {
    const version = db.prepare('SELECT authz_version FROM users WHERE email=?').pluck().get(email);
    const sessionId = `pre-cutover-${email}`;
    db.prepare(`INSERT INTO auth_sessions
      (session_id, user_id, authz_version, issued_at, expires_at)
      VALUES (?, ?, ?, '2026-08-02 00:00:00', '2030-08-02 00:00:00')`).run(sessionId, email, version);
    sessions.push({ email, sessionId, authzVersion: Number(version) });
  }

  const supplierId = Number(db.prepare(`INSERT INTO supplier_master
    (supplier_code, supplier_name, status, source_type, created_by)
    VALUES ('REHEARSAL-NCC', 'Synthetic rehearsal supplier', 'ACTIVE', 'MANUAL', ?)`)
    .run(specialist).lastInsertRowid);
  const templateId = Number(db.prepare(`INSERT INTO question_templates
    (template_code, template_name, active)
    VALUES ('REHEARSAL-Q', 'Synthetic rehearsal questions', 1)`).run().lastInsertRowid);
  const legacyQuestionId = Number(db.prepare(`INSERT INTO evaluation_questions
    (template_id, facility_type, supplier_scale, question_code, question_text, category,
     category_code, category_label_snapshot, allowed_scores, weight, order_index, active)
    VALUES (?, 'FACTORY', 'LARGE', 'RQ-01', 'Synthetic rehearsal criterion', 'Quality',
      'QUALITY', 'Quality', 'A/B/C/D/NA', 1, 1, 1)`)
    .run(templateId).lastInsertRowid);
  const versionId = Number(db.prepare(`INSERT INTO question_template_versions
    (template_id, version_no, status, checksum, lock_version, created_by, published_by,
     published_at, effective_from)
    VALUES (?, 1, 'DRAFT', ?, 1, ?, ?, datetime('now'), '2026-01-01')`)
    .run(templateId, 'a'.repeat(64), specialist, admin).lastInsertRowid);
  const itemId = Number(db.prepare(`INSERT INTO question_items
    (question_template_version_id, legacy_question_id, variant_code, facility_type,
     supplier_scale, category_code, category_label_snapshot, question_code, clause_code,
     question_text, category, allowed_scores, weight, order_index, active)
    VALUES (?, ?, 'REHEARSAL-FACTORY-LARGE', 'FACTORY', 'LARGE', 'QUALITY', 'Quality',
      'RQ-01', 'RQ-01', 'Synthetic rehearsal criterion', 'Quality', 'A/B/C/D/NA', 1, 1, 1)`)
    .run(versionId, legacyQuestionId).lastInsertRowid);
  db.prepare("UPDATE question_template_versions SET status='PUBLISHED' WHERE id=?").run(versionId);
  const ticketId = Number(db.prepare(`INSERT INTO evaluation_tickets
    (ticket_code, supplier_id, evaluation_type, template_id, question_template_version_id,
     facility_type, supplier_scale, current_status, current_round_no,
     assigned_specialist_id, created_by)
    VALUES ('REHEARSAL-TICKET', ?, 'Periodic', ?, ?, 'FACTORY', 'LARGE',
      'Completed', 1, ?, ?)`)
    .run(supplierId, templateId, versionId, specialist, specialist).lastInsertRowid);
  const roundId = Number(db.prepare(`INSERT INTO evaluation_rounds
    (ticket_id, round_no, status, total_score, final_result, classification)
    VALUES (?, 1, 'Completed', 80, 'Pass', 'B')`).run(ticketId).lastInsertRowid);
  const answerId = Number(db.prepare(`INSERT INTO evaluation_answers
    (round_id, question_id, question_item_id, score, comment, answered_by)
    VALUES (?, ?, ?, 'B', 'Synthetic rehearsal answer', ?)`)
    .run(roundId, legacyQuestionId, itemId, specialist).lastInsertRowid);
  const nonconformityId = Number(db.prepare(`INSERT INTO evaluation_nonconformities
    (ticket_id, round_id, question_id, evaluation_answer_id, nonconformity_content,
     remediation_content, due_date, status, created_by)
    VALUES (?, ?, ?, ?, 'Synthetic rehearsal finding', 'Synthetic rehearsal remediation',
      '2027-12-31', 'OPEN', ?)`)
    .run(ticketId, roundId, legacyQuestionId, answerId, specialist).lastInsertRowid);

  fs.mkdirSync(legacyRoot, { recursive: true });
  const legacyFile = path.join(legacyRoot, 'synthetic-rehearsal-report.html');
  fs.writeFileSync(legacyFile, '<!doctype html><title>Synthetic rehearsal report</title>\n', 'utf8');
  const reportExportId = Number(db.prepare(`INSERT INTO report_exports
    (ticket_id, round_id, report_type, file_format, export_scope, file_path, exported_by)
    VALUES (?, ?, 'ROUND1_RESULT', 'HTML', 'TICKET', ?, ?)`)
    .run(ticketId, roundId, legacyFile, specialist).lastInsertRowid);

  return {
    users: { admin, specialist },
    sessions,
    evaluation: { supplierId, templateId, versionId, itemId, ticketId, roundId, answerId, nonconformityId },
    report: { reportExportId },
  };
}

function createRehearsalDatabase({ dbPath, workspace, migrationsDir = MIGRATIONS_DIR }) {
  if (!dbPath || !workspace) throw new Error('rehearsal_paths_required');
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedDb = path.resolve(dbPath);
  if (!isInside(resolvedWorkspace, resolvedDb)) throw new Error('rehearsal_database_outside_workspace');
  if (fs.existsSync(resolvedDb)) throw new Error('rehearsal_database_already_exists');
  fs.mkdirSync(resolvedWorkspace, { recursive: true });
  fs.mkdirSync(path.dirname(resolvedDb), { recursive: true });
  const historicalDir = path.join(resolvedWorkspace, 'migrations-through-0027');
  const migrationIds = copyHistoricalMigrations({ sourceDir: migrationsDir, targetDir: historicalDir });
  const legacyRoot = path.join(resolvedWorkspace, 'legacy-report-files');
  const db = new Database(resolvedDb);
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historicalDir, appVersion: 'synthetic-rehearsal-0027' });
    const fixture = seedRepresentativeData(db, { legacyRoot });
    const integrity = db.pragma('integrity_check', { simple: true });
    const foreignKeys = db.pragma('foreign_key_check').length;
    if (integrity !== 'ok' || foreignKeys !== 0) throw new Error('synthetic_rehearsal_database_invalid');
    db.pragma('wal_checkpoint(TRUNCATE)');
    return {
      dbPath: resolvedDb,
      workspace: resolvedWorkspace,
      legacyRoot,
      migrationIds,
      fixture,
      integrity_check: integrity,
      foreign_key_violations: foreignKeys,
    };
  } finally {
    db.close();
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = createRehearsalDatabase(options);
  process.stdout.write(`${JSON.stringify({
    synthetic: true,
    schema_through: THROUGH_ID,
    migration_count: result.migrationIds.length,
    integrity_check: result.integrity_check,
    foreign_key_violations: result.foreign_key_violations,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  THROUGH_ID,
  copyHistoricalMigrations,
  createRehearsalDatabase,
  isInside,
  parseArgs,
  seedRepresentativeData,
};
