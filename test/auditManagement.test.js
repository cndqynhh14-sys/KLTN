'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'synthetic-run08-route-test-secret';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { AuditEventService } = require('../server/services/AuditEventService');
const { AUDIT_CATEGORIES } = require('../server/audit/eventCatalog');
const { AuditEventRepository } = require('../server/repositories/AuditEventRepository');
const { AuditReadService, AuditReadError } = require('../server/services/AuditReadService');
const { AuthorizationService } = require('../server/services/AuthorizationService');
const { PolicyService, PolicyError } = require('../server/services/PolicyService');
const { PERMISSIONS, ROLE_CODES } = require('../server/authorization/permissionCatalog');
const { requestContext } = require('../server/middleware/requestContext');
const { createAuditEventsRouter } = require('../server/routes/auditEvents');
const navigation = require('../public/js/navigation-manifest');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const root = path.resolve(__dirname, '..');
const migrationsDir = path.join(root, 'migrations');

function addUser(db, email, roleCode, scopeType = 'GLOBAL') {
  upsertCanonicalUser(db, {
    email, roleCode, displayName: 'SYNTHETIC RUN-08 USER', createdBy: 'fixture',
  });
  const role = db.prepare('SELECT id FROM roles WHERE role_code = ?').get(roleCode);
  db.prepare(`INSERT INTO user_scope_assignments
    (user_id, role_id, scope_type, scope_value, effect, source)
    VALUES (?, ?, ?, ?, 'ALLOW', 'MANUAL')`
  ).run(email, role.id, scopeType, scopeType === 'GLOBAL' ? null : 'SELF');
}

function fixture(options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir, appVersion: 'run-08-test' });
  addUser(db, 'run08.auditor@example.test', ROLE_CODES.AUDITOR, 'GLOBAL');
  addUser(db, 'run08.scoped@example.test', ROLE_CODES.AUDITOR, 'OWN');
  addUser(db, 'run08.viewer@example.test', ROLE_CODES.READ_ONLY_VIEWER, 'GLOBAL');

  let now = new Date('2026-07-01T10:00:00.000Z');
  const auditEvents = new AuditEventService(db, { clock: () => now });
  const record = (event, occurredAt) => {
    now = new Date(occurredAt);
    return auditEvents.record(event).id;
  };
  const ids = [
    record({
      eventName: 'supplier.updated', actorUserId: 'run08.auditor@example.test',
      entityType: 'SUPPLIER', entityId: 'NCC_RUN08_A', action: 'UPDATE', outcome: 'SUCCESS',
      summary: '=RUN08(), cập nhật NCC synthetic', requestId: 'request-run08-0001',
      correlationId: 'correlation-run08-0001', uatRunId: 'uat-run08-0001',
      metadata: { supplier_code: 'NCC_RUN08_A', password: 'MUST-NOT-LEAK' },
    }, '2026-07-01T10:00:00.000Z'),
    record({
      eventName: 'authz.permission.denied', actorUserId: 'run08.viewer@example.test',
      entityType: 'PERMISSION', entityId: 'AUDIT.READ', action: 'READ', outcome: 'DENIED',
      reasonCode: 'forbidden_permission', summary: 'Từ chối truy cập',
      requestId: 'request-run08-0002', correlationId: 'correlation-run08-0002',
      metadata: { permission_code: 'AUDIT.READ', scope_type: 'GLOBAL', stack: 'MUST-NOT-LEAK' },
    }, '2026-07-01T11:00:00.000Z'),
    record({
      eventName: 'supplier.updated', actorUserId: 'run08.auditor@example.test',
      entityType: 'SUPPLIER', entityId: 'NCC_RUN08_B', action: 'UPDATE', outcome: 'SUCCESS',
      summary: 'Cập nhật NCC synthetic B', requestId: 'request-run08-target',
      correlationId: 'correlation-run08-target', uatRunId: 'uat-run08-target',
      metadata: { supplier_code: 'NCC_RUN08_B', source_type: 'MANUAL' },
    }, '2026-07-01T12:00:00.000Z'),
    record({
      eventName: 'uat.request.observed', actorUserId: 'run08.auditor@example.test',
      entityType: 'UAT_RUN', entityId: 'UAT_RUN08', action: 'OBSERVE', outcome: 'SUCCESS',
      summary: 'UAT synthetic', requestId: 'request-run08-0004',
      correlationId: 'correlation-run08-0004', uatRunId: 'uat-run08-0004',
      metadata: { scenario: 'system-logs', status_code: 200 },
    }, '2026-07-01T13:00:00.000Z'),
  ];
  now = new Date('2026-07-01T14:00:00.000Z');

  const repository = new AuditEventRepository(db);
  const readService = new AuditReadService(repository, {
    maxExportRows: options.maxExportRows || 50,
    maxExportRangeDays: 31,
  });
  const authorization = new AuthorizationService(db);
  const policy = new PolicyService(authorization, null);
  const users = Object.fromEntries([
    'run08.auditor@example.test', 'run08.scoped@example.test', 'run08.viewer@example.test',
  ].map((email) => [email, authorization.identityForLegacyRoutes(email)]));
  return { db, auditEvents, ids, policy, readService, repository, users };
}

