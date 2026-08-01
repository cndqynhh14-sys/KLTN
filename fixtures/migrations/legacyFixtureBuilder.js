'use strict';

const Database = require('better-sqlite3');

const FIXTURE = Object.freeze({
  userEmail: 'user-001@example.invalid',
  userName: 'SYNTHETIC USER 001',
  supplierCode: 'SYN-NCC-001',
  supplierName: 'SYNTHETIC NCC 001',
  ticketCode: 'SYN-TICKET-001',
  reportPath: 'synthetic-report.pdf',
  timestamp: '2026-01-01 00:00:00',
});

const CORE_TABLES = Object.freeze([
  'users',
  'supplier_master',
  'evaluation_tickets',
  'report_exports',
]);

function createLegacyFixture(dbPath) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      email TEXT PRIMARY KEY,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      display_name TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    );
    CREATE TABLE supplier_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_code TEXT NOT NULL UNIQUE,
      supplier_name TEXT NOT NULL,
      tax_code TEXT,
      address TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      mch2 TEXT,
      mch3 TEXT,
      product_group TEXT,
      product_name TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      source_type TEXT NOT NULL,
      import_batch_id INTEGER,
      created_at TEXT NOT NULL,
      created_by TEXT,
      updated_at TEXT,
      updated_by TEXT
    );
    CREATE TABLE evaluation_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_code TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL,
      supplier_code TEXT,
      supplier_name TEXT,
      tax_code TEXT,
      supplier_address TEXT,
      current_status TEXT NOT NULL,
      assigned_specialist_id TEXT,
      evaluation_type TEXT NOT NULL,
      template_id INTEGER NOT NULL,
      facility_type TEXT NOT NULL,
      supplier_scale TEXT NOT NULL,
      current_round_no INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_by TEXT,
      updated_at TEXT,
      updated_by TEXT
    );
    CREATE TABLE corrective_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      round_id INTEGER NOT NULL,
      issue_description TEXT NOT NULL,
      required_action TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL
    );
    CREATE TABLE report_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      report_template_id INTEGER,
      report_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      exported_by TEXT,
      exported_at TEXT NOT NULL
    );
  `);

  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO users
      (email, is_admin, is_active, display_name, created_at, created_by)
      VALUES (?, 1, 1, ?, ?, 'fixture')`).run(FIXTURE.userEmail, FIXTURE.userName, FIXTURE.timestamp);
    db.prepare(`INSERT INTO supplier_master
      (supplier_code, supplier_name, status, source_type, created_at, created_by)
      VALUES (?, ?, 'ACTIVE', 'SYNTHETIC', ?, 'fixture')`).run(FIXTURE.supplierCode, FIXTURE.supplierName, FIXTURE.timestamp);
    db.prepare(`INSERT INTO evaluation_tickets (
      ticket_code, supplier_id, supplier_code, supplier_name, supplier_address,
      current_status, assigned_specialist_id, evaluation_type, template_id,
      facility_type, supplier_scale, created_at, created_by
    ) VALUES (?, 1, ?, ?, 'SYNTHETIC ADDRESS', 'Khoi tao', ?, 'Synthetic', 1,
      'Synthetic facility', 'LARGE', ?, ?)`).run(
      FIXTURE.ticketCode, FIXTURE.supplierCode, FIXTURE.supplierName,
      FIXTURE.userEmail, FIXTURE.timestamp, FIXTURE.userEmail
    );
    db.prepare(`INSERT INTO report_exports
      (ticket_id, report_type, file_path, exported_by, exported_at)
      VALUES (1, 'INTERNAL', ?, ?, ?)`).run(FIXTURE.reportPath, FIXTURE.userEmail, FIXTURE.timestamp);
  });
  insert();
  const counts = snapshotCounts(db, CORE_TABLES);
  db.close();
  return { fixture: FIXTURE, counts };
}

function snapshotCounts(db, tables = CORE_TABLES) {
  return Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  ]));
}

module.exports = {
  CORE_TABLES,
  FIXTURE,
  createLegacyFixture,
  snapshotCounts,
};
