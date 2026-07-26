const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const DB_MODULES = [
  '../server/db',
  '../server/middleware/auth',
];

function clearModules(routeModule) {
  [...DB_MODULES, routeModule].forEach((modulePath) => {
    delete require.cache[require.resolve(modulePath)];
  });
}

function startApp(router, mountPath) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(mountPath, router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function removeDbFiles(dbPath) {
  [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function tokenForExistingSession(authorizationService, email) {
  const session = authorizationService.createSession(email, { ttlSeconds: 3600 });
  return jwt.sign({ sub: email, sid: session.sessionId, av: session.authzVersion }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: 3600,
    issuer: 'masan-rms',
    audience: process.env.JWT_AUDIENCE || 'qlcl-app',
  });
}

async function withRouteFixture(prefix, routeModule, mountPath, run) {
  const dbPath = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'policy-scope-route-test-secret';
  clearModules(routeModule);
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  const router = require(routeModule);
  const appInfo = await startApp(router, mountPath);

  try {
    await run({ ...dbModule, ...auth, ...appInfo });
  } finally {
    await new Promise((resolve) => appInfo.server.close(resolve));
    dbModule.db.close();
    clearModules(routeModule);
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    removeDbFiles(dbPath);
  }
}

test('generic evaluation PATCH requires the active assignment for each approval stage transition', async () => {
  await withRouteFixture(
    'qlcl-evaluation-patch-assignment',
    '../server/routes/evaluations',
    '/evaluations',
    async ({ db, signToken, baseUrl }) => {
      const { ROLES } = require('../server/domain/roles');
      const { WORKFLOW_STATUSES } = require('../server/domain/workflowHistory');
      const users = [
        ['lead-stage@example.invalid', ROLES.LEAD],
        ['tbp-stage@example.invalid', ROLES.TBP],
        ['gdk-stage@example.invalid', ROLES.GDK],
      ];
      const insertUser = db.prepare(`
        INSERT INTO users (email, is_admin, role, is_active)
        VALUES (?, 0, ?, 1)
        ON CONFLICT(email) DO UPDATE SET role=excluded.role, is_admin=0, is_active=1
      `);
      users.forEach((row) => insertUser.run(...row));

      const supplier = db.prepare(`
        INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
        VALUES ('NCC-PATCH-STAGE', 'Patch Stage Supplier', 'ACTIVE', 'MANUAL')
      `).run();
      const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04' ORDER BY id LIMIT 1").get();
      assert.ok(template?.id, 'BM04 template fixture must exist');
      const insertTicket = db.prepare(`
        INSERT INTO evaluation_tickets (
          ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
          facility_type, supplier_scale, planned_date, current_status, current_round_no, created_by
        ) VALUES (
          @ticket_code, @supplier_id, 'NCC-PATCH-STAGE', 'Patch Stage Supplier', 'Dinh ky', @template_id,
          'CHUNG', 'LARGE', '2026-07-14', @current_status, 1, @created_by
        )
      `);
      const cases = [
        {
          ticketCode: 'PATCH-STAGE-LEAD',
          email: users[0][0],
          role: users[0][1],
          stage: 'LEAD',
          from: WORKFLOW_STATUSES.WAITING_LEAD,
          to: WORKFLOW_STATUSES.WAITING_TBP,
        },
        {
          ticketCode: 'PATCH-STAGE-TBP',
          email: users[1][0],
          role: users[1][1],
          stage: 'TBP',
          from: WORKFLOW_STATUSES.WAITING_TBP,
          to: WORKFLOW_STATUSES.WAITING_GDK,
        },
        {
          ticketCode: 'PATCH-STAGE-GDK',
          email: users[2][0],
          role: users[2][1],
          stage: 'GDK',
          from: WORKFLOW_STATUSES.WAITING_GDK,
          to: WORKFLOW_STATUSES.COMPLETED,
        },
      ];
      cases.forEach((item) => insertTicket.run({
        ticket_code: item.ticketCode,
        supplier_id: supplier.lastInsertRowid,
        template_id: template.id,
        current_status: item.from,
        created_by: item.email,
      }));

      const tokens = new Map(cases.map((item) => [
        item.email,
        signToken({ email: item.email, isAdmin: false, role: item.role }, 3600),
      ]));
      const disabled = db.prepare(`
        UPDATE approval_stage_assignments
        SET active = 0
        WHERE workflow_type = 'EVALUATION' AND stage_code IN ('LEAD', 'TBP', 'GDK')
      `).run();
      assert.equal(disabled.changes, 3);

      const observed = [];
      for (const item of cases) {
        const response = await fetch(`${baseUrl}/evaluations/${item.ticketCode}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `qlcl_token=${tokens.get(item.email)}`,
          },
          body: JSON.stringify({ workflow_status: item.to }),
        });
        observed.push({
          stage: item.stage,
          status: response.status,
          body: await response.json(),
          storedStatus: db.prepare('SELECT current_status FROM evaluation_tickets WHERE ticket_code = ?')
            .get(item.ticketCode).current_status,
        });
      }

      assert.deepEqual(
        observed.map(({ stage, status, body, storedStatus }) => ({
          stage,
          status,
          error: body.error,
          storedStatus,
        })),
        cases.map((item) => ({
          stage: item.stage,
          status: 403,
          error: 'approval_assignment_missing',
          storedStatus: item.from,
        }))
      );

      db.prepare(`
        UPDATE approval_stage_assignments
        SET active = 1
        WHERE workflow_type = 'EVALUATION' AND stage_code IN ('LEAD', 'TBP', 'GDK')
      `).run();
      const allowed = [];
      for (const item of cases) {
        const response = await fetch(`${baseUrl}/evaluations/${item.ticketCode}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `qlcl_token=${tokens.get(item.email)}`,
          },
          body: JSON.stringify({ workflow_status: item.to }),
        });
        allowed.push({
          stage: item.stage,
          status: response.status,
          storedStatus: db.prepare('SELECT current_status FROM evaluation_tickets WHERE ticket_code = ?')
            .get(item.ticketCode).current_status,
        });
      }
      assert.deepEqual(allowed, cases.map((item) => ({
        stage: item.stage,
        status: 200,
        storedStatus: item.to,
      })));
    }
  );
});

