const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const XLSX = require('xlsx');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');

const ROOT = path.resolve(__dirname, '..');

function tempDbPath(label) {
  return path.join(os.tmpdir(), `qlcl-run16-${label}-${Date.now()}-${Math.random()}.db`);
}

function freshModules(dbPath, { publishEnabled = false } = {}) {
  const previous = {
    DB_PATH: process.env.DB_PATH,
    JWT_SECRET: process.env.JWT_SECRET,
    QUESTION_VERSION_PUBLISH_ENABLED: process.env.QUESTION_VERSION_PUBLISH_ENABLED,
  };
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'run-16-synthetic-secret';
  process.env.QUESTION_VERSION_PUBLISH_ENABLED = publishEnabled ? '1' : '0';
  const modules = [
    '../server/db', '../server/middleware/auth', '../server/routes/questionTemplates',
    '../server/services/QuestionVersionService', '../server/services/QuestionImportService',
  ];
  modules.forEach((modulePath) => {
    try { delete require.cache[require.resolve(modulePath)]; } catch {}
  });
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  const questionTemplatesRouter = require('../server/routes/questionTemplates');
  const { QuestionVersionService } = require('../server/services/QuestionVersionService');
  const { QuestionImportService } = require('../server/services/QuestionImportService');
  return {
    ...dbModule,
    ...auth,
    signToken: canonicalTokenFactory(dbModule, auth),
    questionTemplatesRouter,
    QuestionVersionService,
    QuestionImportService,
    restore() {
      modules.forEach((modulePath) => {
        try { delete require.cache[require.resolve(modulePath)]; } catch {}
      });
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    },
  };
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

function canonicalWorkbook(templateCode, rows) {
  const headers = [
    'template_code', 'variant_code', 'facility_type', 'supplier_scale',
    'category_code', 'category_name', 'question_code', 'clause_code',
    'question_text', 'allowed_scores', 'weight', 'order', 'active',
    'critical', 'elimination', 'requires_evidence',
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    headers,
    ...rows.map((row, index) => [
      templateCode, 'ALL_ALL', 'ALL', 'ALL', row.category_code || 'GENERAL',
      row.category_name || 'Tổng quan', row.question_code, row.clause_code || `CLAUSE_${index + 1}`,
      row.question_text, row.allowed_scores || 'A/B/C/D/NA', row.weight ?? 1,
      row.order ?? index + 1, true, false, false, false,
    ]),
  ]), 'Questions');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

