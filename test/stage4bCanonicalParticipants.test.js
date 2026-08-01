'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');
const LEGACY_TICKET_COLUMNS = ['evaluator_name', 'qa_lead_id', 'qa_support_ids'];
const LEGACY_ROUND_COLUMNS = ['evaluator_id', 'attendees_json'];

function historicalDirectory(lastId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `qlcl-stage4b-${lastId}-`));
  for (const fileName of fs.readdirSync(migrationsDir)) {
    if (!/^\d{4}_.+\.sql$/.test(fileName) || fileName.slice(0, 4) > lastId) continue;
    fs.copyFileSync(path.join(migrationsDir, fileName), path.join(directory, fileName));
  }
  return directory;
}

function columns(db, table) {
  return db.pragma(`table_info('${table}')`).map((row) => row.name);
}

function seedLegacyParticipants(db, { attendeesJson = null } = {}) {
  for (const [email, displayName] of [
    ['owner-stage4b@example.invalid', 'Stage 4B Owner'],
    ['lead-stage4b@example.invalid', 'Stage 4B Lead'],
    ['support-stage4b@example.invalid', 'Stage 4B Support'],
    ['round-stage4b@example.invalid', 'Stage 4B Round Evaluator'],
  ]) {
    db.prepare(`INSERT INTO users (email, is_admin, role, is_active, display_name, created_by)
      VALUES (?, 0, 'ChuyÃªn viÃªn', 1, ?, 'fixture')`).run(email, displayName);
  }
  const supplierId = db.prepare(`INSERT INTO supplier_master
    (supplier_code, supplier_name, status, source_type, created_by)
    VALUES ('STAGE4B-NCC', 'Synthetic Stage 4B NCC', 'ACTIVE', 'MANUAL',
      'owner-stage4b@example.invalid')`).run().lastInsertRowid;
  const templateId = db.prepare(`INSERT INTO question_templates
    (template_code, template_name, active)
    VALUES ('STAGE4B-Q', 'Synthetic Stage 4B Questions', 1)`).run().lastInsertRowid;
  const ticketId = db.prepare(`INSERT INTO evaluation_tickets
    (ticket_code, supplier_id, evaluation_type, template_id, facility_type, supplier_scale,
     current_status, current_round_no, assigned_specialist_id, evaluator_name,
     qa_lead_id, qa_support_ids, created_by)
    VALUES ('STAGE4B-TICKET', ?, 'Periodic', ?, 'FACTORY', 'LARGE', 'Draft', 1,
      'owner-stage4b@example.invalid', 'External historical evaluator',
      'lead-stage4b@example.invalid', ?, 'owner-stage4b@example.invalid')`).run(
    supplierId,
    templateId,
    JSON.stringify(['support-stage4b@example.invalid']),
  ).lastInsertRowid;
  const roundId = db.prepare(`INSERT INTO evaluation_rounds
    (ticket_id, round_no, evaluator_id, attendees_json, status)
    VALUES (?, 1, 'round-stage4b@example.invalid', ?, 'Draft')`).run(
    ticketId,
    attendeesJson === null
      ? JSON.stringify([
        { name: 'Supplier Representative', opening: true, closing: false },
        { name: 'Supplier Representative', opening: false, closing: true },
      ])
      : attendeesJson,
  ).lastInsertRowid;
  return { roundId, ticketId };
}

test('stage 4B fresh schema stores participant assignments canonically without legacy columns', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir, appVersion: 'stage4b-test' });
    for (const column of LEGACY_TICKET_COLUMNS) {
      assert.ok(!columns(db, 'evaluation_tickets').includes(column), column);
    }
    for (const column of LEGACY_ROUND_COLUMNS) {
      assert.ok(!columns(db, 'evaluation_rounds').includes(column), column);
    }
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
  }
});

test('stage 4B backfills ticket and round participants before dropping legacy storage', () => {
  const historical = historicalDirectory('0026');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage4a-test' });
    const fixture = seedLegacyParticipants(db);
    migrateDatabase(db, { migrationsDir, appVersion: 'stage4b-test' });

    const ticketParticipants = db.prepare(`SELECT participant_role, user_id, display_name
      FROM evaluation_participants WHERE ticket_id=? ORDER BY participant_role`).all(fixture.ticketId);
    assert.deepEqual(ticketParticipants.map((row) => row.participant_role),
      ['EVALUATOR', 'OWNER', 'QA_LEAD', 'QA_SUPPORT']);
    assert.equal(ticketParticipants.find((row) => row.participant_role === 'EVALUATOR').display_name,
      'External historical evaluator');
    assert.equal(ticketParticipants.find((row) => row.participant_role === 'QA_LEAD').user_id,
      'lead-stage4b@example.invalid');

    const roundParticipants = db.prepare(`SELECT participant_role, user_id, display_name,
        opening_meeting, closing_meeting
      FROM evaluation_participants WHERE round_id=? ORDER BY participant_role`).all(fixture.roundId);
    assert.deepEqual(roundParticipants.map((row) => row.participant_role), ['ATTENDEE', 'EVALUATOR']);
    const attendee = roundParticipants.find((row) => row.participant_role === 'ATTENDEE');
    assert.equal(attendee.display_name, 'Supplier Representative');
    assert.equal(attendee.opening_meeting, 1);
    assert.equal(attendee.closing_meeting, 1);
    assert.equal(roundParticipants.find((row) => row.participant_role === 'EVALUATOR').user_id,
      'round-stage4b@example.invalid');
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0027'").pluck().get(), 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);

    const retry = migrateDatabase(db, { migrationsDir, appVersion: 'stage4b-test' });
    assert.equal(retry.results.find((row) => row.id === '0027').state, 'already-applied');
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0027'").pluck().get(), 1);
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});

test('stage 4B refuses malformed attendee JSON and rolls the migration back', () => {
  const historical = historicalDirectory('0026');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage4a-test' });
    seedLegacyParticipants(db, { attendeesJson: '{malformed-json' });
    assert.throws(
      () => migrateDatabase(db, { migrationsDir, appVersion: 'stage4b-test' }),
      /CHECK constraint failed/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0027'").pluck().get(), 0);
    assert.ok(columns(db, 'evaluation_rounds').includes('attendees_json'));
    assert.equal(db.prepare("SELECT attendees_json FROM evaluation_rounds WHERE assessment_code IS NULL").pluck().get(),
      '{malformed-json');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');

    db.prepare("UPDATE evaluation_rounds SET attendees_json='[]'").run();
    migrateDatabase(db, { migrationsDir, appVersion: 'stage4b-test' });
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0027'").pluck().get(), 1);
    assert.ok(!columns(db, 'evaluation_rounds').includes('attendees_json'));
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});

test('stage 4B refuses conflicting canonical and legacy participant identities', () => {
  const historical = historicalDirectory('0026');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage4a-test' });
    const { ticketId } = seedLegacyParticipants(db);
    db.prepare(`INSERT INTO evaluation_participants (
      ticket_id, display_name, participant_role, active, assigned_by
    ) VALUES (?, 'Conflicting evaluator', 'EVALUATOR', 1, 'owner-stage4b@example.invalid')`).run(ticketId);

    assert.throws(
      () => migrateDatabase(db, { migrationsDir, appVersion: 'stage4b-test' }),
      /CHECK constraint failed/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0027'").pluck().get(), 0);
    assert.ok(columns(db, 'evaluation_tickets').includes('evaluator_name'));
    assert.equal(db.prepare(`SELECT COUNT(*) FROM evaluation_participants
      WHERE ticket_id=? AND participant_role='EVALUATOR'`).pluck().get(ticketId), 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});
