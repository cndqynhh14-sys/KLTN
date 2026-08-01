'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../server/config/paths');

function parseArgs(argv) {
  const index = argv.indexOf('--db');
  return { dbPath: path.resolve(index >= 0 && argv[index + 1] ? argv[index + 1] : DB_PATH) };
}

function scalar(db, sql, params = []) {
  return Number(db.prepare(sql).pluck().get(...params) || 0);
}

function tableExists(db, tableName) {
  return scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", [tableName]) === 1;
}

function columnNames(db, tableName) {
  return new Set(db.pragma(`table_info('${tableName}')`).map((row) => row.name));
}

function runParity(db) {
  const nonconformityColumns = columnNames(db, 'evaluation_nonconformities');
  const ticketColumns = columnNames(db, 'evaluation_tickets');
  const roundColumns = columnNames(db, 'evaluation_rounds');
  const userColumns = columnNames(db, 'users');
  const reportColumns = columnNames(db, 'report_exports');
  const correctiveActionsPresent = tableExists(db, 'corrective_actions');

  const hard = {
    migration_0026_missing: scalar(db, "SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE migration_id='0026') THEN 0 ELSE 1 END"),
    corrective_actions_table_present: correctiveActionsPresent ? 1 : 0,
    legacy_nonconformity_columns_present: ['nonconformity', 'remediation', 'corrective_action_id']
      .filter((column) => nonconformityColumns.has(column)).length,
    canonical_nonconformity_columns_missing: ['nonconformity_content', 'remediation_content']
      .filter((column) => !nonconformityColumns.has(column)).length,
    blank_nonconformity_content: scalar(db, `SELECT COUNT(*) FROM evaluation_nonconformities
      WHERE NULLIF(TRIM(COALESCE(nonconformity_content, '')), '') IS NULL`),
    duplicate_nonconformity_answers: scalar(db, `SELECT COUNT(*) FROM (
      SELECT evaluation_answer_id FROM evaluation_nonconformities
      WHERE evaluation_answer_id IS NOT NULL
      GROUP BY evaluation_answer_id HAVING COUNT(*) > 1
    )`),
    tickets_over_two_rounds: scalar(db, `SELECT COUNT(*) FROM (
      SELECT ticket_id FROM evaluation_rounds GROUP BY ticket_id
      HAVING COUNT(*) > 2 OR MAX(round_no) > 2 OR MIN(round_no) < 1
    )`),
  };

  const deferred = {
    evaluation_questions_rows: tableExists(db, 'evaluation_questions')
      ? scalar(db, 'SELECT COUNT(*) FROM evaluation_questions') : 0,
    answers_with_legacy_question_link: columnNames(db, 'evaluation_answers').has('question_id')
      ? scalar(db, 'SELECT COUNT(*) FROM evaluation_answers WHERE question_id IS NOT NULL') : 0,
    users_with_legacy_role: userColumns.has('role')
      ? scalar(db, "SELECT COUNT(*) FROM users WHERE NULLIF(TRIM(COALESCE(role, '')), '') IS NOT NULL") : 0,
    legacy_admin_flags: userColumns.has('is_admin')
      ? scalar(db, 'SELECT COUNT(*) FROM users WHERE is_admin=1') : 0,
    tickets_with_legacy_qa_lead: ticketColumns.has('qa_lead_id')
      ? scalar(db, "SELECT COUNT(*) FROM evaluation_tickets WHERE NULLIF(TRIM(COALESCE(qa_lead_id, '')), '') IS NOT NULL") : 0,
    tickets_with_legacy_qa_support_json: ticketColumns.has('qa_support_ids')
      ? scalar(db, "SELECT COUNT(*) FROM evaluation_tickets WHERE NULLIF(TRIM(COALESCE(qa_support_ids, '')), '') IS NOT NULL AND qa_support_ids != '[]'") : 0,
    tickets_with_legacy_evaluator_name: ticketColumns.has('evaluator_name')
      ? scalar(db, "SELECT COUNT(*) FROM evaluation_tickets WHERE NULLIF(TRIM(COALESCE(evaluator_name, '')), '') IS NOT NULL") : 0,
    rounds_with_legacy_evaluator: roundColumns.has('evaluator_id')
      ? scalar(db, "SELECT COUNT(*) FROM evaluation_rounds WHERE NULLIF(TRIM(COALESCE(evaluator_id, '')), '') IS NOT NULL") : 0,
    rounds_with_legacy_attendees_json: roundColumns.has('attendees_json')
      ? scalar(db, "SELECT COUNT(*) FROM evaluation_rounds WHERE NULLIF(TRIM(COALESCE(attendees_json, '')), '') IS NOT NULL AND attendees_json != '[]'") : 0,
    report_exports_without_job: reportColumns.has('job_id')
      ? scalar(db, 'SELECT COUNT(*) FROM report_exports WHERE job_id IS NULL') : 0,
    report_exports_without_artifact: reportColumns.has('artifact_id')
      ? scalar(db, 'SELECT COUNT(*) FROM report_exports WHERE artifact_id IS NULL') : 0,
  };

  const integrity = db.pragma('integrity_check', { simple: true });
  const foreignKeyViolations = db.pragma('foreign_key_check').length;
  const status = integrity === 'ok'
    && foreignKeyViolations === 0
    && Object.values(hard).every((value) => value === 0)
    ? 'PASS' : 'FAIL';
  return {
    status,
    integrity_check: integrity,
    foreign_key_check: foreignKeyViolations,
    hard_failures: hard,
    deferred_cleanup_indicators: deferred,
  };
}

function main() {
  const { dbPath } = parseArgs(process.argv.slice(2));
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const output = { database: dbPath, ...runParity(db) };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (output.status !== 'PASS') process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { parseArgs, runParity };
