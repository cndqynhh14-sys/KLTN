'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { createLogger } = require('../server/logger');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { runWithContext } = require('../server/observability/context');
const {
  AUDIT_CATEGORIES,
  AUDIT_CATALOG_VERSION,
  EVENT_CATALOG,
} = require('../server/audit/eventCatalog');
const { AuditEventService } = require('../server/services/AuditEventService');
const { classifyMutation } = require('../server/middleware/audit');
const { auditMutations } = require('../server/middleware/audit');
const { requestContext } = require('../server/middleware/requestContext');
const { mapLegacyAccessAction } = require('../server/audit/compatibilityMap');
const { ACTION_FIELDS, NO_DETAIL_ACTIONS } = require('../server/observability/accessLog');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir, appVersion: 'run-07-test' });
  db.prepare(`INSERT INTO users (email, is_admin, role, is_active, created_by)
    VALUES ('run07.actor@example.test', 0, 'Chuyên viên', 1, 'test')`).run();
  const role = db.prepare("SELECT id FROM roles WHERE role_code = 'QLCL_SPECIALIST'").get();
  db.prepare(`INSERT INTO user_roles (user_id, role_id, source)
    VALUES ('run07.actor@example.test', ?, 'MANUAL')`).run(role.id);
  return db;
}

test('versioned audit catalog covers every required category and compatibility action', () => {
  assert.match(AUDIT_CATALOG_VERSION, /^\d+\.\d+\.\d+$/);
  const required = [
    'auth', 'authz', 'user', 'role', 'supplier', 'dossier', 'evaluation',
    'approval', 'question', 'report', 'scoring', 'import', 'export',
    'artifact', 'config', 'audit', 'uat',
  ];
  assert.deepEqual([...AUDIT_CATEGORIES].sort(), required.sort());
  for (const category of required) {
    assert.ok(Object.values(EVENT_CATALOG).some((event) => event.category === category), category);
  }
  for (const definition of Object.values(EVENT_CATALOG)) {
    assert.match(definition.name, /^[a-z][a-z0-9_.]+$/);
    assert.ok(['INFO', 'WARN', 'HIGH', 'CRITICAL'].includes(definition.severity));
    assert.ok(Array.isArray(definition.metadataFields));
    assert.ok(Array.isArray(definition.diffFields));
  }
});

test('migration creates an append-only audit table with required indexes and triggers', () => {
  const db = createDb();
  try {
    const columns = db.prepare("PRAGMA table_info('audit_events')").all().map((row) => row.name);
    for (const name of [
      'occurred_at', 'catalog_version', 'category', 'event_name', 'severity',
      'actor_user_id', 'actor_roles_json', 'request_id', 'correlation_id', 'uat_run_id',
      'entity_type', 'entity_id', 'action', 'outcome', 'reason_code', 'summary',
      'metadata_json', 'previous_hash', 'event_hash', 'idempotency_key',
    ]) assert.ok(columns.includes(name), name);
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_events'").all();
    assert.deepEqual(triggers.map((row) => row.name).sort(), [
      'audit_events_append_only_delete', 'audit_events_append_only_update',
    ]);
  } finally {
    db.close();
  }
});

test('record captures request context and allowlisted diff while recursively redacting secrets', () => {
  const db = createDb();
  const service = new AuditEventService(db, { clock: () => new Date('2026-07-13T10:00:00.000Z') });
  try {
    runWithContext({
      request_id: 'request-run07-0001',
      correlation_id: 'correlation-run07-0001',
      uat_run_id: 'uat-run07-0001',
    }, () => service.record({
      eventName: 'supplier.updated',
      actorUserId: 'run07.actor@example.test',
      entityType: 'SUPPLIER',
      entityId: 'NCC_SYNTHETIC_07',
      action: 'UPDATE',
      outcome: 'SUCCESS',
      summary: 'Synthetic supplier fields updated',
      metadata: {
        supplier_code: 'NCC_SYNTHETIC_07',
        source_type: 'MANUAL',
        password: 'fixture-password-must-not-appear',
        ignored_payload: 'must-not-be-persisted',
      },
      before: { supplier_name: 'Before', region: 'NORTH', token: 'fixture-token-must-not-appear' },
      after: { supplier_name: 'After', region: 'SOUTH', token: 'fixture-token-must-not-appear' },
    }));

    const row = db.prepare('SELECT * FROM audit_events').get();
    assert.equal(row.catalog_version, AUDIT_CATALOG_VERSION);
    assert.equal(row.request_id, 'request-run07-0001');
    assert.equal(row.correlation_id, 'correlation-run07-0001');
    assert.equal(row.uat_run_id, 'uat-run07-0001');
    assert.deepEqual(JSON.parse(row.actor_roles_json), ['QLCL_SPECIALIST']);
    const metadata = JSON.parse(row.metadata_json);
    assert.deepEqual(metadata.changed_fields, ['region', 'supplier_name']);
    assert.equal(metadata.changes.supplier_name.before, 'Before');
    assert.equal(metadata.changes.supplier_name.after, 'After');
    const serialized = JSON.stringify(row);
    assert.doesNotMatch(serialized, /fixture-password|fixture-token|ignored_payload/);
  } finally {
    db.close();
  }
});

