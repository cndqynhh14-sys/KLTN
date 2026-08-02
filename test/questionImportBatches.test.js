'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function tempDbPath(label) {
  return path.join(os.tmpdir(), `qlcl-run15-${label}-${Date.now()}-${Math.random()}.db`);
}

function freshModules(dbPath) {
  const previous = {
    DB_PATH: process.env.DB_PATH,
    JWT_SECRET: process.env.JWT_SECRET,
  };
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'run15-synthetic-secret';
  for (const modulePath of [
    '../server/db',
    '../server/services/QuestionImportService',
    '../server/services/QuestionVersionService',
    '../server/middleware/auth',
    '../server/routes/questionTemplates',
  ]) {
    try { delete require.cache[require.resolve(modulePath)]; } catch {}
  }
  const dbModule = require('../server/db');
  const importModule = require('../server/services/QuestionImportService');
  const versionModule = require('../server/services/QuestionVersionService');
  const authModule = require('../server/middleware/auth');
  const questionTemplatesRouter = require('../server/routes/questionTemplates');
  return {
    ...dbModule,
    ...importModule,
    ...versionModule,
    ...authModule,
    signToken: canonicalTokenFactory(dbModule, authModule),
    questionTemplatesRouter,
    restore() {
      if (previous.DB_PATH === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previous.DB_PATH;
      if (previous.JWT_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous.JWT_SECRET;
      for (const modulePath of [
        '../server/db',
        '../server/services/QuestionImportService',
        '../server/services/QuestionVersionService',
        '../server/middleware/auth',
        '../server/routes/questionTemplates',
      ]) {
        try { delete require.cache[require.resolve(modulePath)]; } catch {}
      }
    },
  };
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/question-templates', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function workbookBuffer(rows, { headers, formula = false, hyperlink = false } = {}) {
  const canonicalHeaders = headers || [
    'template_code', 'variant_code', 'facility_type', 'supplier_scale',
    'category_code', 'category_name', 'question_code', 'clause_code',
    'question_text', 'allowed_scores', 'weight', 'order', 'active',
    'critical', 'elimination', 'requires_evidence',
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Canonical question import'],
    ['Upload creates a preview batch; publish remains a separate action.'],
  ]), 'README');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['column', 'meaning'],
    ...canonicalHeaders.map((header) => [header, `Definition for ${header}`]),
  ]), 'Data Dictionary');
  const sheet = XLSX.utils.aoa_to_sheet([canonicalHeaders, ...rows]);
  if (formula) sheet.A2 = { t: 'n', v: 2, f: '1+1' };
  if (hyperlink) sheet.I2.l = { Target: 'https://example.invalid/' };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Questions');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

function canonicalRow(overrides = {}) {
  const values = {
    template_code: 'BM04',
    variant_code: 'BM04-CHUNG-LARGE',
    facility_type: 'CHUNG',
    supplier_scale: 'LARGE',
    category_code: 'CAT-01',
    category_name: 'Synthetic category',
    question_code: 'RUN15-Q-001',
    clause_code: 'CLAUSE-001',
    question_text: 'Synthetic criterion for import tests',
    allowed_scores: 'A/B/C/D/NA',
    weight: 1,
    order: 1,
    active: 1,
    critical: 0,
    elimination: 0,
    requires_evidence: 0,
    ...overrides,
  };
  return [
    values.template_code, values.variant_code, values.facility_type, values.supplier_scale,
    values.category_code, values.category_name, values.question_code, values.clause_code,
    values.question_text, values.allowed_scores, values.weight, values.order, values.active,
    values.critical, values.elimination, values.requires_evidence,
  ];
}

function legacyWorkbookBuffer() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['TT', 'Hạng mục', 'Điều khoản'],
    ['L-01', 'Synthetic legacy', 'Legacy criterion'],
  ]), 'BM04-NCC lớn');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

function upload(buffer, name = 'questions.xlsx', mime = MIME) {
  return { buffer, originalname: name, mimetype: mime, size: buffer.length };
}

function draftFixture(fx) {
  const versions = new fx.QuestionVersionService(fx.db, { publishEnabled: true });
  const template = fx.db.prepare("SELECT * FROM question_templates WHERE template_code='BM04'").get();
  const v1 = versions.list({ templateId: template.id }).find((row) => row.version_no === 1);
  const draft = versions.createDraft({
    templateId: template.id,
    cloneFromVersionId: v1.id,
    note: 'RUN-15 synthetic draft',
    actor: 'admin@masangroup.com',
  });
  return { versions, template, v1, draft };
}