test('RUN-18 specialist reads the full supplier master while supplier writes remain scoped', async () => {
  await withRouteFixture(
    'qlcl-supplier-shared-scope',
    '../server/routes/suppliers',
    '/suppliers',
    async ({ db, signToken, baseUrl }) => {
      const { ROLES } = require('../server/domain/roles');
      const { MCH2_VALUES, MCH3_BY_MCH2 } = require('../server/domain/merchandising');
      const { BUSINESS_TYPE_OPTIONS, PROVINCES_BY_REGION } = require('../server/domain/masterData');
      db.prepare(`
        INSERT INTO users (email, is_admin, role, is_active)
        VALUES
          ('supplier-owner@example.invalid', 0, @specialist, 1),
          ('supplier-other@example.invalid', 0, @specialist, 1)
        ON CONFLICT(email) DO UPDATE SET role=excluded.role, is_admin=0, is_active=1
      `).run({ specialist: ROLES.SPECIALIST });
      const token = signToken({
        email: 'supplier-owner@example.invalid',
        isAdmin: false,
        role: ROLES.SPECIALIST,
      }, 3600);
      const insertSupplier = db.prepare(`
        INSERT INTO supplier_master (
          supplier_code, supplier_name, region, province, business_type, mch2, mch3,
          status, source_type, created_by, created_at
        ) VALUES (
          @supplier_code, @supplier_name, @region, @province, @business_type, @mch2, @mch3,
          'ACTIVE', 'MANUAL', @created_by, @created_at
        )
      `);
      const mch2 = MCH2_VALUES[0];
      const mch3 = MCH3_BY_MCH2[mch2][0];
      insertSupplier.run({
        supplier_code: 'SCOPE-SUPPLIER-OWN',
        supplier_name: 'Z Own Supplier',
        region: 'MB',
        province: PROVINCES_BY_REGION.MB[0],
        business_type: BUSINESS_TYPE_OPTIONS[0],
        mch2,
        mch3,
        created_by: 'supplier-owner@example.invalid',
        created_at: '2026-07-14 08:00:00',
      });
      insertSupplier.run({
        supplier_code: 'SCOPE-SUPPLIER-OTHER',
        supplier_name: 'A Other Supplier',
        region: 'MN',
        province: PROVINCES_BY_REGION.MN[0],
        business_type: BUSINESS_TYPE_OPTIONS[0],
        mch2,
        mch3,
        created_by: 'supplier-other@example.invalid',
        created_at: '2026-07-14 09:00:00',
      });

      const listResponse = await fetch(`${baseUrl}/suppliers?q=SCOPE-SUPPLIER&page_size=10`, {
        headers: { Cookie: `qlcl_token=${token}` },
      });
      const listBody = await listResponse.json();
      const detailResponse = await fetch(`${baseUrl}/suppliers/SCOPE-SUPPLIER-OTHER`, {
        headers: { Cookie: `qlcl_token=${token}` },
      });
      const detailBody = await detailResponse.json();
      const historyResponse = await fetch(`${baseUrl}/suppliers/SCOPE-SUPPLIER-OTHER/history`, {
        headers: { Cookie: `qlcl_token=${token}` },
      });
      const historyBody = await historyResponse.json();
      const updateResponse = await fetch(`${baseUrl}/suppliers/SCOPE-SUPPLIER-OTHER`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `qlcl_token=${token}`,
        },
        body: JSON.stringify({ contact_name: 'Out of scope update' }),
      });
      const updateBody = await updateResponse.json();

      assert.deepEqual({
        listStatus: listResponse.status,
        total: listBody.total,
        codes: listBody.items?.map((item) => item.supplier_code),
        detailStatus: detailResponse.status,
        detailError: detailBody.error,
        historyStatus: historyResponse.status,
        historyError: historyBody.error,
        updateStatus: updateResponse.status,
        updateError: updateBody.error,
        globalScopeCount: db.prepare(`SELECT COUNT(*) AS count FROM user_scope_assignments
          WHERE user_id = ? AND active = 1 AND scope_type = 'GLOBAL'`)
          .get('supplier-owner@example.invalid').count,
        storedContact: db.prepare('SELECT contact_name FROM supplier_master WHERE supplier_code = ?')
          .get('SCOPE-SUPPLIER-OTHER').contact_name,
      }, {
        listStatus: 200,
        total: 2,
        codes: ['SCOPE-SUPPLIER-OTHER', 'SCOPE-SUPPLIER-OWN'],
        detailStatus: 200,
        detailError: undefined,
        historyStatus: 200,
        historyError: undefined,
        updateStatus: 403,
        updateError: 'forbidden_scope',
        globalScopeCount: 0,
        storedContact: null,
      });
    }
  );
});

