'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { getContext, runWithContext, updateContext } = require('../observability/context');
const { AuditEventService } = require('./AuditEventService');

class DatabaseRestoreError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'DatabaseRestoreError';
    this.code = code;
    this.status = 500;
    this.restartRequired = options.restartRequired === true;
  }
}

function removeDatabaseFile(filePath) {
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    try { fs.rmSync(candidate, { force: true }); } catch {}
  }
}

function assertRestorePaths({ activePath, incomingPath, stagedPath, backupPath }) {
  const rawPaths = [activePath, incomingPath, stagedPath, backupPath];
  if (rawPaths.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new DatabaseRestoreError('restore_path_invalid');
  }
  const paths = rawPaths.map((value) => path.resolve(value));
  if (new Set(paths).size !== paths.length) throw new DatabaseRestoreError('restore_path_invalid');
  if (!fs.existsSync(paths[0]) || !fs.existsSync(paths[1])) {
    throw new DatabaseRestoreError('restore_source_missing');
  }
  if (fs.existsSync(paths[2]) || fs.existsSync(paths[3])) {
    throw new DatabaseRestoreError('restore_target_exists');
  }
  return {
    activePath: paths[0],
    incomingPath: paths[1],
    stagedPath: paths[2],
    backupPath: paths[3],
  };
}

function checkpointComplete(db) {
  const result = db.pragma('wal_checkpoint(TRUNCATE)');
  const status = Array.isArray(result) ? result[0] : null;
  return status != null
    && Number(status.busy) === 0
    && Number(status.log) === Number(status.checkpointed);
}

function appendOnlyMutationBlocked(db, sql, eventId) {
  try {
    db.prepare(sql).run(eventId);
    return false;
  } catch (error) {
    return String(error?.message || '').includes('audit_events_append_only');
  }
}

function appendOnlyProtectionsWork(db, eventId) {
  const updateBlocked = appendOnlyMutationBlocked(
    db,
    'UPDATE audit_events SET summary = summary WHERE id = ?',
    eventId
  );
  const deleteBlocked = appendOnlyMutationBlocked(
    db,
    'DELETE FROM audit_events WHERE id = ?',
    eventId
  );
  return updateBlocked && deleteBlocked;
}

function stageAuditedSnapshot({ incomingPath, stagedPath, backupPath, auditEvent }) {
  let stagedDb;
  try {
    fs.copyFileSync(incomingPath, stagedPath, fs.constants.COPYFILE_EXCL);
    stagedDb = new Database(stagedPath);
    stagedDb.pragma('foreign_keys = ON');
    if (stagedDb.pragma('integrity_check', { simple: true }) !== 'ok'
      || stagedDb.pragma('foreign_key_check').length !== 0) {
      throw new Error('restore_integrity_check_failed');
    }
    const auditProtections = new Set(stagedDb.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'audit_events'`).all().map((row) => row.name));
    if (!auditProtections.has('audit_events_append_only_update')
      || !auditProtections.has('audit_events_append_only_delete')) {
      throw new Error('restore_audit_protection_missing');
    }

    const auditService = new AuditEventService(stagedDb);
    const requestContext = getContext();
    const recorded = runWithContext({}, () => auditService.record({
      eventName: 'config.restore.requested',
      actorUserId: auditEvent?.actorUserId || null,
      actorRoles: auditEvent?.actorRoles || [],
      requestId: auditEvent?.requestId || requestContext.request_id || null,
      correlationId: auditEvent?.correlationId || requestContext.correlation_id || null,
      uatRunId: auditEvent?.uatRunId || requestContext.uat_run_id || null,
      entityType: 'DATABASE_RESTORE',
      action: 'RESTORE',
      outcome: 'SUCCESS',
      summary: 'Validated database snapshot activated',
      metadata: {
        table_counts: auditEvent?.counts || {},
        backup_reference: path.basename(backupPath),
      },
    }));
    const verification = auditService.verifyChain();
    const persisted = stagedDb.prepare(`SELECT event_name, severity, outcome
      FROM audit_events WHERE id = ?`).get(recorded.id);
    if (!verification.valid
      || persisted?.event_name !== 'config.restore.requested'
      || persisted?.severity !== 'CRITICAL'
      || persisted?.outcome !== 'SUCCESS'
      || !appendOnlyProtectionsWork(stagedDb, recorded.id)) {
      throw new Error('restore_audit_chain_invalid');
    }
    if (!checkpointComplete(stagedDb)) throw new Error('restore_checkpoint_busy');
    stagedDb.close();
    stagedDb = null;
    return recorded;
  } catch {
    if (stagedDb?.open) {
      try { stagedDb.close(); } catch {}
    }
    removeDatabaseFile(stagedPath);
    throw new DatabaseRestoreError('restore_audit_persistence_failed');
  }
}

function restoreDatabase({
  activeDb,
  activePath,
  incomingPath,
  stagedPath,
  backupPath,
  auditEvent = {},
}) {
  const resolved = assertRestorePaths({ activePath, incomingPath, stagedPath, backupPath });
  if (!activeDb?.open || path.resolve(activeDb.name) !== resolved.activePath) {
    throw new DatabaseRestoreError('restore_active_database_mismatch');
  }

  const recorded = stageAuditedSnapshot({
    incomingPath: resolved.incomingPath,
    stagedPath: resolved.stagedPath,
    backupPath: resolved.backupPath,
    auditEvent,
  });
  let activeClosed = false;
  try {
    if (!checkpointComplete(activeDb)) throw new Error('restore_checkpoint_busy');
    activeDb.close();
    activeClosed = true;

    fs.copyFileSync(resolved.activePath, resolved.backupPath, fs.constants.COPYFILE_EXCL);
    for (const sidecar of [`${resolved.activePath}-wal`, `${resolved.activePath}-shm`]) {
      fs.rmSync(sidecar, { force: true });
    }
    // Both files are in the runtime database directory. Node's rename replaces
    // the destination atomically on supported local filesystems, so DB_PATH is
    // never deliberately removed before the staged snapshot is ready.
    fs.renameSync(resolved.stagedPath, resolved.activePath);
    updateContext({ audit_mutation_recorded: true, audit_event_id: recorded.id });
    return Object.freeze({ activated: true, auditEventId: recorded.id });
  } catch {
    if (!fs.existsSync(resolved.activePath) && fs.existsSync(resolved.backupPath)) {
      try {
        fs.copyFileSync(resolved.backupPath, resolved.activePath, fs.constants.COPYFILE_EXCL);
      } catch {}
    }
    removeDatabaseFile(resolved.stagedPath);
    throw new DatabaseRestoreError('restore_activation_failed', { restartRequired: activeClosed });
  }
}

module.exports = {
  DatabaseRestoreError,
  restoreDatabase,
};