test('preview exposes a traceable diff without mutation; commit is atomic/idempotent and rollback restores the Draft', () => {
  const dbPath = tempDbPath('lifecycle');
  const fx = freshModules(dbPath);
  try {
    const { versions, template, draft } = draftFixture(fx);
    const imports = new fx.QuestionImportService(fx.db);
    const before = versions.get(draft.id);
    const beforeHash = versions.checksumForVersion(draft.id);
    const buffer = workbookBuffer([
      canonicalRow(),
      canonicalRow({ question_code: 'RUN15-Q-002', clause_code: 'CLAUSE-002', order: 2 }),
    ]);

    const preview = imports.preview({
      templateId: template.id,
      versionId: draft.id,
      file: upload(buffer),
      actor: 'admin@masangroup.com',
    });
    assert.equal(preview.batch.status, 'VALID');
    assert.equal(preview.batch.target_version_id, draft.id);
    assert.ok(preview.confirmation_token);
    assert.ok(preview.diff.ADDED.length > 0);
    assert.ok(preview.diff.REMOVED.length > 0);
    assert.equal(versions.checksumForVersion(draft.id), beforeHash);
    assert.equal(versions.get(draft.id).lock_version, before.lock_version);
    const previewDetail = imports.getBatch(preview.batch.public_id);
    assert.doesNotMatch(JSON.stringify(previewDetail.events), /Synthetic criterion for import tests/);
    assert.throws(() => fx.db.prepare('DELETE FROM question_import_changes WHERE batch_id=?').run(preview.batch.id), /question_import_changes_append_only/);

    const committed = imports.commit({
      batchId: preview.batch.public_id,
      confirmationToken: preview.confirmation_token,
      idempotencyKey: 'RUN15-IDEMPOTENCY-001',
      expectedLockVersion: draft.lock_version,
      actor: 'admin@masangroup.com',
    });
    assert.equal(committed.batch.status, 'COMMITTED');
    assert.equal(versions.get(draft.id).items.length, 2);
    const repeated = imports.commit({
      batchId: preview.batch.public_id,
      confirmationToken: preview.confirmation_token,
      idempotencyKey: 'RUN15-IDEMPOTENCY-001',
      expectedLockVersion: draft.lock_version,
      actor: 'admin@masangroup.com',
    });
    assert.equal(repeated.batch.id, committed.batch.id);
    assert.equal(repeated.version.lock_version, committed.version.lock_version);

    const rolledBack = imports.rollback({
      batchId: preview.batch.public_id,
      expectedLockVersion: committed.version.lock_version,
      actor: 'admin@masangroup.com',
    });
    assert.equal(rolledBack.batch.status, 'ROLLED_BACK');
    assert.equal(versions.checksumForVersion(draft.id), beforeHash);
    assert.equal(versions.get(draft.id).items.length, before.items.length);
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('canonical and BM01-BM04 legacy workbooks normalize before validation; invalid/duplicate rows support safe partial accept', () => {
  const dbPath = tempDbPath('validation');
  const fx = freshModules(dbPath);
  try {
    const { versions, template, draft } = draftFixture(fx);
    const imports = new fx.QuestionImportService(fx.db);
    const before = versions.get(draft.id);
    const invalid = workbookBuffer([
      canonicalRow(),
      canonicalRow({ question_code: 'RUN15-Q-001', clause_code: 'CLAUSE-DUP', order: 2 }),
      canonicalRow({ question_code: 'bad code!', clause_code: 'CLAUSE-003', weight: -1, order: 0 }),
      canonicalRow({ question_code: 'RUN15-Q-004', clause_code: 'CLAUSE-004', allowed_scores: 'A/X', order: 4 }),
    ]);
    const preview = imports.preview({ templateId: template.id, versionId: draft.id, file: upload(invalid), actor: 'synthetic' });
    assert.equal(preview.batch.status, 'PREVIEWED');
    assert.ok(preview.diff.DUPLICATE.length > 0);
    assert.ok(preview.diff.INVALID.length > 0);
    assert.throws(() => imports.commit({
      batchId: preview.batch.public_id,
      confirmationToken: preview.confirmation_token,
      idempotencyKey: 'RUN15-PARTIAL-001',
      expectedLockVersion: draft.lock_version,
      actor: 'synthetic',
    }), /import_batch_not_committable/);
    const partial = imports.commit({
      batchId: preview.batch.public_id,
      confirmationToken: preview.confirmation_token,
      idempotencyKey: 'RUN15-PARTIAL-001',
      expectedLockVersion: draft.lock_version,
      acceptPartial: true,
      actor: 'synthetic',
    });
    assert.equal(partial.batch.acceptance_status, 'PARTIAL_ACCEPTED');
    assert.ok(versions.get(draft.id).items.length >= before.items.length);
    const errorCsv = imports.exportErrors(preview.batch.public_id, 'csv');
    assert.match(errorCsv.body.toString('utf8'), /sheet,row,column,code/);
    assert.doesNotMatch(errorCsv.body.toString('utf8'), /Synthetic criterion for import tests/);
    const errorWorkbook = imports.exportErrors(preview.batch.public_id, 'xlsx');
    assert.equal(errorWorkbook.contentType, MIME);

    const secondDraft = versions.createDraft({ templateId: template.id, cloneFromVersionId: fx.db.prepare("SELECT id FROM question_template_versions WHERE template_id=? AND version_no=1").get(template.id).id, actor: 'synthetic' });
    const legacy = imports.preview({ templateId: template.id, versionId: secondDraft.id, file: upload(legacyWorkbookBuffer(), 'BM01-BM04.xlsx'), actor: 'synthetic' });
    assert.equal(legacy.batch.source_format, 'LEGACY_BM');
    assert.equal(legacy.batch.status, 'VALID');
    const thirdDraft = versions.createDraft({ templateId: template.id, cloneFromVersionId: fx.db.prepare("SELECT id FROM question_template_versions WHERE template_id=? AND version_no=1").get(template.id).id, actor: 'synthetic' });
    const allInvalid = imports.preview({
      templateId: template.id,
      versionId: thirdDraft.id,
      file: upload(workbookBuffer([canonicalRow({ question_code: 'invalid code!', weight: -1, order: 0 })])),
      actor: 'synthetic',
    });
    assert.equal(allInvalid.batch.valid_rows, 0);
    assert.ok(allInvalid.diff.INVALID.length > 0);
    assert.throws(() => imports.commit({
      batchId: allInvalid.batch.public_id,
      confirmationToken: allInvalid.confirmation_token,
      idempotencyKey: 'RUN15-ALL-INVALID',
      expectedLockVersion: thirdDraft.lock_version,
      acceptPartial: true,
      actor: 'synthetic',
    }), /import_batch_not_committable/);
    assert.throws(() => imports.preview({
      templateId: template.id,
      versionId: secondDraft.id,
      file: upload(workbookBuffer([canonicalRow()], { headers: ['template_code', 'question_code'] })),
      actor: 'synthetic',
    }), /canonical_header_invalid/);
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('workbook security rejects MIME/signature, formulas, hyperlinks, dangerous ZIP metadata and parser boundaries', () => {
  const dbPath = tempDbPath('security');
  const fx = freshModules(dbPath);
  try {
    const { template, draft } = draftFixture(fx);
    const imports = new fx.QuestionImportService(fx.db);
    const call = (file) => imports.preview({ templateId: template.id, versionId: draft.id, file, actor: 'synthetic' });
    assert.throws(() => call(upload(workbookBuffer([canonicalRow()]), 'bad.xlsx', 'application/octet-stream')), /workbook_mime_invalid/);
    assert.throws(() => call(upload(Buffer.from('not a zip'))), /workbook_zip_signature_invalid/);
    assert.throws(() => call(upload(workbookBuffer([canonicalRow()], { formula: true }))), /workbook_formula_forbidden/);
    assert.throws(() => call(upload(workbookBuffer([canonicalRow()], { hyperlink: true }))), /workbook_hyperlink_forbidden/);
    assert.throws(() => call(upload(workbookBuffer([canonicalRow({ question_text: 'x'.repeat(5000) })]))), /workbook_cell_limit_exceeded/);
    assert.throws(() => fx.validateWorkbookSecurity(upload(workbookBuffer([canonicalRow()])), { limits: { maxSheets: 2 } }), /workbook_sheet_limit_exceeded/);
    assert.throws(() => fx.validateWorkbookSecurity(upload(workbookBuffer([canonicalRow()])), { limits: { maxCells: 1 } }), /workbook_cell_count_limit_exceeded/);
    assert.throws(() => fx.inspectZipMetadata(fx.buildZipMetadataFixture('xl/externalLinks/externalLink1.xml')), /workbook_external_link_forbidden/);
    assert.throws(() => fx.inspectZipMetadata(fx.buildZipMetadataFixture('xl/embeddings/object1.bin')), /workbook_object_forbidden/);
    assert.throws(() => fx.inspectZipMetadata(fx.buildZipMetadataFixture('xl/vbaProject.bin')), /workbook_macro_forbidden/);
    assert.throws(() => fx.inspectZipMetadata(fx.buildZipMetadataFixture('xl/worksheets/sheet1.xml', { compressedSize: 1, uncompressedSize: 101 })), /workbook_zip_bomb_suspected/);
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('two-phase import API enforces authorization and exposes preview, detail, commit and error artifacts', async () => {
  const dbPath = tempDbPath('api');
  const fx = freshModules(dbPath);
  let server;
  try {
    upsertCanonicalUser(fx.db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    upsertCanonicalUser(fx.db, { email: 'specialist@masangroup.com', role: 'Chuyên viên' });
    const { template, draft } = draftFixture(fx);
    const app = await startApp(fx.questionTemplatesRouter);
    server = app.server;
    const form = () => {
      const value = new FormData();
      value.append('file', new Blob([workbookBuffer([canonicalRow()])], { type: MIME }), 'canonical.xlsx');
      return value;
    };
    const endpoint = `${app.baseUrl}/question-templates/${template.id}/versions/${draft.id}/imports/preview`;
    assert.equal((await fetch(endpoint, { method: 'POST', body: form() })).status, 401);
    const specialistToken = fx.signToken({ email: 'specialist@masangroup.com', isAdmin: false, role: 'Chuyên viên' }, 3600);
    assert.equal((await fetch(endpoint, {
      method: 'POST',
      headers: { Cookie: `qlcl_token=${specialistToken}` },
      body: form(),
    })).status, 403);

    const token = fx.signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const cookie = { Cookie: `qlcl_token=${token}` };
    const previewResponse = await fetch(endpoint, { method: 'POST', headers: cookie, body: form() });
    const previewBody = await previewResponse.json();
    assert.equal(previewResponse.status, 201, JSON.stringify(previewBody));
    const preview = previewBody.item;
    const storedToken = fx.db.prepare('SELECT confirmation_token_hash FROM question_import_batches WHERE public_id=?').get(preview.batch.public_id);
    assert.notEqual(storedToken.confirmation_token_hash, preview.confirmation_token);
    const detailResponse = await fetch(`${app.baseUrl}/question-templates/${template.id}/versions/${draft.id}/imports/${preview.batch.public_id}`, { headers: cookie });
    const detail = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert.ok(detail.item.changes.length > 0);
    assert.equal(detail.item.events[0].action, 'PREVIEWED');

    const commitResponse = await fetch(`${app.baseUrl}/question-templates/${template.id}/versions/${draft.id}/imports/${preview.batch.public_id}/commit`, {
      method: 'POST',
      headers: { ...cookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'RUN15-API-001' },
      body: JSON.stringify({ confirmation_token: preview.confirmation_token, expected_lock_version: draft.lock_version }),
    });
    const commit = await commitResponse.json();
    assert.equal(commitResponse.status, 200, JSON.stringify(commit));
    assert.equal(commit.item.batch.status, 'COMMITTED');
    const errors = await fetch(`${app.baseUrl}/question-templates/${template.id}/versions/${draft.id}/imports/${preview.batch.public_id}/errors.csv`, { headers: cookie });
    assert.equal(errors.status, 200);
    assert.match(errors.headers.get('content-type'), /text\/csv/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('startup criteria seed is checksum-approved and insert-only; canonical workbook stays reproducible', () => {
  const dbPath = tempDbPath('seed');
  const fx = freshModules(dbPath);
  try {
    const criteria = require('../server/services/criteriaImporter');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'database', 'seeds', 'question-criteria-source.json'), 'utf8'));
    const source = path.join(__dirname, '..', manifest.source);
    assert.equal(criteria.verifyCriteriaSeedSource(source, manifest.sha256).status, 'ready');
    assert.equal(criteria.verifyCriteriaSeedSource(source, '0'.repeat(64)).code, 'question_seed_checksum_mismatch');
    assert.equal(fx.questionSeedReadiness.status, 'ready');
    assert.throws(() => criteria.seedCriteriaWorkbook(fx.db, source, { expectedChecksum: manifest.sha256 }), /criteria_seed_requires_empty_target/);

    const dbSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
    assert.doesNotMatch(dbSource, /importCriteriaWorkbook\(db/);
    assert.match(dbSource, /seedCriteriaWorkbook\(db/);
    const canonicalPath = path.join(__dirname, '..', 'database', 'templates', 'question-template-import.xlsx');
    const workbook = XLSX.readFile(canonicalPath);
    assert.deepEqual(workbook.SheetNames, ['README', 'Data Dictionary', 'Questions']);
    assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets.Questions, { header: 1, defval: '' })[0], fx.CANONICAL_HEADERS);
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('question administration presents version selection, preview diff, partial accept, commit and rollback without raw JSON UX', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'questionTemplates.js'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'QuestionImportService.js'), 'utf8');
  const actions = require('../public/js/action-registry');
  for (const id of [
    'question-version-select', 'question-import-file', 'question-import-preview',
    'question-import-accept-partial', 'question-import-errors',
    'question-import-commit', 'question-import-rollback', 'question-import-diff-tbody',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const actionId of [
    'question_version.clone_draft', 'question_import.preview', 'question_import.commit',
    'question_import.rollback', 'question_import.export_errors',
  ]) assert.ok(actions.getAction(actionId), actionId);
  assert.match(app, /\['ADDED', 'CHANGED', 'REMOVED', 'UNCHANGED', 'DUPLICATE', 'INVALID'\]/);
  assert.match(app, /Preview đã sẵn sàng/);
  assert.doesNotMatch(html, /<pre[^>]*id="question-import|raw JSON/i);
  assert.match(route, /multer\.memoryStorage\(\)/);
  assert.doesNotMatch(route, /diskStorage/);
  assert.doesNotMatch(service, /writeFileSync|mkdtempSync|createWriteStream/);
});

test('preview and rollback reject Published versions; stale concurrent commits never half-write', () => {
  const dbPath = tempDbPath('concurrency');
  const fx = freshModules(dbPath);
  try {
    const { versions, template, v1, draft } = draftFixture(fx);
    const imports = new fx.QuestionImportService(fx.db);
    assert.throws(() => imports.preview({ templateId: template.id, versionId: v1.id, file: upload(workbookBuffer([canonicalRow()])), actor: 'synthetic' }), /question_version_not_draft/);

    const one = imports.preview({ templateId: template.id, versionId: draft.id, file: upload(workbookBuffer([canonicalRow()])), actor: 'synthetic' });
    const two = imports.preview({ templateId: template.id, versionId: draft.id, file: upload(workbookBuffer([canonicalRow({ question_code: 'RUN15-Q-ALT' })])), actor: 'synthetic' });
    const committed = imports.commit({ batchId: one.batch.public_id, confirmationToken: one.confirmation_token, idempotencyKey: 'CONCURRENT-ONE', expectedLockVersion: draft.lock_version, actor: 'synthetic' });
    const committedHash = versions.checksumForVersion(draft.id);
    assert.throws(() => imports.commit({ batchId: two.batch.public_id, confirmationToken: two.confirmation_token, idempotencyKey: 'CONCURRENT-TWO', expectedLockVersion: draft.lock_version, actor: 'synthetic' }), /question_version_conflict/);
    assert.equal(versions.checksumForVersion(draft.id), committedHash);
    assert.equal(imports.getBatch(two.batch.public_id).batch.status, 'VALID');

    versions.updateDraft({ versionId: draft.id, expectedLockVersion: committed.version.lock_version, note: 'later edit', actor: 'synthetic' });
    assert.throws(() => imports.rollback({ batchId: one.batch.public_id, expectedLockVersion: committed.version.lock_version, actor: 'synthetic' }), /question_version_conflict/);
  } finally {
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});