function permissionGuard(policy) {
  return (permissionCode, options = {}) => (req, res, next) => {
    try {
      policy.assert(req.user, permissionCode, {
        context: options.context ? options.context(req) : null,
        requireGlobalScope: options.requireGlobalScope === true,
      });
      next();
    } catch (error) {
      const code = error instanceof PolicyError ? error.code : 'forbidden_permission';
      res.status(403).json({ error: code, request_id: req.requestId });
    }
  };
}

async function startApi(fx) {
  const app = express();
  app.use(requestContext({ logger: { info() {}, error() {} } }));
  const authenticate = (req, res, next) => {
    const email = String(req.get('x-test-user') || '').toLowerCase();
    if (!fx.users[email]) return res.status(401).json({ error: 'unauthorized' });
    req.user = fx.users[email];
    next();
  };
  app.use('/admin/audit-events', createAuditEventsRouter({
    auditReadService: fx.readService,
    auditEventService: fx.auditEvents,
    requireAuth: authenticate,
    requirePermission: permissionGuard(fx.policy),
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/admin/audit-events`,
  };
}

test('RUN-08 migration adds export permission and report-only retention policies', () => {
  const fx = fixture();
  try {
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM permissions WHERE permission_code = 'AUDIT.EXPORT'").get().n, 1);
    assert.equal(fx.db.prepare(`SELECT COUNT(*) AS n FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      WHERE rp.permission_code = 'AUDIT.EXPORT' AND rp.effect = 'ALLOW'
        AND r.role_code IN ('SYS_ADMIN', 'AUDITOR')`).get().n, 2);
    const policies = fx.db.prepare('SELECT * FROM audit_retention_policies ORDER BY retention_class').all();
    assert.ok(policies.length >= 3);
    assert.ok(policies.every((row) => row.purge_approved === 0 && row.approval_reference === 'OBS-01'));
    const configuredCategories = policies.flatMap((row) => JSON.parse(row.categories_json)).sort();
    assert.deepEqual(configuredCategories, [...AUDIT_CATEGORIES].sort());
  } finally {
    fx.db.close();
  }
});

test('cursor pagination is stable and every RUN-08 filter is parameterized', () => {
  const fx = fixture();
  try {
    const first = fx.readService.list({ limit: '2' });
    assert.deepEqual(first.items.map((item) => item.id), [fx.ids[3], fx.ids[2]]);
    assert.ok(first.next_cursor);
    const second = fx.readService.list({ limit: '2', cursor: first.next_cursor });
    assert.deepEqual(second.items.map((item) => item.id), [fx.ids[1], fx.ids[0]]);
    assert.equal(second.next_cursor, null);

    const filtered = fx.readService.list({
      from: '2026-07-01T11:30:00.000Z', to: '2026-07-01T12:30:00.000Z',
      category: 'supplier', event: 'supplier.updated', severity: 'INFO',
      actor: 'run08.auditor@example.test', entity: 'NCC_RUN08_B', outcome: 'success',
      request: 'request-run08-target', correlation: 'correlation-run08-target',
      uat: 'uat-run08-target',
    });
    assert.deepEqual(filtered.items.map((item) => item.id), [fx.ids[2]]);
    assert.throws(() => fx.readService.list({ cursor: 'not-a-cursor' }),
      (error) => error instanceof AuditReadError && error.code === 'audit_cursor_invalid');
  } finally {
    fx.db.close();
  }
});

test('CSV and NDJSON exports require a bounded time range, cap rows and redact metadata', () => {
  const fx = fixture({ maxExportRows: 3 });
  try {
    assert.throws(() => fx.readService.export({}, 'csv'),
      (error) => error.code === 'audit_export_time_range_required');
    assert.throws(() => fx.readService.export({
      from: '2026-01-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z',
    }, 'ndjson'), (error) => error.code === 'audit_export_time_range_too_large');
    assert.throws(() => fx.readService.export({
      from: '2026-07-01T09:00:00.000Z', to: '2026-07-01T14:00:00.000Z',
    }, 'csv'), (error) => error.code === 'audit_export_row_limit_exceeded');

    const query = {
      from: '2026-07-01T09:00:00.000Z', to: '2026-07-01T10:30:00.000Z',
    };
    const csv = fx.readService.export(query, 'csv');
    assert.equal(csv.row_count, 1);
    assert.match(csv.content_type, /text\/csv/);
    assert.match(csv.content, /"'=RUN08\(\), cập nhật NCC synthetic"/);
    assert.doesNotMatch(csv.content, /,"=RUN08/);
    assert.doesNotMatch(csv.content, /MUST-NOT-LEAK|password|stack/i);

    const ndjson = fx.readService.export(query, 'ndjson');
    assert.equal(ndjson.row_count, 1);
    const row = JSON.parse(ndjson.content.trim());
    assert.equal(row.id, fx.ids[0]);
    assert.equal(Object.hasOwn(row, 'event_hash'), false);
    assert.equal(Object.hasOwn(row, 'previous_hash'), false);
    assert.doesNotMatch(JSON.stringify(row), /MUST-NOT-LEAK|password|stack/i);
  } finally {
    fx.db.close();
  }
});

test('API denies missing/cross-scope permissions and self-audits list, detail and export access', async () => {
  const fx = fixture();
  const app = await startApi(fx);
  const headers = (email, requestId) => ({
    'x-test-user': email,
    'x-request-id': requestId,
  });
  try {
    const anonymousList = await fetch(app.baseUrl, { headers: { 'x-request-id': 'request-anonymous-list' } });
    assert.equal(anonymousList.status, 401);
    assert.equal(Object.hasOwn(await anonymousList.json(), 'items'), false);
    const anonymousExport = await fetch(`${app.baseUrl}/export?format=csv&from=2026-07-01T09:00:00.000Z&to=2026-07-01T10:00:00.000Z`, {
      headers: { 'x-request-id': 'request-anonymous-export' },
    });
    assert.equal(anonymousExport.status, 401);

    for (const email of ['run08.viewer@example.test', 'run08.scoped@example.test']) {
      const denied = await fetch(app.baseUrl, { headers: headers(email, `request-denied-${email.slice(6, 12)}`) });
      assert.equal(denied.status, 403);
      assert.equal(Object.hasOwn(await denied.json(), 'items'), false);
    }
    const deniedExport = await fetch(`${app.baseUrl}/export?format=csv&from=2026-07-01T09:00:00.000Z&to=2026-07-01T10:00:00.000Z`, {
      headers: headers('run08.viewer@example.test', 'request-denied-export'),
    });
    assert.equal(deniedExport.status, 403);

    const list = await fetch(`${app.baseUrl}?limit=2`, {
      headers: headers('run08.auditor@example.test', 'request-run08-list-access'),
    });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).items.length, 2);

    const detail = await fetch(`${app.baseUrl}/${fx.ids[0]}`, {
      headers: headers('run08.auditor@example.test', 'request-run08-detail-access'),
    });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).item.id, fx.ids[0]);

    const invalidExport = await fetch(`${app.baseUrl}/export?format=csv`, {
      headers: headers('run08.auditor@example.test', 'request-run08-export-failure'),
    });
    assert.equal(invalidExport.status, 400);
    assert.equal((await invalidExport.json()).error, 'audit_export_time_range_required');

    const exportResponse = await fetch(`${app.baseUrl}/export?format=ndjson&from=2026-07-01T09:00:00.000Z&to=2026-07-01T14:30:00.000Z`, {
      headers: headers('run08.auditor@example.test', 'request-run08-export-access'),
    });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('content-type'), /application\/x-ndjson/);
    assert.doesNotMatch(await exportResponse.text(), /MUST-NOT-LEAK|password|stack/i);

    const accessRows = fx.db.prepare(`SELECT event_name, action, outcome, request_id, entity_id
      FROM audit_events WHERE event_name IN ('audit.read', 'audit.export') ORDER BY id`).all();
    assert.deepEqual(accessRows.map((row) => [row.event_name, row.action, row.outcome, row.request_id]), [
      ['audit.read', 'LIST', 'DENIED', 'request-anonymous-list'],
      ['audit.export', 'EXPORT_CSV', 'DENIED', 'request-anonymous-export'],
      ['audit.read', 'LIST', 'DENIED', 'request-denied-viewer'],
      ['audit.read', 'LIST', 'DENIED', 'request-denied-scoped'],
      ['audit.export', 'EXPORT_CSV', 'DENIED', 'request-denied-export'],
      ['audit.read', 'LIST', 'SUCCESS', 'request-run08-list-access'],
      ['audit.read', 'DETAIL', 'SUCCESS', 'request-run08-detail-access'],
      ['audit.export', 'EXPORT_CSV', 'FAILURE', 'request-run08-export-failure'],
      ['audit.export', 'EXPORT_NDJSON', 'SUCCESS', 'request-run08-export-access'],
    ]);
    assert.equal(accessRows[6].entity_id, String(fx.ids[0]));

    const nextList = fx.readService.list({ event: 'audit.read' });
    assert.ok(nextList.items.some((item) => item.request_id === 'request-run08-list-access'));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fx.db.close();
  }
});

test('retention dry-run reports classes but cannot hard-delete before OBS-01 approval', () => {
  const fx = fixture();
  try {
    const before = fx.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
    const report = fx.readService.retentionDryRun({ as_of: '2036-07-01T00:00:00.000Z' });
    const after = fx.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.purge_allowed, false);
    assert.equal(report.approval_reference, 'OBS-01');
    assert.ok(report.classes.every((item) => item.action === 'REPORT_ONLY'));
    assert.equal(typeof fx.readService.purge, 'undefined');
    assert.equal(after, before);
    assert.throws(() => fx.db.prepare('DELETE FROM audit_events').run(), /audit_events_append_only/);
  } finally {
    fx.db.close();
  }
});

test('system log UI has permission states, filters, accessible detail timeline and responsive controls', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const systemLogs = navigation.NAVIGATION_MANIFEST.find((item) => item.id === 'admin-system-logs');
  assert.equal(systemLogs.route, '/admin/system-logs');
  assert.deepEqual(systemLogs.permissions, ['AUDIT.READ']);
  assert.doesNotMatch(html, /id="admin-module-nav"/);
  assert.match(app, /id:\s*'admin-module-nav'[\s\S]{0,160}'data-navigation-surface':\s*'admin'/);
  assert.match(app, /button\.dataset\.adminRoute = item\.id/);
  assert.match(html, /id="system-log-filter-form"[\s\S]*id="system-log-from"[\s\S]*id="system-log-category"[\s\S]*id="system-log-uat"/);
  assert.match(html, /id="system-log-loading"[\s\S]*id="system-log-empty"[\s\S]*id="system-log-error"[\s\S]*id="system-log-permission"/);
  assert.match(html, /id="system-log-drawer"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="system-log-timeline"/);
  assert.doesNotMatch(html, /id="system-log-(?:drawer|timeline)"[\s\S]{0,1200}<pre/i);
  assert.match(app, /AUDIT\.READ/);
  assert.match(app, /AUDIT\.EXPORT/);
  assert.match(app, /navigator\.clipboard/);
  assert.match(app, /e\.key\s*===\s*'Escape'/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.system-log-filter-grid[\s\S]*grid-template-columns:\s*1fr/);
});
