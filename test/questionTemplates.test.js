const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

function freshModules(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  for (const modulePath of [
    '../server/db',
    '../server/middleware/auth',
    '../server/routes/questionTemplates',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  const questionTemplatesRouter = require('../server/routes/questionTemplates');
  return { ...dbModule, ...auth, questionTemplatesRouter };
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/question-templates', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('admin question save keeps Loai evidence off and preserves non-Loai evidence', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-question-template-test-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, questionTemplatesRouter } = freshModules(dbPath);
  let server;

  try {
    db.prepare(`
      INSERT INTO users (email, is_admin, role, is_active)
      VALUES ('admin@masangroup.com', 1, 'Admin', 1)
      ON CONFLICT(email) DO UPDATE SET is_admin=1, role='Admin', is_active=1
    `).run();
    const template = db.prepare(`
      INSERT INTO question_templates (template_code, template_name, active)
      VALUES ('QT42', 'Prompt 42 Test', 1)
    `).run();

    const appInfo = await startApp(questionTemplatesRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const headers = { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` };

    const eliminationRes = await fetch(`${appInfo.baseUrl}/question-templates/${template.lastInsertRowid}/questions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        facility_type: 'ALL',
        supplier_scale: 'ALL',
        category: 'Legal',
        question_code: 'L-001',
        question_text: 'Elimination requirement',
        is_elimination_clause: true,
        is_critical_clause: false,
        requires_attachment: true,
        allowed_scores: 'A/D/NA',
        order_index: 1,
        active: true,
      }),
    });
    const eliminationJson = await eliminationRes.json();
    assert.equal(eliminationRes.status, 201, JSON.stringify(eliminationJson));
    assert.equal(eliminationJson.item.is_elimination_clause, true);
    assert.equal(eliminationJson.item.requires_attachment, false);

    const normalRes = await fetch(`${appInfo.baseUrl}/question-templates/${template.lastInsertRowid}/questions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        facility_type: 'ALL',
        supplier_scale: 'ALL',
        category: 'Quality',
        question_code: 'Q-001',
        question_text: 'Normal requirement',
        is_elimination_clause: false,
        is_critical_clause: false,
        requires_attachment: true,
        allowed_scores: 'A/B/C/D/NA',
        order_index: 2,
        active: true,
      }),
    });
    const normalJson = await normalRes.json();
    assert.equal(normalRes.status, 201, JSON.stringify(normalJson));
    assert.equal(normalJson.item.requires_attachment, true);

    const listRes = await fetch(`${appInfo.baseUrl}/question-templates/${template.lastInsertRowid}/questions?include_inactive=1`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const listJson = await listRes.json();
    assert.equal(listRes.status, 200, JSON.stringify(listJson));
    const elimination = listJson.items.find((item) => item.question_code === 'L-001');
    const normal = listJson.items.find((item) => item.question_code === 'Q-001');
    assert.equal(elimination.requires_attachment, false);
    assert.equal(normal.requires_attachment, true);
    assert.equal(db.prepare('SELECT requires_attachment FROM question_items WHERE id = ?').get(elimination.id).requires_attachment, 0);
    assert.equal(db.prepare('SELECT requires_attachment FROM question_items WHERE id = ?').get(normal.id).requires_attachment, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    for (const modulePath of ['../server/db', '../server/middleware/auth', '../server/routes/questionTemplates']) {
      delete require.cache[require.resolve(modulePath)];
    }
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    fs.rmSync(dbPath, { force: true });
  }
});
