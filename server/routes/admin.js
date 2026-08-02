const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const Database = require('better-sqlite3');
const { db, stmts, logAccess, authorizationService } = require('../db');
const { DB_PATH } = require('../config/paths');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/policy');
const { PERMISSIONS, ROLE_CODES, LEGACY_ROLE_TO_CODE } = require('../authorization/permissionCatalog');
const { ROLES, ROLE_VALUES, normalizeRole } = require('../domain/roles');
const { restoreDatabase } = require('../services/DatabaseRestoreService');
const { sanitizeString } = require('../observability/redact');
const logger = require('../logger');

const router = express.Router();
const getUserAuditRow = db.prepare(`SELECT email, is_active, display_name, authz_version
  FROM users WHERE email = ?`);
const getPrimaryRoleCode = db.prepare(`SELECT r.role_code
  FROM user_roles ur JOIN roles r ON r.id = ur.role_id
  WHERE ur.user_id = ? AND ur.active = 1 AND r.active = 1
    AND r.role_code IN (
      'SYS_ADMIN', 'BLOCK_DIRECTOR_APPROVER', 'DEPARTMENT_HEAD_APPROVER',
      'REGIONAL_LEAD_APPROVER', 'SUPPLIER_USER', 'QLCL_SPECIALIST'
    )
    AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
    AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))
  ORDER BY CASE r.role_code
    WHEN 'SYS_ADMIN' THEN 1 WHEN 'BLOCK_DIRECTOR_APPROVER' THEN 2
    WHEN 'DEPARTMENT_HEAD_APPROVER' THEN 3 WHEN 'REGIONAL_LEAD_APPROVER' THEN 4
    WHEN 'SUPPLIER_USER' THEN 5 WHEN 'QLCL_SPECIALIST' THEN 6 ELSE 99 END
  LIMIT 1`);
const restoreUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAINTENANCE_MAX_DB_MB || '64', 10) * 1024 * 1024 },
});