test('idempotency, transaction rollback, append-only enforcement and hash verification hold', () => {
  const db = createDb();
  const service = new AuditEventService(db);
  const base = {
    eventName: 'supplier.updated',
    actorUserId: 'run07.actor@example.test',
    entityType: 'SUPPLIER',
    entityId: 'NCC_SYNTHETIC_07',
    action: 'UPDATE',
    outcome: 'SUCCESS',
    summary: 'Synthetic update',
    idempotencyKey: 'run07-idempotent-0001',
  };
  try {
    const first = service.record(base);
    const duplicate = service.record(base);
    assert.equal(first.deduplicated, false);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(first.id, duplicate.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);

    assert.throws(() => db.transaction(() => {
      service.record({ ...base, idempotencyKey: 'run07-rolled-back' });
      throw new Error('synthetic_business_failure');
    })(), /synthetic_business_failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);

    assert.throws(() => db.prepare("UPDATE audit_events SET summary = 'tampered'").run(), /audit_events_append_only/);
    assert.throws(() => db.prepare('DELETE FROM audit_events').run(), /audit_events_append_only/);
    assert.deepEqual(service.verifyChain(), { valid: true, checked: 1, failures: [] });

    db.exec('DROP TRIGGER audit_events_append_only_update');
    db.prepare("UPDATE audit_events SET summary = 'tampered'").run();
    const verification = service.verifyChain();
    assert.equal(verification.valid, false);
    assert.equal(verification.failures[0].id, first.id);
  } finally {
    db.close();
  }
});

test('synchronous concurrent submissions preserve a single verifiable hash chain', async () => {
  const db = createDb();
  const service = new AuditEventService(db);
  try {
    await Promise.all(Array.from({ length: 24 }, (_, index) => Promise.resolve().then(() => service.record({
      eventName: 'uat.request.observed',
      entityType: 'UAT_RUN',
      entityId: `RUN07_${index}`,
      action: 'OBSERVE',
      outcome: 'SUCCESS',
      summary: 'Synthetic UAT request observed',
      metadata: { scenario: 'run07-concurrency', status_code: 200 },
      idempotencyKey: `run07-concurrent-${index}`,
    }))));
    assert.equal(service.verifyChain().valid, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 24);
  } finally {
    db.close();
  }
});

test('mutation classifier covers P0 routes, auth failures and rate limits without request bodies', () => {
  const cases = [
    ['POST', '/qlcl/api/auth/request-otp', 200, 'auth.otp.request.succeeded'],
    ['POST', '/qlcl/api/auth/verify-otp', 401, 'auth.login.failed'],
    ['POST', '/qlcl/api/auth/verify-otp', 429, 'auth.login.rate_limited'],
    ['POST', '/qlcl/api/admin/users', 200, 'user.account.upserted'],
    ['PUT', '/qlcl/api/suppliers/:id', 200, 'supplier.updated'],
    ['POST', '/qlcl/api/evaluations', 201, 'evaluation.created'],
    ['PUT', '/qlcl/api/evaluations/:ticketId/rounds/:roundNo/answers', 200, 'scoring.answers.updated'],
    ['POST', '/qlcl/api/evaluations/:ticketId/lead-approve', 200, 'approval.decision.recorded'],
    ['POST', '/qlcl/api/question-templates', 201, 'question.template.changed'],
    ['POST', '/qlcl/api/question-templates/:templateId/versions/:versionId/imports/preview', 201, 'question.import.previewed'],
    ['POST', '/qlcl/api/question-templates/:templateId/versions/:versionId/imports/:batchId/commit', 200, 'question.import.committed'],
    ['POST', '/qlcl/api/question-templates/:templateId/versions/:versionId/imports/:batchId/rollback', 200, 'question.import.rolled_back'],
    ['POST', '/qlcl/api/report-templates', 201, 'report.template.changed'],
    ['GET', '/qlcl/api/report-exports/:id/download', 200, 'artifact.downloaded'],
  ];
  for (const [method, route, statusCode, expected] of cases) {
    const classified = classifyMutation({ method, route, statusCode });
    assert.equal(classified.eventName, expected, `${method} ${route}`);
    assert.ok(EVENT_CATALOG[classified.eventName]);
    assert.equal(Object.hasOwn(classified, 'body'), false);
  }
});

