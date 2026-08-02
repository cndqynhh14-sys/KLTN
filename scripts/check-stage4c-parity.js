'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../server/config/paths');

function parseArgs(argv) {
  const index = argv.indexOf('--db');
  return { dbPath: path.resolve(index >= 0 && argv[index + 1] ? argv[index + 1] : DB_PATH) };
}

function scalar(db, sql) {
  return Number(db.prepare(sql).pluck().get() || 0);
}

function tableExists(db, table) {
  return scalar(db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table}'`) === 1;
}

function columns(db, table) {
  return new Set(db.pragma(`table_info('${table}')`).map((row) => row.name));
}

function runParity(db) {
  const answerColumns = columns(db, 'evaluation_answers');
  const itemColumns = columns(db, 'question_items');
  const nonconformityColumns = columns(db, 'evaluation_nonconformities');
  const hard = {
    migration_0028_missing: scalar(db, "SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE migration_id='0028') THEN 0 ELSE 1 END"),
    evaluation_questions_present: tableExists(db, 'evaluation_questions') ? 1 : 0,
    legacy_item_identity_present: itemColumns.has('legacy_question_id') ? 1 : 0,
    legacy_answer_identity_present: answerColumns.has('question_id') ? 1 : 0,
    legacy_nonconformity_identity_present: nonconformityColumns.has('question_id') ? 1 : 0,
    canonical_answer_identity_missing: answerColumns.has('question_item_id') ? 0 : 1,
    canonical_nonconformity_identity_missing: nonconformityColumns.has('evaluation_answer_id') ? 0 : 1,
    ticket_version_unpinned: scalar(db, `SELECT COUNT(*) FROM evaluation_tickets t
      LEFT JOIN question_template_versions v ON v.id=t.question_template_version_id
      WHERE v.id IS NULL OR v.template_id<>t.template_id`),
    answer_item_or_scope_mismatch: scalar(db, `SELECT COUNT(*) FROM evaluation_answers a
      JOIN evaluation_rounds r ON r.id=a.round_id
      JOIN evaluation_tickets t ON t.id=r.ticket_id
      LEFT JOIN question_items qi ON qi.id=a.question_item_id
      WHERE qi.id IS NULL OR qi.question_template_version_id<>t.question_template_version_id`),
    duplicate_round_item_answers: scalar(db, `SELECT COUNT(*) FROM (
      SELECT round_id, question_item_id FROM evaluation_answers
      GROUP BY round_id, question_item_id HAVING COUNT(*)<>1
    )`),
    nonconformity_answer_scope_mismatch: scalar(db, `SELECT COUNT(*) FROM evaluation_nonconformities nc
      LEFT JOIN evaluation_answers a ON a.id=nc.evaluation_answer_id
      LEFT JOIN evaluation_rounds r ON r.id=a.round_id
      WHERE a.id IS NULL OR r.id IS NULL OR nc.round_id<>r.id OR nc.ticket_id<>r.ticket_id`),
    foreign_key_violations: db.pragma('foreign_key_check').length,
  };
  const integrity = db.pragma('integrity_check', { simple: true });
  return {
    status: integrity === 'ok' && Object.values(hard).every((value) => value === 0) ? 'PASS' : 'FAIL',
    integrity_check: integrity,
    hard_failures: hard,
    counts: {
      templates: scalar(db, 'SELECT COUNT(*) FROM question_templates'),
      versions: scalar(db, 'SELECT COUNT(*) FROM question_template_versions'),
      question_items: scalar(db, 'SELECT COUNT(*) FROM question_items'),
      tickets: scalar(db, 'SELECT COUNT(*) FROM evaluation_tickets'),
      answers: scalar(db, 'SELECT COUNT(*) FROM evaluation_answers'),
      nonconformities: scalar(db, 'SELECT COUNT(*) FROM evaluation_nonconformities'),
    },
  };
}

function main() {
  const { dbPath } = parseArgs(process.argv.slice(2));
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const result = { database: dbPath, ...runParity(db) };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'PASS') process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { parseArgs, runParity };