function safeEqualString(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeChangeReason(value) {
  const raw = String(value || '').trim();
  if (raw.length < 8 || raw.length > 500) return null;
  return sanitizeString(raw, 500);
}

function userAuditSnapshot(row) {
  if (!row) return null;
  const roleCode = getPrimaryRoleCode.get(row.email)?.role_code || null;
  return {
    active: Boolean(row.is_active),
    display_name: row.display_name || null,
    role_code: roleCode,
  };
}

function requireRestoreToken(req, res, next) {
  const expected = process.env.MAINTENANCE_RESTORE_TOKEN;
  if (!expected) return res.status(404).json({ error: 'not_found' });
  if (!safeEqualString(req.get('x-maintenance-token'), expected)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function validateSqliteSnapshot(filePath) {
  const probe = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = probe.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      const err = new Error('invalid_sqlite_snapshot');
      err.status = 400;
      err.details = integrity;
      throw err;
    }

    const tables = [
      'users',
      'supplier_master',
      'evaluation_tickets',
      'evaluation_rounds',
      'evaluation_answers',
      'report_exports',
      'schema_migrations',
    ];
    const counts = {};
    for (const table of tables) {
      try {
        counts[table] = probe.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      } catch {
        counts[table] = null;
      }
    }
    return counts;
  } finally {
    probe.close();
  }
}

// Guard all admin routes centrally.
router.use(requireAuth, requirePermission(PERMISSIONS.USER_MANAGE));

// GET /admin/users — list allow-list.
router.get('/users', (req, res) => {
  res.json({ items: stmts.listUsers.all() });
});

// POST /admin/users — add or promote an email. Idempotent upsert.
router.post('/users', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = normalizeRole(req.body?.role, req.body?.is_admin ? ROLES.ADMIN : ROLES.SPECIALIST);
  const is_admin = role === ROLES.ADMIN;
  const roleCode = LEGACY_ROLE_TO_CODE[role];
  const display_name = String(req.body?.display_name || '').trim() || null;
  const reason = normalizeChangeReason(req.body?.reason);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  // Chặn self-demote — admin xóa quyền mình sẽ khóa hệ thống ngoài allow-list env.
  if (email === req.user.email && role !== ROLES.ADMIN) {
    return res.status(400).json({ error: 'cannot_self_demote' });
  }
  if (!ROLE_VALUES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
  if (!reason) return res.status(400).json({ error: 'change_reason_required' });

  const before = userAuditSnapshot(getUserAuditRow.get(email));
  let identity;
  try {
    stmts.upsertUser.run({ email, display_name, created_by: req.user.email });
    identity = authorizationService.setPrimaryRole({
      userId: email,
      roleCode,
      actor: req.user.email,
      requestId: req.requestId,
      correlationId: req.correlationId,
    });
  } catch (error) {
    if (String(error.message).includes('last_super_admin_required')) {
      return res.status(409).json({ error: 'last_super_admin_required', code: 'AUTHZ_LAST_ADMIN_REQUIRED', request_id: req.requestId });
    }
    throw error;
  }
  const stored = getUserAuditRow.get(email);
  const after = userAuditSnapshot(stored);
  logAccess({
    email: req.user.email,
    action: 'USER_UPSERT',
    details: {
      target: email,
      role,
      role_code: after.role_code,
      is_admin,
      reason,
      authz_version: Number(identity?.authzVersion || stored.authz_version),
      before,
      after,
    },
    ip: req.ip,
  });
  res.json({ ok: true, email, role: identity.role, is_admin: identity.isAdmin, authz_version: Number(stored.authz_version) });
});

// DELETE /admin/users/:email — deactivate (soft delete). Users giữ lại trong access_log.
router.delete('/users/:email', (req, res) => {
  const email = String(req.params.email || '').toLowerCase();
  if (email === req.user.email) {
    return res.status(400).json({ error: 'cannot_deactivate_self' });
  }
  const reason = normalizeChangeReason(req.body?.reason);
  if (!reason) return res.status(400).json({ error: 'change_reason_required' });
  const beforeRow = getUserAuditRow.get(email);
  const before = userAuditSnapshot(beforeRow);
  let info;
  try {
    info = stmts.deactivateUser.run(email);
  } catch (error) {
    if (String(error.message).includes('last_super_admin_required')) {
      return res.status(409).json({ error: 'last_super_admin_required', code: 'AUTHZ_LAST_ADMIN_REQUIRED', request_id: req.requestId });
    }
    throw error;
  }
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  const stored = getUserAuditRow.get(email);
  logAccess({
    email: req.user.email,
    action: 'USER_DEACTIVATE',
    details: {
      target: email,
      reason,
      authz_version: Number(stored.authz_version),
      before,
      after: userAuditSnapshot(stored),
    },
    ip: req.ip,
  });
  res.json({ ok: true, authz_version: Number(stored.authz_version) });
});

router.get('/export-db', requirePermission(PERMISSIONS.SYSTEM_ADMIN), requireRestoreToken, async (req, res) => {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-db-export-'));
  const snapshotPath = path.join(tempDir, 'qlcl-' + stamp + '.db');

  try {
    await db.backup(snapshotPath);
    const counts = validateSqliteSnapshot(snapshotPath);
    logAccess({
      email: req.user.email,
      action: 'DB_EXPORT_REQUEST',
      details: { counts },
      ip: req.ip,
      ua: req.get('user-agent'),
    });
    res.download(snapshotPath, 'qlcl-' + stamp + '.db', (err) => {
      if (err) logger.error('[admin] export-db download failed:', err.message);
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    });
  } catch (e) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    logger.error('[admin] export-db failed:', e.message);
    res.status(500).json({ error: 'export_failed' });
  }
});

router.post('/restore-db', requirePermission(PERMISSIONS.SYSTEM_ADMIN), requireRestoreToken, restoreUpload.single('db'), (req, res) => {
  if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: 'db_file_required' });

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-db-restore-'));
  const incomingPath = path.join(tempDir, 'incoming.db');
  const stagedPath = DB_PATH + '.restore-' + stamp;
  const backupPath = DB_PATH + '.backup-' + stamp;

  try {
    fs.writeFileSync(incomingPath, req.file.buffer);
    const counts = validateSqliteSnapshot(incomingPath);
    restoreDatabase({
      activeDb: db,
      activePath: DB_PATH,
      incomingPath,
      stagedPath,
      backupPath,
      auditEvent: {
        actorUserId: req.user.email,
        actorRoles: req.user.roleCodes || [],
        requestId: req.requestId,
        correlationId: req.correlationId,
        uatRunId: req.uatRunId,
        counts,
      },
    });

    res.json({ ok: true, restored: true, counts, backup: path.basename(backupPath), restart: 'scheduled' });
    setTimeout(() => process.exit(1), 250);
  } catch (e) {
    try { fs.rmSync(stagedPath, { force: true }); } catch {}
    logger.error('[admin] restore-db failed:', e.code || e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'restore_failed' });
    if (e.restartRequired) setTimeout(() => process.exit(1), 250);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

module.exports = router;