test('code-generated P0 route inventory has no unclassified mutation', () => {
  const mounts = {
    admin: '/qlcl/api/admin',
    auth: '/qlcl/api/auth',
    evaluations: '/qlcl/api/evaluations',
    questionTemplates: '/qlcl/api/question-templates',
    reportExports: '/qlcl/api/report-exports',
    reportTemplates: '/qlcl/api/report-templates',
    suppliers: '/qlcl/api/suppliers',
  };
  let mutationCount = 0;
  for (const [moduleName, mount] of Object.entries(mounts)) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', `${moduleName}.js`), 'utf8');
    const pattern = /router\.(post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
      mutationCount += 1;
      const method = match[1].toUpperCase();
      const route = `${mount}${match[2] === '/' ? '/' : match[2]}`;
      const classified = classifyMutation({ method, route, statusCode: 200 });
      assert.ok(classified, `${method} ${route}`);
      assert.notEqual(classified.eventName, 'audit.write.failed', `${method} ${route}`);
      assert.ok(EVENT_CATALOG[classified.eventName], `${method} ${route}`);
    }
  }
  assert.ok(mutationCount >= 30, `expected current evaluation-only P0 inventory, got ${mutationCount}`);
});

test('every legacy logAccess action maps to a catalog event without arbitrary details', () => {
  const actions = [...Object.keys(ACTION_FIELDS), ...NO_DETAIL_ACTIONS, 'ACKNOWLEDGE_RULES:v1'];
  for (const action of actions) {
    const mapped = mapLegacyAccessAction(action, {
      target: 'synthetic@example.test',
      supplier_code: 'NCC_SYNTHETIC_07',
      dossier_code: 'DOSSIER_SYNTHETIC_07',
      item_id: 7,
      upload_id: 7,
      password: 'must-not-map',
    });
    assert.ok(EVENT_CATALOG[mapped.eventName], action);
    assert.notEqual(mapped.eventName, 'audit.legacy_access.mapped', action);
    assert.doesNotMatch(JSON.stringify(mapped), /must-not-map/);
  }
});

