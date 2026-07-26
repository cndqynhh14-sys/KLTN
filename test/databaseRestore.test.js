'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { runWithContext } = require('../server/observability/context');
const { AuditEventService } = require('../server/services/AuditEventService');
const {
  DatabaseRestoreError,
  restoreDatabase,
} = require('../server/services/DatabaseRestoreService');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

function createMigratedDatabase(filePath, marker) {
  const db = new Database(filePath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrateDatabase(db, { migrationsDir, appVersion: 'run-07-restore-test' });
    db.exec('CREATE TABLE synthetic_restore_marker (value TEXT NOT NULL)');
    db.prepare('INSERT INTO synthetic_restore_marker (value) VALUES (?)').run(marker);
  } finally {
    db.close();
  }
}

function markerAt(filePath) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT value FROM synthetic_restore_marker').pluck().get();
  } finally {
    db.close();
  }
}

test('restore activates only a snapshot carrying a CRITICAL event in its valid audit chain', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-restore-success-'));
  const activePath = path.join(tempDir, 'active.db');
  const incomingPath = path.join(tempDir, 'incoming.db');
  const stagedPath = path.join(tempDir, 'staged.db');
  const backupPath = path.join(tempDir, 'backup.db');
  createMigratedDatabase(activePath, 'ORIGINAL');
  createMigratedDatabase(incomingPath, 'RESTORED');
  const activeDb = new Database(activePath);
  activeDb.pragma('journal_mode = WAL');

  try {
    const outerContext = {
      request_id: 'request-run07-restore-0001',
      correlation_id: 'correlation-run07-restore-0001',
      uat_run_id: 'uat-run07-restore-0001',
    };
    const result = runWithContext(outerContext, () => restoreDatabase({
      activeDb,
      activePath,
      incomingPath,
      stagedPath,
      backupPath,
      auditEvent: {
        actorUserId: 'restore-admin@example.invalid',
        actorRoles: ['SYS_ADMIN'],
        counts: { synthetic: 1 },
      },
    }));

    assert.equal(result.activated, true);
    assert.equal(outerContext.audit_mutation_recorded, true);
    assert.equal(outerContext.audit_event_id, result.auditEventId);
    assert.equal(activeDb.open, false);
    assert.equal(markerAt(activePath), 'RESTORED');
    assert.equal(markerAt(backupPath), 'ORIGINAL');
    assert.equal(fs.existsSync(stagedPath), false);

    const restored = new Database(activePath, { readonly: true, fileMustExist: true });
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const event = restored.prepare(`SELECT event_name, severity, outcome, request_id, correlation_id, uat_run_id
        FROM audit_events ORDER BY id DESC LIMIT 1`).get();
      assert.deepEqual(event, {
        event_name: 'config.restore.requested',
        severity: 'CRITICAL',
        outcome: 'SUCCESS',
        request_id: 'request-run07-restore-0001',
        correlation_id: 'correlation-run07-restore-0001',
        uat_run_id: 'uat-run07-restore-0001',
      });
      assert.equal(new AuditEventService(restored).verifyChain().valid, true);
      assert.equal(backup.prepare(`SELECT COUNT(*) FROM audit_events
        WHERE event_name = 'config.restore.requested'`).pluck().get(), 0);
    } finally {
      restored.close();
      backup.close();
    }
  } finally {
    if (activeDb.open) activeDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('restore fails closed before closing or replacing the active database when audit persistence is unavailable', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-restore-failure-'));
  const activePath = path.join(tempDir, 'active.db');
  const incomingPath = path.join(tempDir, 'incoming.db');
  const stagedPath = path.join(tempDir, 'staged.db');
  const backupPath = path.join(tempDir, 'backup.db');
  createMigratedDatabase(activePath, 'ORIGINAL');
  const incoming = new Database(incomingPath);
  incoming.exec(`CREATE TABLE synthetic_restore_marker (value TEXT NOT NULL);
    INSERT INTO synthetic_restore_marker (value) VALUES ('UNSAFE');`);
  incoming.close();
  const activeDb = new Database(activePath);

  try {
    const outerContext = { request_id: 'request-run07-restore-0002' };
    assert.throws(() => runWithContext(outerContext, () => restoreDatabase({
      activeDb,
      activePath,
      incomingPath,
      stagedPath,
      backupPath,
      auditEvent: {
        actorUserId: 'restore-admin@example.invalid',
        actorRoles: ['SYS_ADMIN'],
        requestId: 'request-run07-restore-0002',
      },
    })), (error) => error instanceof DatabaseRestoreError
      && error.code === 'restore_audit_persistence_failed'
      && error.restartRequired === false);

    assert.equal(outerContext.audit_mutation_recorded, undefined);
    assert.equal(activeDb.open, true);
    assert.equal(activeDb.prepare('SELECT value FROM synthetic_restore_marker').pluck().get(), 'ORIGINAL');
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(stagedPath), false);
  } finally {
    activeDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('restore rejects a staged snapshot whose existing audit chain does not verify', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-restore-chain-'));
  const activePath = path.join(tempDir, 'active.db');
  const incomingPath = path.join(tempDir, 'incoming.db');
  const stagedPath = path.join(tempDir, 'staged.db');
  const backupPath = path.join(tempDir, 'backup.db');
  createMigratedDatabase(activePath, 'ORIGINAL');
  createMigratedDatabase(incomingPath, 'UNTRUSTED');
  const untrusted = new Database(incomingPath);
  const untrustedAudit = new AuditEventService(untrusted);
  const event = untrustedAudit.record({
    eventName: 'supplier.updated',
    entityType: 'SUPPLIER',
    entityId: 'NCC_SYNTHETIC_RESTORE',
    action: 'UPDATE',
    outcome: 'SUCCESS',
    summary: 'Synthetic event before chain tampering',
  });
  untrusted.exec('DROP TRIGGER audit_events_append_only_update');
  untrusted.prepare("UPDATE audit_events SET summary = 'Synthetic tamper' WHERE id = ?").run(event.id);
  untrusted.exec(`CREATE TRIGGER audit_events_append_only_update
    BEFORE UPDATE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END;`);
  untrusted.close();
  const activeDb = new Database(activePath);

  try {
    assert.throws(() => restoreDatabase({
      activeDb,
      activePath,
      incomingPath,
      stagedPath,
      backupPath,
      auditEvent: {
        actorUserId: 'restore-admin@example.invalid',
        actorRoles: ['SYS_ADMIN'],
        requestId: 'request-run07-restore-0003',
      },
    }), (error) => error instanceof DatabaseRestoreError
      && error.code === 'restore_audit_persistence_failed'
      && error.restartRequired === false);

    assert.equal(activeDb.open, true);
    assert.equal(activeDb.prepare('SELECT value FROM synthetic_restore_marker').pluck().get(), 'ORIGINAL');
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(stagedPath), false);
  } finally {
    activeDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('activation failure never removes the original database path before restart', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-restore-activation-'));
  const activePath = path.join(tempDir, 'active.db');
  const incomingPath = path.join(tempDir, 'incoming.db');
  const stagedPath = path.join(tempDir, 'staged.db');
  const backupPath = path.join(tempDir, 'backup.db');
  createMigratedDatabase(activePath, 'ORIGINAL');
  createMigratedDatabase(incomingPath, 'RESTORED');
  const activeDb = new Database(activePath);
  const realRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if ((path.resolve(source) === path.resolve(stagedPath) && path.resolve(destination) === path.resolve(activePath))
      || (path.resolve(source) === path.resolve(backupPath) && path.resolve(destination) === path.resolve(activePath))) {
      throw Object.assign(new Error('synthetic_activation_rename_failure'), { code: 'EBUSY' });
    }
    return realRenameSync(source, destination);
  };

  try {
    assert.throws(() => restoreDatabase({
      activeDb,
      activePath,
      incomingPath,
      stagedPath,
      backupPath,
      auditEvent: {
        actorUserId: 'restore-admin@example.invalid',
        actorRoles: ['SYS_ADMIN'],
        requestId: 'request-run07-restore-0004',
      },
    }), (error) => error instanceof DatabaseRestoreError
      && error.code === 'restore_activation_failed'
      && error.restartRequired === true);
  } finally {
    fs.renameSync = realRenameSync;
  }

  try {
    assert.equal(activeDb.open, false);
    assert.equal(fs.existsSync(activePath), true);
    assert.equal(markerAt(activePath), 'ORIGINAL');
    assert.equal(markerAt(backupPath), 'ORIGINAL');
    assert.equal(fs.existsSync(stagedPath), false);
  } finally {
    if (activeDb.open) activeDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('restore rejects snapshots whose append-only trigger names hide no-op behavior', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-restore-trigger-'));
  const activePath = path.join(tempDir, 'active.db');
  const incomingPath = path.join(tempDir, 'incoming.db');
  const stagedPath = path.join(tempDir, 'staged.db');
  const backupPath = path.join(tempDir, 'backup.db');
  createMigratedDatabase(activePath, 'ORIGINAL');
  createMigratedDatabase(incomingPath, 'UNPROTECTED');
  const unprotected = new Database(incomingPath);
  unprotected.exec(`
    DROP TRIGGER audit_events_append_only_update;
    DROP TRIGGER audit_events_append_only_delete;
    CREATE TRIGGER audit_events_append_only_update
      BEFORE UPDATE ON audit_events BEGIN SELECT 1; END;
    CREATE TRIGGER audit_events_append_only_delete
      BEFORE DELETE ON audit_events BEGIN SELECT 1; END;
  `);
  unprotected.close();
  const activeDb = new Database(activePath);

  try {
    assert.throws(() => restoreDatabase({
      activeDb,
      activePath,
      incomingPath,
      stagedPath,
      backupPath,
      auditEvent: {
        actorUserId: 'restore-admin@example.invalid',
        actorRoles: ['SYS_ADMIN'],
        requestId: 'request-run07-restore-0005',
      },
    }), (error) => error instanceof DatabaseRestoreError
      && error.code === 'restore_audit_persistence_failed'
      && error.restartRequired === false);

    assert.equal(activeDb.open, true);
    assert.equal(activeDb.prepare('SELECT value FROM synthetic_restore_marker').pluck().get(), 'ORIGINAL');
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(stagedPath), false);
  } finally {
    if (activeDb.open) activeDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('restore fails before close when a reader keeps committed WAL frames busy', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-restore-wal-'));
  const activePath = path.join(tempDir, 'active.db');
  const incomingPath = path.join(tempDir, 'incoming.db');
  const stagedPath = path.join(tempDir, 'staged.db');
  const backupPath = path.join(tempDir, 'backup.db');
  createMigratedDatabase(activePath, 'ORIGINAL');
  createMigratedDatabase(incomingPath, 'RESTORED');
  const activeDb = new Database(activePath);
  activeDb.pragma('journal_mode = WAL');
  activeDb.pragma('busy_timeout = 50');
  const reader = new Database(activePath, { readonly: true, fileMustExist: true });
  reader.exec('BEGIN');
  assert.equal(reader.prepare('SELECT value FROM synthetic_restore_marker').pluck().get(), 'ORIGINAL');
  activeDb.prepare('UPDATE synthetic_restore_marker SET value = ?').run('ORIGINAL-LATEST');

  try {
    assert.throws(() => restoreDatabase({
      activeDb,
      activePath,
      incomingPath,
      stagedPath,
      backupPath,
      auditEvent: {
        actorUserId: 'restore-admin@example.invalid',
        actorRoles: ['SYS_ADMIN'],
        requestId: 'request-run07-restore-0006',
      },
    }), (error) => error instanceof DatabaseRestoreError
      && error.code === 'restore_activation_failed'
      && error.restartRequired === false);

    assert.equal(activeDb.open, true);
    assert.equal(activeDb.prepare('SELECT value FROM synthetic_restore_marker').pluck().get(), 'ORIGINAL-LATEST');
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(stagedPath), false);
  } finally {
    try { reader.exec('ROLLBACK'); } catch {}
    reader.close();
    if (activeDb.open) activeDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