test('question catalog supports lifecycle/scope filters and explains defaults, counts, warnings and allowed actions', () => {
  const dbPath = tempDbPath('catalog');
  const fx = freshModules(dbPath);
  try {
    const service = new fx.QuestionVersionService(fx.db, { publishEnabled: false });
    const catalog = service.catalog({
      search: 'BM04', status: 'PUBLISHED', facilityType: 'CHUNG', supplierScale: 'LARGE',
    });
    assert.equal(catalog.length, 1);
    const item = catalog[0];
    assert.equal(item.template_code, 'BM04');
    assert.equal(item.current_version.status, 'PUBLISHED');
    assert.equal(item.default_version.id, item.current_version.id);
    assert.ok(item.version_count >= 1);
    assert.ok(item.question_count > 0);
    assert.ok(item.variant_count > 0);
    assert.equal(typeof item.ticket_pin_count, 'number');
    assert.ok(Array.isArray(item.warnings));
    assert.ok(item.current_version.allowed_actions.includes('question_version.clone_draft'));
    assert.ok(!item.current_version.allowed_actions.includes('question_version.save_draft'));

    const draft = service.createDraft({ templateId: item.id, cloneFromVersionId: item.current_version.id, actor: 'run16@synthetic.test' });
    const decoratedDraft = service.get(draft.id);
    assert.deepEqual(
      decoratedDraft.allowed_actions.filter((action) => action.startsWith('question_version.')).sort(),
      ['question_version.preview', 'question_version.validate', 'question_version.save_draft', 'question_version.submit_review'].sort()
    );
    assert.ok(decoratedDraft.allowed_actions.includes('question_import.preview'));
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('create template API atomically creates Draft and exposes catalog, import history and canonical workbook', async () => {
  const dbPath = tempDbPath('api');
  const fx = freshModules(dbPath);
  let server;
  try {
    fx.db.prepare(`
      INSERT INTO users (email, is_admin, role, is_active)
      VALUES ('admin@masangroup.com', 1, 'Admin', 1)
      ON CONFLICT(email) DO UPDATE SET is_admin=1, role='Admin', is_active=1
    `).run();
    const token = fx.signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const cookie = { Cookie: `qlcl_token=${token}` };
    const app = await startApp(fx.questionTemplatesRouter);
    server = app.server;

    const createdResponse = await fetch(`${app.baseUrl}/question-templates`, {
      method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_code: 'RUN16', template_name: 'Synthetic RUN-16' }),
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201, JSON.stringify(created));
    assert.equal(created.item.template_code, 'RUN16');
    assert.equal(created.item.current_version.status, 'DRAFT');
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM question_template_versions WHERE template_id=?').get(created.item.id).n, 1);

    const catalogResponse = await fetch(`${app.baseUrl}/question-templates?search=RUN16&status=DRAFT`, { headers: cookie });
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.items[0].current_version.status, 'DRAFT');

    const historyResponse = await fetch(`${app.baseUrl}/question-templates/${created.item.id}/versions/${created.item.current_version.id}/imports`, { headers: cookie });
    const history = await historyResponse.json();
    assert.equal(historyResponse.status, 200);
    assert.deepEqual(history.items, []);

    const workbookResponse = await fetch(`${app.baseUrl}/question-templates/import-template`, { headers: cookie });
    assert.equal(workbookResponse.status, 200);
    assert.match(workbookResponse.headers.get('content-type'), /spreadsheetml/);
    assert.match(workbookResponse.headers.get('content-disposition'), /question-template-import\.xlsx/);
    assert.ok((await workbookResponse.arrayBuffer()).byteLength > 1000);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('version lifecycle advertises distinct save, review and publish actions while preserving pinned ticket history', () => {
  const dbPath = tempDbPath('lifecycle');
  const fx = freshModules(dbPath, { publishEnabled: true });
  try {
    const service = new fx.QuestionVersionService(fx.db, { publishEnabled: true });
    const template = fx.db.prepare("SELECT * FROM question_templates WHERE template_code='BM04'").get();
    const publishedV1 = service.list({ templateId: template.id }).find((version) => version.status === 'PUBLISHED');
    const draft = service.createDraft({ templateId: template.id, cloneFromVersionId: publishedV1.id, actor: 'run16@synthetic.test' });
    const detail = service.get(draft.id);
    detail.items[0].question_text += ' RUN-16';
    const saved = service.updateDraft({
      versionId: draft.id, expectedLockVersion: draft.lock_version, items: detail.items,
      actor: 'run16@synthetic.test',
    });
    assert.equal(saved.status, 'DRAFT');
    const reviewed = service.submit({ versionId: draft.id, expectedLockVersion: saved.lock_version, actor: 'run16@synthetic.test' });
    assert.equal(reviewed.status, 'IN_REVIEW');
    assert.deepEqual(
      service.get(reviewed.id).allowed_actions.filter((action) => action.startsWith('question_version.')).sort(),
      ['question_version.preview', 'question_version.validate', 'question_version.publish'].sort()
    );
    const publishedV2 = service.publish({ versionId: reviewed.id, expectedLockVersion: reviewed.lock_version, actor: 'run16@synthetic.test' });
    assert.equal(publishedV2.status, 'PUBLISHED');
    assert.ok(service.get(publishedV2.id).allowed_actions.includes('question_version.clone_draft'));
    assert.equal(service.get(publishedV1.id).status, 'PUBLISHED');
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('PROMPT-09 question workspace exposes four canonical tabs, summary, backend checks and Published read-only UX', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'tailwind.css'), 'utf8');
  const actions = require('../public/js/action-registry');

  for (const id of [
    'question-catalog-search', 'question-catalog-status', 'question-catalog-facility', 'question-catalog-scale',
    'question-workspace-tabs', 'question-tab-questions', 'question-tab-variants', 'question-tab-scopes',
    'question-tab-versions', 'question-validation-summary', 'question-preview', 'question-validate',
    'question-scope-tbody', 'question-preview-dialog',
    'question-editor-drawer', 'question-version-timeline', 'question-import-wizard',
    'question-download-template', 'question-import-error-filter', 'question-workspace-live',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.equal((html.match(/data-question-tab=/g) || []).length, 4);
  assert.doesNotMatch(html, /data-question-tab="(?:overview|imports)"/);
  assert.ok(html.indexOf('id="question-overview-counts"') < html.indexOf('id="question-workspace-tabs"'));
  assert.match(html, /<th>Loại trả lời<\/th>/);
  for (const step of ['select', 'validate', 'compare', 'confirm']) {
    assert.match(html, new RegExp(`data-import-step="${step}"`), step);
  }
  for (const actionId of [
    'question_version.preview', 'question_version.validate',
    'question_version.save_draft', 'question_version.submit_review', 'question_version.publish',
    'question.bulk_deactivate', 'question.reorder', 'question_import.download_template',
  ]) assert.ok(actions.getAction(actionId), actionId);
  assert.match(app, /syncQuestionWorkspaceUrl/);
  assert.match(app, /overview:\s*'questions'/);
  assert.match(app, /imports:\s*'versions'/);
  assert.match(app, /\/validate/);
  assert.match(app, /URLSearchParams/);
  assert.match(app, /isQuestionVersionEditable/);
  assert.match(app, /button\.dataset\.resourceAction === 'true'/);
  assert.match(app, /beforeunload/);
  assert.match(app, /question_version_conflict/);
  assert.match(app, /focusQuestionValidationSummary/);
  assert.match(css, /\.question-workspace/);
  assert.match(css, /@media[^{}]*max-width[^{}]*\{[\s\S]*\.question-editor-drawer/);
  assert.doesNotMatch(html, /role="menu"[^>]*id="question/);
});

test('PROMPT-09 backend owns preview/validate availability and validation summary without mutating lifecycle', () => {
  const dbPath = tempDbPath('prompt09-validation');
  const fx = freshModules(dbPath, { publishEnabled: false });
  try {
    const service = new fx.QuestionVersionService(fx.db, { publishEnabled: false });
    const template = fx.db.prepare("SELECT * FROM question_templates WHERE template_code='BM01'").get();
    const published = service.list({ templateId: template.id }).find((version) => version.status === 'PUBLISHED');
    assert.ok(published.allowed_actions.includes('question_version.preview'));
    assert.ok(published.allowed_actions.includes('question_version.validate'));
    const publishedValidation = service.validate(published.id);
    assert.equal(publishedValidation.valid, true);
    assert.equal(publishedValidation.error_count, 0);
    assert.ok(publishedValidation.item_count > 0);
    assert.equal(service.getRow(published.id).status, 'PUBLISHED');

    const emptyDraft = service.createDraft({ templateId: template.id, actor: 'prompt09@synthetic.test' });
    const draftValidation = service.validate(emptyDraft.id);
    assert.equal(draftValidation.valid, false);
    assert.ok(draftValidation.errors.includes('question_items_required'));
    assert.equal(service.getRow(emptyDraft.id).status, 'DRAFT');
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('HTTP E2E creates Draft, edits a question, previews and commits import, reviews, publishes and preserves a pinned ticket on rollback', async () => {
  const dbPath = tempDbPath('http-e2e');
  const fx = freshModules(dbPath, { publishEnabled: true });
  let server;
  try {
    fx.db.prepare(`
      INSERT INTO users (email, is_admin, role, is_active)
      VALUES ('admin@masangroup.com', 1, 'Admin', 1)
      ON CONFLICT(email) DO UPDATE SET is_admin=1, role='Admin', is_active=1
    `).run();
    const token = fx.signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const headers = { Cookie: `qlcl_token=${token}` };
    const app = await startApp(fx.questionTemplatesRouter);
    server = app.server;

    const createdResponse = await fetch(`${app.baseUrl}/question-templates`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_code: 'RUN16E2E', template_name: 'RUN-16 E2E' }),
    });
    const created = (await createdResponse.json()).item;
    const draft = created.current_version;
    assert.equal(draft.status, 'DRAFT');

    const initialItems = [{
      facility_type: 'ALL', supplier_scale: 'ALL', variant_code: 'ALL_ALL',
      category_code: 'GENERAL', category: 'Tổng quan', question_code: 'Q001',
      clause_code: 'CLAUSE_1', question_text: 'Câu hỏi được tạo trong Draft',
      allowed_scores: 'A/B/C/D/NA', weight: 1, order_index: 1, active: 1,
      is_elimination_clause: 0, is_critical_clause: 0, requires_attachment: 0,
    }];
    const savedResponse = await fetch(`${app.baseUrl}/question-templates/${created.id}/versions/${draft.id}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_lock_version: draft.lock_version, items: initialItems }),
    });
    const saved = (await savedResponse.json()).item;
    assert.equal(savedResponse.status, 200);
    assert.equal(saved.status, 'DRAFT');

    const savedDetail = (await (await fetch(`${app.baseUrl}/question-templates/${created.id}/versions/${draft.id}`, { headers })).json()).item;
    const patchResponse = await fetch(`${app.baseUrl}/question-templates/${created.id}/versions/${draft.id}/items`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_lock_version: saved.lock_version,
        updates: [{ id: savedDetail.items[0].id, question_text: 'Câu hỏi sửa bằng delta nhỏ' }],
      }),
    });
    const patched = (await patchResponse.json()).item;
    assert.equal(patchResponse.status, 200);
    assert.equal(patched.lock_version, saved.lock_version + 1);
    assert.equal((await fetch(`${app.baseUrl}/question-templates/${created.id}/versions/${draft.id}/items`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_lock_version: saved.lock_version, updates: [{ id: savedDetail.items[0].id, active: 0 }] }),
    })).status, 409);
    const patchedDetail = (await (await fetch(`${app.baseUrl}/question-templates/${created.id}/versions/${draft.id}`, { headers })).json()).item;
    assert.equal(patchedDetail.items[0].question_text, 'Câu hỏi sửa bằng delta nhỏ');

    const form = new FormData();
    form.append('file', new Blob([canonicalWorkbook('RUN16E2E', [
      { question_code: 'Q001', question_text: 'Câu hỏi thay đổi sau preview', order: 1 },
      { question_code: 'Q002', question_text: 'Câu hỏi được thêm bằng import', order: 2 },
    ])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'run16.xlsx');
    const importBase = `${app.baseUrl}/question-templates/${created.id}/versions/${draft.id}/imports`;
    const previewResponse = await fetch(`${importBase}/preview`, { method: 'POST', headers, body: form });
    const preview = (await previewResponse.json()).item;
    assert.equal(previewResponse.status, 201);
    assert.equal(preview.batch.changed_count, 1);
    assert.equal(preview.batch.added_count, 1);

    const commitResponse = await fetch(`${importBase}/${preview.batch.public_id}/commit`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': 'RUN16-E2E-COMMIT' },
      body: JSON.stringify({ confirmation_token: preview.confirmation_token, expected_lock_version: patched.lock_version }),
    });
    const committed = (await commitResponse.json()).item;
    assert.equal(commitResponse.status, 200);
    assert.equal(committed.batch.status, 'COMMITTED');
    const committedDetail = await (await fetch(`${app.baseUrl}/question-templates/${created.id}/versions/${draft.id}`, { headers })).json();
    assert.equal(committedDetail.item.items.length, 2);

    const submitResponse = await fetch(`${app.baseUrl}/question-templates/${created.id}/versions/${draft.id}/submit`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_lock_version: committed.version.lock_version }),
    });
    const reviewed = (await submitResponse.json()).item;
    assert.equal(reviewed.status, 'IN_REVIEW');
    const publishResponse = await fetch(`${app.baseUrl}/question-templates/${created.id}/versions/${draft.id}/publish`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_lock_version: reviewed.lock_version }),
    });
    const published = (await publishResponse.json()).item;
    assert.equal(published.status, 'PUBLISHED');

    const supplier = fx.db.prepare(`INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type) VALUES ('RUN16-NCC', 'RUN-16 Synthetic', 'ACTIVE', 'MANUAL')`).run();
    const ticket = fx.db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type,
        template_id, question_template_version_id, facility_type, supplier_scale,
        planned_date, current_status, assigned_specialist_id, created_by
      ) VALUES ('RUN16-TICKET', ?, 'RUN16-NCC', 'RUN-16 Synthetic', 'Dinh ky', ?, ?, 'ALL', 'LARGE', '2026-07-14', 'Khoi tao', 'admin@masangroup.com', 'admin@masangroup.com')
    `).run(supplier.lastInsertRowid, created.id, published.id);
    const pinnedBefore = fx.db.prepare('SELECT question_template_version_id FROM evaluation_tickets WHERE id=?').get(ticket.lastInsertRowid).question_template_version_id;
    const rollbackResponse = await fetch(`${app.baseUrl}/question-templates/${created.id}/versions/${published.id}/rollback`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_lock_version: published.lock_version }),
    });
    assert.equal(rollbackResponse.status, 200);
    assert.equal(fx.db.prepare('SELECT question_template_version_id FROM evaluation_tickets WHERE id=?').get(ticket.lastInsertRowid).question_template_version_id, pinnedBefore);
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM question_items WHERE question_template_version_id=?').get(published.id).n, 2);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});
