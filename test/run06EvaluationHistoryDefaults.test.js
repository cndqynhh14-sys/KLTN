const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

function freshModules(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'run06-test-secret';
  for (const modulePath of [
    '../server/db',
    '../server/middleware/auth',
    '../server/routes/evaluations',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  const evaluationsRouter = require('../server/routes/evaluations');
  return { ...dbModule, ...auth, signToken: canonicalTokenFactory(dbModule, auth), evaluationsRouter };
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/evaluations', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('RUN-06 supports only periodic and ad-hoc evaluation types', () => {
  const { supportsPreviousEvaluationDefaults } = require('../server/domain/evaluationHistoryDefaults');
  assert.equal(supportsPreviousEvaluationDefaults('\u0110\u00e1nh gi\u00e1 \u0111\u1ecbnh k\u1ef3'), true);
  assert.equal(supportsPreviousEvaluationDefaults('\u0110\u00e1nh gi\u00e1 \u0111\u1ed9t xu\u1ea5t'), true);
  assert.equal(supportsPreviousEvaluationDefaults('Dinh ky'), true);
  assert.equal(supportsPreviousEvaluationDefaults('Dot xuat'), true);
  assert.equal(supportsPreviousEvaluationDefaults('\u0110\u00e1nh gi\u00e1 NCC m\u1edbi'), false);
  assert.equal(supportsPreviousEvaluationDefaults(''), false);
});

test('RUN-06 returns deterministic, scoped and partial defaults from prior valid evaluations', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run06-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'owner@masangroup.com', role: 'Chuy\u00ean vi\u00ean', isAdmin: false });
    upsertCanonicalUser(db, { email: 'other@masangroup.com', role: 'Chuy\u00ean vi\u00ean', isAdmin: false });
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });

    const supplier = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-RUN06-A', 'RUN-06 Supplier A', 'ACTIVE', 'MANUAL')
    `).run().lastInsertRowid;
    const partialSupplier = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-RUN06-B', 'RUN-06 Supplier B', 'ACTIVE', 'MANUAL')
    `).run().lastInsertRowid;
    const noHistorySupplier = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-RUN06-C', 'RUN-06 Supplier C', 'ACTIVE', 'MANUAL')
    `).run().lastInsertRowid;

    const templateIds = Object.fromEntries(db.prepare(`
      SELECT id, template_code FROM question_templates WHERE template_code IN ('BM01', 'BM02', 'BM03', 'BM04')
    `).all().map((row) => [row.template_code, row.id]));
    const insertTicket = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, actual_evaluation_date, current_status,
        current_round_no, assigned_specialist_id, created_by
      ) VALUES (
        @ticket_code, @supplier_id, @supplier_code, @supplier_name, 'Dinh ky', @template_id,
        @facility_type, @supplier_scale, @planned_date, @actual_evaluation_date, 'Ho\u00e0n th\u00e0nh',
        1, @created_by, @created_by
      )
    `);
    const addTicket = (values) => insertTicket.run({
      supplier_id: supplier,
      supplier_code: 'NCC-RUN06-A',
      supplier_name: 'RUN-06 Supplier A',
      planned_date: values.actual_evaluation_date || '2026-01-01',
      facility_type: '',
      supplier_scale: 'LARGE',
      ...values,
      template_id: templateIds[values.template_code],
      created_by: db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(values.created_by),
    }).lastInsertRowid;

    addTicket({
      ticket_code: 'RUN06-OWNER-OLD', template_code: 'BM01',
      facility_type: 'CO_SO_TRONG_TROT', supplier_scale: 'LARGE',
      actual_evaluation_date: '2026-05-01', created_by: 'owner@masangroup.com',
    });
    addTicket({
      ticket_code: 'RUN06-OWNER-SAME-DATE-LOW-ID', template_code: 'BM02',
      facility_type: 'GIET_MO_SO_CHE', supplier_scale: 'LARGE',
      actual_evaluation_date: '2026-06-01', created_by: 'owner@masangroup.com',
    });
    const expectedOwnerTicketId = addTicket({
      ticket_code: 'RUN06-OWNER-SAME-DATE-HIGH-ID', template_code: 'BM03',
      facility_type: 'CO_SO_NUOI_TRONG', supplier_scale: 'SMALL',
      actual_evaluation_date: '2026-06-01', created_by: 'owner@masangroup.com',
    });
    const expectedAdminTicketId = addTicket({
      ticket_code: 'RUN06-OTHER-NEWEST', template_code: 'BM04',
      facility_type: 'CHUNG', supplier_scale: 'LARGE',
      actual_evaluation_date: '2026-07-01', created_by: 'other@masangroup.com',
    });

    const partialTicketId = addTicket({
      ticket_code: 'RUN06-PARTIAL', supplier_id: partialSupplier,
      supplier_code: 'NCC-RUN06-B', supplier_name: 'RUN-06 Supplier B',
      template_code: 'BM01', facility_type: '', supplier_scale: 'SMALL',
      actual_evaluation_date: '2026-04-01', created_by: 'owner@masangroup.com',
    });
    addTicket({
      ticket_code: 'RUN06-PLANNED-ONLY', supplier_id: noHistorySupplier,
      supplier_code: 'NCC-RUN06-C', supplier_name: 'RUN-06 Supplier C',
      template_code: 'BM02', facility_type: 'CO_SO_PHA_LOC', supplier_scale: 'SMALL',
      actual_evaluation_date: null, planned_date: '2026-08-01', created_by: 'owner@masangroup.com',
    });

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const ownerToken = signToken({ email: 'owner@masangroup.com', role: 'Chuy\u00ean vi\u00ean' }, 3600);
    const adminToken = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const getDefaults = async (token, supplierId, evaluationType = '\u0110\u00e1nh gi\u00e1 \u0111\u1ecbnh k\u1ef3') => {
      const params = new URLSearchParams({ supplier_id: String(supplierId), evaluation_type: evaluationType });
      const response = await fetch(`${appInfo.baseUrl}/evaluations/previous-defaults?${params}`, {
        headers: { Cookie: `qlcl_token=${token}` },
      });
      const json = await response.json();
      assert.equal(response.status, 200, JSON.stringify(json));
      return json.item;
    };

    assert.deepEqual(await getDefaults(ownerToken, supplier), {
      template_code: 'BM03',
      facility_type: 'CO_SO_NUOI_TRONG',
      supplier_scale: 'SMALL',
      source_ticket_id: expectedOwnerTicketId,
      source_ticket_code: 'RUN06-OWNER-SAME-DATE-HIGH-ID',
      evaluation_date: '2026-06-01',
    });
    assert.deepEqual(await getDefaults(adminToken, supplier, '\u0110\u00e1nh gi\u00e1 \u0111\u1ed9t xu\u1ea5t'), {
      template_code: 'BM04',
      facility_type: 'CHUNG',
      supplier_scale: 'LARGE',
      source_ticket_id: expectedAdminTicketId,
      source_ticket_code: 'RUN06-OTHER-NEWEST',
      evaluation_date: '2026-07-01',
    });
    assert.deepEqual(await getDefaults(ownerToken, partialSupplier), {
      template_code: 'BM01',
      facility_type: null,
      supplier_scale: 'SMALL',
      source_ticket_id: partialTicketId,
      source_ticket_code: 'RUN06-PARTIAL',
      evaluation_date: '2026-04-01',
    });
    assert.equal(await getDefaults(ownerToken, noHistorySupplier), null);
    assert.equal(await getDefaults(ownerToken, supplier, '\u0110\u00e1nh gi\u00e1 NCC m\u1edbi'), null);
    assert.equal(await getDefaults(ownerToken, 999999), null);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    for (const modulePath of ['../server/db', '../server/middleware/auth', '../server/routes/evaluations']) {
      delete require.cache[require.resolve(modulePath)];
    }
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    fs.rmSync(dbPath, { force: true });
  }
});

test('RUN-06 UI guards manual edits and stale supplier responses', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const stateSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'state.js'), 'utf8');
  assert.match(stateSource, /evaluationHistoryDefaults/);
  assert.match(appSource, /loadPreviousEvaluationDefaults/);
  assert.match(appSource, /fieldSources\[fieldName\] === 'manual'/);
  assert.match(appSource, /requestId !== state\.evaluationHistoryDefaults\.requestId/);
  assert.match(appSource, /supplierId !== Number\(state\.selectedSupplierId\)/);
  assert.match(appSource, /markEvaluationHistoryFieldManual/);
});
