const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const ROOT = path.resolve(__dirname, '..');

function freshModules(dbPath, { publishEnabled = false } = {}) {
  const previous = {
    DB_PATH: process.env.DB_PATH,
    JWT_SECRET: process.env.JWT_SECRET,
    QUESTION_VERSION_PUBLISH_ENABLED: process.env.QUESTION_VERSION_PUBLISH_ENABLED,
  };
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'run-14-synthetic-secret';
  process.env.QUESTION_VERSION_PUBLISH_ENABLED = publishEnabled ? '1' : '0';
  const modulePaths = [
    '../server/db',
    '../server/middleware/auth',
    '../server/routes/questionTemplates',
    '../server/services/QuestionVersionService',
    '../server/services/reporting',
  ];
  modulePaths.forEach((modulePath) => {
    try { delete require.cache[require.resolve(modulePath)]; } catch {}
  });
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  const questionTemplatesRouter = require('../server/routes/questionTemplates');
  const { QuestionVersionService } = require('../server/services/QuestionVersionService');
  const reporting = require('../server/services/reporting');
  return {
    ...dbModule,
    ...auth,
    signToken: canonicalTokenFactory(dbModule, auth),
    questionTemplatesRouter,
    QuestionVersionService,
    reporting,
    restore() {
      modulePaths.forEach((modulePath) => {
        try { delete require.cache[require.resolve(modulePath)]; } catch {}
      });
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    },
  };
}

function tempDbPath(label) {
  return path.join(os.tmpdir(), `qlcl-run14-${label}-${Date.now()}-${Math.random()}.db`);
}