test('HTTP middleware traces request to one actor-action-entity-outcome event and avoids service double-write', async () => {
  const db = createDb();
  const service = new AuditEventService(db);
  const app = express();
  app.use(requestContext({ logger: { info() {} } }));
  app.use(express.json());
  app.use(auditMutations(service));
  app.put('/qlcl/api/suppliers/:id', (req, res) => {
    req.user = { email: 'run07.actor@example.test', roleCodes: ['QLCL_SPECIALIST'] };
    service.record({
      eventName: 'supplier.updated',
      actorUserId: req.user.email,
      actorRoles: req.user.roleCodes,
      entityType: 'SUPPLIER',
      entityId: req.params.id,
      action: 'UPDATE',
      outcome: 'SUCCESS',
      summary: 'Synthetic service mutation',
      metadata: { supplier_code: req.params.id },
    });
    res.json({ ok: true });
  });
  app.put('/qlcl/api/report-templates/:id', (_req, res) => res.status(409).json({ error: 'template_exists' }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const success = await fetch(`${baseUrl}/qlcl/api/suppliers/NCC_SYNTHETIC_07`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-run07-http-0001' },
      body: JSON.stringify({ password: 'http-body-must-not-appear' }),
    });
    assert.equal(success.status, 200);
    const failure = await fetch(`${baseUrl}/qlcl/api/report-templates/7`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-run07-http-0002' },
      body: JSON.stringify({ template_body: 'http-body-must-not-appear' }),
    });
    assert.equal(failure.status, 409);
    await new Promise((resolve) => setImmediate(resolve));

    const rows = db.prepare('SELECT * FROM audit_events ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].request_id, 'request-run07-http-0001');
    assert.equal(rows[0].actor_user_id, 'run07.actor@example.test');
    assert.equal(rows[0].entity_id, 'NCC_SYNTHETIC_07');
    assert.equal(rows[0].action, 'UPDATE');
    assert.equal(rows[0].outcome, 'SUCCESS');
    assert.equal(rows[1].request_id, 'request-run07-http-0002');
    assert.equal(rows[1].event_name, 'report.template.changed');
    assert.equal(rows[1].outcome, 'FAILURE');
    assert.equal(rows[1].reason_code, 'template_exists');
    assert.doesNotMatch(JSON.stringify(rows), /http-body-must-not-appear|template_body/);
    assert.equal(service.verifyChain().valid, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('HTTP audit appends distinct events when separate mutations reuse a client request ID', async () => {
  const db = createDb();
  const service = new AuditEventService(db);
  const app = express();
  app.use(requestContext({ logger: { info() {} } }));
  app.use(express.json());
  app.use(auditMutations(service));
  app.put('/qlcl/api/suppliers/:id', (req, res) => {
    req.user = { email: 'run07.actor@example.test', roleCodes: ['QLCL_SPECIALIST'] };
    res.json({ ok: true });
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const requestId = 'request-run07-client-reused-0001';
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${baseUrl}/qlcl/api/suppliers/NCC_SYNTHETIC_07`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-request-id': requestId },
        body: JSON.stringify({ supplier_name: `Synthetic supplier ${attempt}` }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-request-id'), requestId);
    }

    const rows = db.prepare(`SELECT id, request_id, correlation_id, idempotency_key
      FROM audit_events ORDER BY id`).all();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
    assert.deepEqual(rows.map((row) => row.request_id), [requestId, requestId]);
    assert.deepEqual(rows.map((row) => row.correlation_id), [requestId, requestId]);
    assert.deepEqual(rows.map((row) => row.idempotency_key), [null, null]);
    assert.equal(service.verifyChain().valid, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('audit middleware fails closed before a successful mutation response when the audit write fails', async () => {
  const lines = [];
  const operationalLogger = createLogger({
    clock: () => new Date('2026-07-14T00:00:00.000Z'),
    writeLine: (line) => lines.push(line),
  });
  let recordAttempts = 0;
  const failingService = {
    record() {
      recordAttempts += 1;
      throw new Error('synthetic audit persistence failure token=SYNTHETIC-MUST-NOT-LEAK');
    },
  };
  const app = express();
  app.use(requestContext({ logger: { info() {} } }));
  app.use(auditMutations(failingService, { logger: operationalLogger }));
  app.put('/qlcl/api/suppliers/:id', (_req, res) => {
    res.status(200).json({ ok: true, marker: 'SUCCESS-BODY-MUST-NOT-BE-SENT' });
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/qlcl/api/suppliers/NCC_SYNTHETIC_07`, {
      method: 'PUT',
      headers: { 'x-request-id': 'request-run07-audit-failure-0001' },
    });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, {
      error: 'audit_write_failed',
      error_code: 'audit_write_failed',
      request_id: 'request-run07-audit-failure-0001',
    });
    assert.equal(JSON.stringify(body).includes('SUCCESS-BODY-MUST-NOT-BE-SENT'), false);
    assert.equal(recordAttempts, 1);

    const entries = lines.map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event_name, 'audit.event.write_failed');
    assert.equal(entries[0].level, 'error');
    assert.equal(entries[0].request_id, 'request-run07-audit-failure-0001');
    assert.equal(JSON.stringify(entries[0]).includes('SYNTHETIC-MUST-NOT-LEAK'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('audit middleware fails closed before the first streamed byte of a successful mutation', async () => {
  let recordAttempts = 0;
  const failingService = {
    record() {
      recordAttempts += 1;
      throw new Error('synthetic_stream_audit_failure');
    },
  };
  const app = express();
  app.use(requestContext({ logger: { info() {} } }));
  app.use(auditMutations(failingService, { logger: { error() {} } }));
  app.post('/qlcl/api/evaluations/:id/reports/export-pdf', (_req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="synthetic.pdf"');
    res.write('STREAMED-SUCCESS-BYTES-MUST-NOT-BE-SENT');
    res.end('STREAMED-SUCCESS-END-MUST-NOT-BE-SENT');
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/qlcl/api/evaluations/EVAL_SYNTHETIC_07/reports/export-pdf`, {
      method: 'POST',
      headers: { 'x-request-id': 'request-run07-audit-stream-0001' },
    });
    const responseText = await response.text();

    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(responseText), {
      error: 'audit_write_failed',
      error_code: 'audit_write_failed',
      request_id: 'request-run07-audit-stream-0001',
    });
    assert.equal(responseText.includes('STREAMED-SUCCESS'), false);
    assert.equal(response.headers.has('content-disposition'), false);
    assert.equal(recordAttempts, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
