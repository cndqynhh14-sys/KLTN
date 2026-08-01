'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../server/config/paths');

const RETIRED_TICKET_COLUMNS = ['evaluator_name', 'qa_lead_id', 'qa_support_ids'];
const RETIRED_ROUND_COLUMNS = ['evaluator_id', 'attendees_json'];

function parseArgs(argv) {
  const index = argv.indexOf('--db');
  return { dbPath: path.resolve(index >= 0 && argv[index + 1] ? argv[index + 1] : DB_PATH) };
}

function scalar(db, sql, params = []) {
  return Number(db.prepare(sql).pluck().get(...params) || 0);
}

function columnNames(db, tableName) {
  return new Set(db.pragma(`table_info('${tableName}')`).map((row) => row.name));
}

function runParity(db) {
  const ticketColumns = columnNames(db, 'evaluation_tickets');
  const roundColumns = columnNames(db, 'evaluation_rounds');
  const hard = {
    migration_0027_missing: scalar(db, `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM schema_migrations WHERE migration_id='0027'
    ) THEN 0 ELSE 1 END`),
    retired_ticket_columns_present: RETIRED_TICKET_COLUMNS
      .filter((column) => ticketColumns.has(column)).length,
    retired_round_columns_present: RETIRED_ROUND_COLUMNS
      .filter((column) => roundColumns.has(column)).length,
    invalid_participant_scope: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE (ticket_id IS NULL) = (round_id IS NULL)`),
    invalid_participant_role: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE participant_role NOT IN (
        'OWNER', 'SPECIALIST', 'QA_LEAD', 'QA_SUPPORT',
        'EVALUATOR', 'SUPPLIER_REP', 'ATTENDEE', 'OTHER'
      )`),
    invalid_meeting_flags: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE opening_meeting NOT IN (0, 1) OR closing_meeting NOT IN (0, 1)`),
    blank_participant_identity: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE NULLIF(TRIM(COALESCE(user_id, display_name, '')), '') IS NULL`),
    orphan_internal_user: scalar(db, `SELECT COUNT(*) FROM evaluation_participants p
      WHERE p.user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email)=lower(p.user_id))`),
    duplicate_active_identity: scalar(db, `SELECT COUNT(*) FROM (
      SELECT ticket_id, round_id, participant_role,
             lower(COALESCE(user_id, TRIM(display_name))) AS identity_key
      FROM evaluation_participants
      WHERE active=1
      GROUP BY ticket_id, round_id, participant_role, identity_key
      HAVING COUNT(*) > 1
    )`),
    tickets_over_two_rounds: scalar(db, `SELECT COUNT(*) FROM (
      SELECT ticket_id FROM evaluation_rounds GROUP BY ticket_id
      HAVING COUNT(*) > 2 OR MAX(round_no) > 2 OR MIN(round_no) < 1
    )`),
  };

  const counts = {
    participant_rows: scalar(db, 'SELECT COUNT(*) FROM evaluation_participants'),
    active_ticket_participants: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE ticket_id IS NOT NULL AND active=1`),
    active_round_participants: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE round_id IS NOT NULL AND active=1`),
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
    counts,
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