function startApp(router) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use('/question-templates', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function insertTicketFixture(db, { code, versionId, templateId, facilityType = 'CHUNG', supplierScale = 'LARGE' }) {
  const supplier = db.prepare(`
    INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
    VALUES (?, ?, 'ACTIVE', 'MANUAL')
  `).run(`NCC-${code}`, `Supplier ${code}`);
  const ticket = db.prepare(`
    INSERT INTO evaluation_tickets (
      ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type,
      template_id, question_template_version_id, facility_type, supplier_scale,
      planned_date, current_status, assigned_specialist_id, created_by
    ) VALUES (?, ?, ?, ?, 'Dinh ky', ?, ?, ?, ?, '2026-07-14', 'Khoi tao',
      'admin@masangroup.com', 'admin@masangroup.com')
  `).run(
    code,
    supplier.lastInsertRowid,
    `NCC-${code}`,
    `Supplier ${code}`,
    templateId,
    versionId,
    facilityType,
    supplierScale
  );
  return db.prepare('SELECT * FROM evaluation_tickets WHERE id = ?').get(ticket.lastInsertRowid);
}

test('fresh database migrates BM01-BM04 into immutable Published v1 with clean reconciliation', () => {
  const dbPath = tempDbPath('fresh');
  const fx = freshModules(dbPath);
  try {
    const versions = fx.db.prepare(`
      SELECT t.template_code, v.*
      FROM question_template_versions v
      JOIN question_templates t ON t.id = v.template_id
      WHERE t.template_code IN ('BM01', 'BM02', 'BM03', 'BM04')
      ORDER BY t.template_code, v.version_no
    `).all();
    assert.equal(versions.length, 4);
    assert.ok(versions.every((row) => row.version_no === 1 && row.status === 'PUBLISHED'));
    assert.ok(versions.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)));

    const versionedCount = fx.db.prepare(`
      SELECT COUNT(*) AS n FROM question_items qi
      JOIN question_template_versions v ON v.id = qi.question_template_version_id
      JOIN question_templates t ON t.id = v.template_id
      WHERE qi.active = 1 AND t.template_code IN ('BM01', 'BM02', 'BM03', 'BM04')
    `).get().n;
    assert.ok(versionedCount > 0);
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='evaluation_questions'").get().n, 0);
    assert.ok(fx.db.prepare("PRAGMA table_info('evaluation_tickets')").all().some((column) => column.name === 'question_template_version_id'));

    const reconciliation = fx.db.prepare(`
      SELECT * FROM question_version_reconciliations ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(reconciliation.status, 'CLEAN');
    assert.equal(reconciliation.orphan_ticket_count, 0);
    assert.equal(reconciliation.orphan_answer_count, 0);
    assert.equal(reconciliation.unexpected_duplicate_count, 0);
    assert.equal(reconciliation.source_question_count, reconciliation.versioned_item_count);
    assert.match(reconciliation.source_hash, /^[a-f0-9]{64}$/);
    assert.equal(reconciliation.source_hash, reconciliation.versioned_hash);
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('publishing v2 leaves a pinned v1 ticket and its report question text unchanged', () => {
  const dbPath = tempDbPath('pin');
  const fx = freshModules(dbPath, { publishEnabled: true });
  try {
    upsertCanonicalUser(fx.db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const service = new fx.QuestionVersionService(fx.db, { publishEnabled: true });
    const template = fx.db.prepare("SELECT * FROM question_templates WHERE template_code='BM04'").get();
    const v1 = service.list({ templateId: template.id }).find((row) => row.version_no === 1);
    const oldQuestions = service.questionsForVersion(v1.id, { facilityType: 'CHUNG', supplierScale: 'LARGE' });
    assert.ok(oldQuestions.length > 0);
    const originalText = oldQuestions[0].question_text;
    const oldTicket = insertTicketFixture(fx.db, {
      code: 'RUN14-OLD',
      versionId: v1.id,
      templateId: template.id,
    });
    const round = fx.db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, assessment_code, status, completed_at)
      VALUES (?, 1, 'RUN14-OLD-R1', 'Hoan thanh', '2026-07-14')
    `).run(oldTicket.id);
    fx.db.prepare(`
      INSERT INTO evaluation_answers (round_id, question_item_id, score, comment, calculated_score, answered_by)
      VALUES (?, ?, 'A', 'synthetic', 100, 'admin@masangroup.com')
    `).run(round.lastInsertRowid, oldQuestions[0].id);
    const beforeHash = service.ticketQuestionHash(oldTicket.id);

    const draft = service.createDraft({ templateId: template.id, cloneFromVersionId: v1.id, note: 'Synthetic v2', actor: 'admin@masangroup.com' });
    const draftDetail = service.get(draft.id);
    draftDetail.items[0].question_text = `${originalText} — v2`;
    const lastItem = draftDetail.items[draftDetail.items.length - 1];
    draftDetail.items.push({
      ...lastItem,
      id: undefined,
      question_code: 'RUN14-NEW-ITEM',
      question_text: 'Synthetic v2-only criterion',
      order_index: Math.max(...draftDetail.items.map((item) => item.order_index)) + 1,
    });
    const updated = service.updateDraft({
      versionId: draft.id,
      expectedLockVersion: draft.lock_version,
      note: 'Synthetic v2 changed one question',
      items: draftDetail.items,
      actor: 'admin@masangroup.com',
    });
    const submitted = service.submit({ versionId: draft.id, expectedLockVersion: updated.lock_version, actor: 'admin@masangroup.com' });
    const published = service.publish({ versionId: draft.id, expectedLockVersion: submitted.lock_version, actor: 'admin@masangroup.com' });
    assert.equal(published.status, 'PUBLISHED');
    assert.equal(service.resolvePublished({ templateId: template.id, facilityType: 'CHUNG', supplierScale: 'LARGE' }).id, published.id);
    assert.equal(service.reconcile().status, 'CLEAN');

    assert.equal(service.ticketQuestionHash(oldTicket.id), beforeHash);
    assert.equal(service.questionsForTicket(oldTicket)[0].question_text, originalText);
    assert.equal(service.questionsForVersion(v1.id, { facilityType: 'CHUNG', supplierScale: 'LARGE' })[0].question_text, originalText);
    const context = fx.reporting.buildReportContext(fx.db, oldTicket, { reportType: 'INTERNAL', roundNo: 1 });
    assert.match(context.detailed_scoring, new RegExp(originalText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(context.detailed_scoring, /— v2/);

    const newTicket = insertTicketFixture(fx.db, {
      code: 'RUN14-NEW',
      versionId: service.resolvePublished({ templateId: template.id, facilityType: 'CHUNG', supplierScale: 'LARGE' }).id,
      templateId: template.id,
    });
    assert.equal(newTicket.question_template_version_id, published.id);
    assert.match(service.questionsForTicket(newTicket)[0].question_text, /— v2$/);
    const newRound = fx.db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, assessment_code, status, completed_at)
      VALUES (?, 1, 'RUN14-NEW-R1', 'Hoan thanh', '2026-07-14')
    `).run(newTicket.id);
    const newQuestion = service.questionsForTicket(newTicket)[0];
    fx.db.prepare(`
      INSERT INTO evaluation_answers (round_id, question_item_id, score, comment, calculated_score, answered_by)
      VALUES (?, ?, 'A', 'synthetic', 100, 'admin@masangroup.com')
    `).run(newRound.lastInsertRowid, newQuestion.id);
    const newContext = fx.reporting.buildReportContext(fx.db, newTicket, { reportType: 'INTERNAL', roundNo: 1 });
    assert.match(newContext.detailed_scoring, /— v2/);

    service.rollback({ versionId: v1.id, expectedLockVersion: v1.lock_version, actor: 'admin@masangroup.com' });
    service.retire({ versionId: published.id, expectedLockVersion: published.lock_version, actor: 'admin@masangroup.com' });
    assert.equal(service.get(published.id).status, 'RETIRED');
    assert.match(service.questionsForVersion(published.id, { facilityType: 'CHUNG', supplierScale: 'LARGE' })[0].question_text, /— v2$/);
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('Published rows are immutable at service and database boundaries', () => {
  const dbPath = tempDbPath('immutable');
  const fx = freshModules(dbPath, { publishEnabled: true });
  try {
    const service = new fx.QuestionVersionService(fx.db, { publishEnabled: true });
    const v1 = fx.db.prepare("SELECT * FROM question_template_versions WHERE status='PUBLISHED' ORDER BY id LIMIT 1").get();
    assert.throws(
      () => service.updateDraft({ versionId: v1.id, expectedLockVersion: v1.lock_version, note: 'tamper', items: [], actor: 'synthetic' }),
      /published_version_immutable/
    );
    assert.throws(() => fx.db.prepare('DELETE FROM question_template_versions WHERE id=?').run(v1.id), /published_version_immutable/);
    assert.throws(
      () => fx.db.prepare('UPDATE question_items SET question_text=? WHERE question_template_version_id=?').run('tamper', v1.id),
      /published_version_immutable/
    );
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('version lifecycle API enforces auth, feature flag, optimistic lock and single concurrent publish', async () => {
  const dbPath = tempDbPath('api');
  const fx = freshModules(dbPath);
  let server;
  try {
    upsertCanonicalUser(fx.db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    upsertCanonicalUser(fx.db, { email: 'ncc@masangroup.com', role: 'NCC' });
    const appInfo = await startApp(fx.questionTemplatesRouter);
    server = appInfo.server;
    const adminToken = fx.signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const nccToken = fx.signToken({ email: 'ncc@masangroup.com', isAdmin: false, role: 'NCC' }, 3600);
    const adminHeaders = { 'Content-Type': 'application/json', Cookie: `qlcl_token=${adminToken}` };
    const nccHeaders = { 'Content-Type': 'application/json', Cookie: `qlcl_token=${nccToken}` };
    const template = fx.db.prepare("SELECT * FROM question_templates WHERE template_code='BM04'").get();
    const v1 = fx.db.prepare('SELECT * FROM question_template_versions WHERE template_id=? AND version_no=1').get(template.id);

    assert.equal((await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions`)).status, 401);
    assert.equal((await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions`, {
      method: 'POST', headers: nccHeaders, body: JSON.stringify({ clone_from_version_id: v1.id }),
    })).status, 403);

    const createResponse = await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ clone_from_version_id: v1.id, note: 'API v2' }),
    });
    assert.equal(createResponse.status, 201);
    const draft = (await createResponse.json()).item;
    const detailResponse = await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}`, { headers: adminHeaders });
    const detail = (await detailResponse.json()).item;
    detail.items[0].question_text += ' — API v2';
    const updateResponse = await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ expected_lock_version: draft.lock_version, note: 'API v2 changed', items: detail.items }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = (await updateResponse.json()).item;
    assert.equal((await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}`, {
      method: 'PUT', headers: adminHeaders,
      body: JSON.stringify({ expected_lock_version: draft.lock_version, note: 'stale', items: detail.items }),
    })).status, 409);
    assert.equal((await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}/diff?against=${v1.id}`, { headers: adminHeaders })).status, 200);
    assert.equal((await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}/impact`, { headers: adminHeaders })).status, 200);
    assert.equal((await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}/validate`, { headers: nccHeaders })).status, 403);
    const validationResponse = await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}/validate`, { headers: adminHeaders });
    assert.equal(validationResponse.status, 200);
    assert.equal((await validationResponse.json()).item.valid, true);

    const submitResponse = await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}/submit`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ expected_lock_version: updated.lock_version }),
    });
    assert.equal(submitResponse.status, 200);
    const submitted = (await submitResponse.json()).item;
    assert.equal((await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}/publish`, {
      method: 'POST', headers: nccHeaders, body: JSON.stringify({ expected_lock_version: submitted.lock_version }),
    })).status, 403);
    const disabledPublish = await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}/publish`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ expected_lock_version: submitted.lock_version }),
    });
    assert.equal(disabledPublish.status, 503);
    assert.equal((await disabledPublish.json()).error, 'question_version_publish_disabled');

    process.env.QUESTION_VERSION_PUBLISH_ENABLED = '1';
    const publishCalls = await Promise.all([
      fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}/publish`, {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ expected_lock_version: submitted.lock_version }),
      }),
      fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${draft.id}/publish`, {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ expected_lock_version: submitted.lock_version }),
      }),
    ]);
    assert.deepEqual(publishCalls.map((response) => response.status).sort(), [200, 409]);
    const published = (await (publishCalls.find((response) => response.status === 200)).json()).item;
    assert.equal((await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${published.id}/items`, {
      method: 'PATCH', headers: adminHeaders,
      body: JSON.stringify({ expected_lock_version: published.lock_version, updates: [{ id: detail.items[0].id, question_text: 'tamper' }] }),
    })).status, 409);
    assert.equal((await fetch(`${appInfo.baseUrl}/question-templates/${template.id}/versions/${published.id}`, {
      method: 'PUT', headers: adminHeaders,
      body: JSON.stringify({ expected_lock_version: published.lock_version, note: 'tamper', items: detail.items }),
    })).status, 409);
    assert.equal(fx.db.prepare(`
      SELECT COUNT(*) AS n FROM question_template_assignments
      WHERE template_id=? AND facility_type='CHUNG' AND supplier_scale='LARGE' AND active=1 AND is_default=1
    `).get(template.id).n, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});
