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

function runParity(db) {
  const hard = {
    invalid_qa_support_json: scalar(db, `SELECT COUNT(*) FROM evaluation_tickets
      WHERE qa_support_ids IS NOT NULL AND trim(qa_support_ids) != '' AND json_valid(qa_support_ids) = 0`),
    invalid_attendees_json: scalar(db, `SELECT COUNT(*) FROM evaluation_rounds
      WHERE attendees_json IS NOT NULL AND trim(attendees_json) != '' AND json_valid(attendees_json) = 0`),
    answer_question_item_unresolved: scalar(db, `SELECT COUNT(*) FROM evaluation_answers
      WHERE question_item_id IS NULL`),
    answer_question_item_mismatch: scalar(db, `SELECT COUNT(*)
      FROM evaluation_answers a
      JOIN evaluation_rounds r ON r.id=a.round_id
      JOIN evaluation_tickets t ON t.id=r.ticket_id
      LEFT JOIN question_items qi ON qi.id=a.question_item_id
      WHERE qi.id IS NULL
         OR qi.question_template_version_id != t.question_template_version_id
         OR qi.legacy_question_id != a.question_id`),
    duplicate_canonical_answers: scalar(db, `SELECT COUNT(*) FROM (
      SELECT round_id, question_item_id FROM evaluation_answers
      WHERE question_item_id IS NOT NULL
      GROUP BY round_id, question_item_id HAVING COUNT(*) > 1
    )`),
    nonconformity_answer_unresolved: scalar(db, `SELECT COUNT(*) FROM evaluation_nonconformities
      WHERE evaluation_answer_id IS NULL`),
    nonconformity_answer_mismatch: scalar(db, `SELECT COUNT(*)
      FROM evaluation_nonconformities nc
      LEFT JOIN evaluation_answers a ON a.id=nc.evaluation_answer_id
      WHERE a.id IS NULL OR a.round_id != nc.round_id OR a.question_id != nc.question_id`),
    nonconformity_content_mismatch: scalar(db, `SELECT COUNT(*)
      FROM evaluation_nonconformities nc
      LEFT JOIN corrective_actions ca ON ca.id = nc.corrective_action_id
      WHERE COALESCE(nc.nonconformity_content, '') != COALESCE(nc.nonconformity, '')
         OR COALESCE(nc.remediation_content, '') != COALESCE(nc.remediation, ca.required_action, '')`),
    duplicate_nonconformity_answers: scalar(db, `SELECT COUNT(*) FROM (
      SELECT evaluation_answer_id FROM evaluation_nonconformities
      WHERE evaluation_answer_id IS NOT NULL
      GROUP BY evaluation_answer_id HAVING COUNT(*) > 1
    )`),
    active_users_without_role: scalar(db, `SELECT COUNT(*) FROM users u
      WHERE u.is_active=1 AND NOT EXISTS (
        SELECT 1 FROM user_roles ur WHERE ur.user_id=u.email AND ur.active=1
      )`),
    ticket_question_version_unpinned: scalar(db, `SELECT COUNT(*) FROM evaluation_tickets
      WHERE question_template_version_id IS NULL`),
    ticket_scoring_version_unpinned: scalar(db, `SELECT COUNT(*) FROM evaluation_tickets
      WHERE scoring_policy_version_id IS NULL`),
    round_scoring_version_unpinned: scalar(db, `SELECT COUNT(*) FROM evaluation_rounds
      WHERE scoring_policy_version_id IS NULL`),
    round_scoring_version_mismatch: scalar(db, `SELECT COUNT(*) FROM evaluation_rounds r
      JOIN evaluation_tickets t ON t.id=r.ticket_id
      WHERE r.scoring_policy_version_id != t.scoring_policy_version_id`),
    snapshot_lock_missing: scalar(db, `SELECT COUNT(*) FROM evaluation_tickets t
      WHERE EXISTS (SELECT 1 FROM evaluation_rounds r WHERE r.ticket_id=t.id AND r.round_no=1)
        AND t.snapshot_locked_at IS NULL`),
    snapshot_lock_after_round1: scalar(db, `SELECT COUNT(*) FROM evaluation_tickets t
      JOIN evaluation_rounds r ON r.ticket_id=t.id AND r.round_no=1
      WHERE t.snapshot_locked_at > r.started_at`),
    tickets_over_two_rounds: scalar(db, `SELECT COUNT(*) FROM (
      SELECT ticket_id FROM evaluation_rounds GROUP BY ticket_id
      HAVING COUNT(*) > 2 OR MAX(round_no) > 2 OR MIN(round_no) < 1
    )`),
    canonical_report_link_mismatch: scalar(db, `SELECT COUNT(*) FROM report_exports e
      LEFT JOIN report_export_jobs j ON j.id=e.job_id
      LEFT JOIN report_artifacts a ON a.id=e.artifact_id
      WHERE (e.job_id IS NOT NULL AND j.id IS NULL)
         OR (e.artifact_id IS NOT NULL AND (a.id IS NULL OR a.job_id != e.job_id))
         OR (j.id IS NOT NULL AND e.report_template_version_id IS NOT j.report_template_version_id)`),
    foreign_key_violations: db.pragma('foreign_key_check').length,
  };

  const participant = {
    expected_ticket_owner: scalar(db, `SELECT COUNT(*) FROM evaluation_tickets
      WHERE assigned_specialist_id IS NOT NULL AND trim(assigned_specialist_id) != ''`),
    actual_ticket_owner: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE ticket_id IS NOT NULL AND participant_role='OWNER' AND active=1`),
    expected_ticket_lead: scalar(db, `SELECT COUNT(*) FROM evaluation_tickets
      WHERE qa_lead_id IS NOT NULL AND trim(qa_lead_id) != ''`),
    actual_ticket_lead: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE ticket_id IS NOT NULL AND participant_role='QA_LEAD' AND active=1`),
    expected_ticket_support: scalar(db, `SELECT COUNT(*) FROM (
      SELECT t.id, lower(trim(CAST(j.value AS TEXT))) identity
      FROM evaluation_tickets t
      JOIN json_each(CASE WHEN json_valid(t.qa_support_ids) THEN t.qa_support_ids ELSE '[]' END) j
      WHERE j.type='text' AND trim(CAST(j.value AS TEXT)) != ''
      GROUP BY t.id, identity
    )`),
    actual_ticket_support: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE ticket_id IS NOT NULL AND participant_role='QA_SUPPORT' AND active=1`),
    expected_ticket_evaluator: scalar(db, `SELECT COUNT(*) FROM evaluation_tickets
      WHERE evaluator_name IS NOT NULL AND trim(evaluator_name) != ''`),
    actual_ticket_evaluator: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE ticket_id IS NOT NULL AND participant_role='EVALUATOR' AND active=1`),
    expected_round_evaluator: scalar(db, `SELECT COUNT(*) FROM evaluation_rounds
      WHERE evaluator_id IS NOT NULL AND trim(evaluator_id) != ''`),
    actual_round_evaluator: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE round_id IS NOT NULL AND participant_role='EVALUATOR' AND active=1`),
    expected_round_attendee: scalar(db, `SELECT COUNT(*) FROM (
      SELECT r.id, lower(trim(COALESCE(json_extract(j.value, '$.name'), json_extract(j.value, '$.title')))) identity
      FROM evaluation_rounds r
      JOIN json_each(CASE WHEN json_valid(r.attendees_json) THEN r.attendees_json ELSE '[]' END) j
      WHERE j.type='object' AND trim(COALESCE(
        json_extract(j.value, '$.name'), json_extract(j.value, '$.title'), ''
      )) != ''
      GROUP BY r.id, identity
    )`),
    actual_round_attendee: scalar(db, `SELECT COUNT(*) FROM evaluation_participants
      WHERE round_id IS NOT NULL AND participant_role='ATTENDEE' AND active=1`),
  };
  hard.participant_count_mismatches = [
    ['expected_ticket_owner', 'actual_ticket_owner'],
    ['expected_ticket_lead', 'actual_ticket_lead'],
    ['expected_ticket_support', 'actual_ticket_support'],
    ['expected_ticket_evaluator', 'actual_ticket_evaluator'],
    ['expected_round_evaluator', 'actual_round_evaluator'],
    ['expected_round_attendee', 'actual_round_attendee'],
  ].filter(([expected, actual]) => participant[expected] !== participant[actual]).length;

  const warnings = {
    legacy_report_exports_without_job: scalar(db, `SELECT COUNT(*) FROM report_exports
      WHERE job_id IS NULL`),
    legacy_report_exports_without_artifact: scalar(db, `SELECT COUNT(*) FROM report_exports
      WHERE artifact_id IS NULL`),
    legacy_corrective_actions_without_nonconformity: scalar(db, `SELECT COUNT(*)
      FROM corrective_actions ca
      WHERE NOT EXISTS (
        SELECT 1 FROM evaluation_nonconformities nc WHERE nc.corrective_action_id=ca.id
      )`),
  };
  const integrity = db.pragma('integrity_check', { simple: true });
  const status = integrity === 'ok' && Object.values(hard).every((value) => value === 0)
    ? 'PASS' : 'FAIL';
  return { status, integrity_check: integrity, hard_failures: hard, participant_counts: participant, warnings };
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
