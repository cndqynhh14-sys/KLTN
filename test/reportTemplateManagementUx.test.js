'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');

const ROOT = path.resolve(__dirname, '..');

function tempDbPath(label) {
  return path.join(os.tmpdir(), `qlcl-run20-${label}-${Date.now()}-${Math.random()}.db`);
}

function freshModules(dbPath) {
  const previous = {
    DB_PATH: process.env.DB_PATH,
    JWT_SECRET: process.env.JWT_SECRET,
    REPORT_LEGACY_ALIAS_APPROVAL: process.env.REPORT_LEGACY_ALIAS_APPROVAL,
  };
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'run-20-synthetic-secret';
  delete process.env.REPORT_LEGACY_ALIAS_APPROVAL;
  const modules = [
    '../server/db', '../server/middleware/auth', '../server/routes/reportTemplates',
    '../server/reporting/ReportTemplateVersionRepository', '../server/reporting/ReportDefinitionPackage',
  ];
  modules.forEach((modulePath) => {
    try { delete require.cache[require.resolve(modulePath)]; } catch {}
  });
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  const reportTemplatesRouter = require('../server/routes/reportTemplates');
  return {
    ...dbModule,
    ...auth,
    signToken: canonicalTokenFactory(dbModule, auth),
    reportTemplatesRouter,
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
  app.use('/report-templates', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function installSyntheticUsers(db) {
  for (const [email, isAdmin, role] of [
    ['run20-admin@synthetic.invalid', 1, 'Admin'],
    ['run20-designer@synthetic.invalid', 0, 'Chuyên viên'],
    ['run20-auditor@synthetic.invalid', 0, 'Chuyên viên'],
  ]) {
    db.prepare(`INSERT INTO users (email, is_admin, role, is_active, created_by)
      VALUES (?, ?, ?, 1, 'RUN-20') ON CONFLICT(email) DO UPDATE SET is_admin=excluded.is_admin, role=excluded.role, is_active=1`).run(email, isAdmin, role);
  }
  for (const [code, label] of [['RUN20_DESIGNER', 'RUN-20 Designer'], ['RUN20_AUDITOR', 'RUN-20 Auditor']]) {
    db.prepare(`INSERT INTO roles (role_code, display_label, role_kind, active)
      VALUES (?, ?, 'FUNCTIONAL', 1)`).run(code, label);
  }
  const grant = db.prepare(`INSERT INTO role_permissions (role_id, permission_code, effect, created_by)
    SELECT id, ?, 'ALLOW', 'run20-admin@synthetic.invalid' FROM roles WHERE role_code=?`);
  for (const permission of ['REPORT.READ', 'REPORT_TEMPLATE.MANAGE']) grant.run(permission, 'RUN20_DESIGNER');
  grant.run('REPORT.READ', 'RUN20_AUDITOR');
  const assign = db.prepare(`INSERT INTO user_roles (user_id, role_id, source, created_by)
    SELECT ?, id, 'MANUAL', 'run20-admin@synthetic.invalid' FROM roles WHERE role_code=?`);
  assign.run('run20-designer@synthetic.invalid', 'RUN20_DESIGNER');
  assign.run('run20-auditor@synthetic.invalid', 'RUN20_AUDITOR');
}

function cookie(token) {
  return { Cookie: `qlcl_token=${token}` };
}

test('RUN-20 catalog exposes only canonical definitions and role-specific allowed actions', async () => {
  const dbPath = tempDbPath('catalog');
  const fx = freshModules(dbPath);
  let server;
  try {
    installSyntheticUsers(fx.db);
    assert.ok(fx.db.prepare("SELECT 1 FROM permissions WHERE permission_code='REPORT_TEMPLATE.PUBLISH'").get());
    assert.ok(fx.db.prepare("SELECT 1 FROM permissions WHERE permission_code='REPORT_TEMPLATE.ADVANCED'").get());
    const adminToken = fx.signToken({ email: 'run20-admin@synthetic.invalid' }, 3600);
    const designerToken = fx.signToken({ email: 'run20-designer@synthetic.invalid' }, 3600);
    const auditorToken = fx.signToken({ email: 'run20-auditor@synthetic.invalid' }, 3600);
    const app = await startApp(fx.reportTemplatesRouter);
    server = app.server;

    const catalogResponse = await fetch(`${app.baseUrl}/report-templates/definitions`, { headers: cookie(auditorToken) });
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200);
    assert.deepEqual(catalog.items.map((item) => item.definition_code).sort(), ['ROUND1_RESULT', 'ROUND2_RESULT', 'WORKING_MINUTES']);
    assert.ok(catalog.items.every((item) => item.default_version && item.latest_version && Array.isArray(item.warnings)));
    assert.ok(catalog.items.every((item) => item.allowed_actions.includes('report_template.preview')));
    assert.ok(catalog.items.every((item) => !item.allowed_actions.includes('report_template.create_draft')));
    assert.equal(catalog.legacy.section, 'MIGRATION_ARCHIVED');
    assert.ok(catalog.legacy.items.every((item) => ['INTERNAL', 'NCC'].includes(item.report_type)));
    assert.ok(catalog.legacy.items.every((item) => item.canonical_code === null));
    assert.ok(catalog.legacy.items.every((item) => item.legacy_source === item.report_type));
    assert.ok(catalog.legacy.items.every((item) => item.deprecation?.new_creation_allowed === false));

    const migrationResponse = await fetch(`${app.baseUrl}/report-templates/legacy-migration`, { headers: cookie(adminToken) });
    const migration = await migrationResponse.json();
    assert.equal(migrationResponse.status, 200);
    assert.deepEqual(migration.report.counts, { mapped: 0, skipped: 1, conflict: 0, missing: 0, ambiguous: 1 });
    assert.equal(migration.report.mutated, false);
    assert.equal(migration.review_queue.length, 2);

    const applyPendingResponse = await fetch(`${app.baseUrl}/report-templates/legacy-migration/apply`, {
      method: 'POST', headers: { ...cookie(adminToken), 'Content-Type': 'application/json' }, body: '{}',
    });
    const applyPending = await applyPendingResponse.json();
    assert.equal(applyPendingResponse.status, 409);
    assert.equal(applyPending.error, 'report_legacy_mapping_pending');
    assert.deepEqual(applyPending.allowed_next_actions, ['select_canonical_report_type']);

    const legacyCreateResponse = await fetch(`${app.baseUrl}/report-templates`, {
      method: 'POST', headers: { ...cookie(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_name: 'RUN-21 must reject legacy', report_type: 'NCC', template_body: 'Synthetic' }),
    });
    const legacyCreate = await legacyCreateResponse.json();
    assert.equal(legacyCreateResponse.status, 409);
    assert.equal(legacyCreate.error, 'report_legacy_creation_disabled');
    assert.equal(legacyCreate.details.legacy_source, 'NCC');

    const designerCatalog = await (await fetch(`${app.baseUrl}/report-templates/definitions`, { headers: cookie(designerToken) })).json();
    assert.ok(designerCatalog.items.every((item) => item.allowed_actions.includes('report_template.create_draft')));

    const createdResponse = await fetch(`${app.baseUrl}/report-templates/definitions/ROUND1_RESULT/versions`, {
      method: 'POST', headers: { ...cookie(designerToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_name: 'RUN-20 Designer Draft' }),
    });
    const created = (await createdResponse.json()).item;
    assert.equal(createdResponse.status, 201);
    assert.equal(created.status, 'DRAFT');
    assert.ok(created.allowed_actions.includes('report_template.save_draft'));
    assert.ok(created.allowed_actions.includes('report_template.submit_review'));
    assert.ok(!created.allowed_actions.includes('report_template.publish'));
    assert.ok(!created.allowed_actions.includes('report_template.advanced_json'));

    const definition = structuredClone(created.definition);
    definition.components.splice(1, 0, { id: 'run20-standard', type: 'text_block', text: 'RUN-20 STANDARD BUILDER' });
    const standardSave = await fetch(`${app.baseUrl}/report-templates/versions/${created.id}`, {
      method: 'PUT', headers: { ...cookie(designerToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock_version: created.lock_version, components: definition.components, styles: definition.styles }),
    });
    assert.equal(standardSave.status, 200, JSON.stringify(await standardSave.clone().json()));
    const saved = (await standardSave.json()).item;

    const invalidDefinition = structuredClone(saved.definition);
    invalidDefinition.components.push({ id: 'run10-invalid-binding', type: 'text_block', binding: 'doc4.secret.value' });
    const invalidSave = await fetch(`${app.baseUrl}/report-templates/versions/${created.id}`, {
      method: 'PUT', headers: { ...cookie(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock_version: saved.lock_version, editor_mode: 'advanced_json', definition: invalidDefinition }),
    });
    const invalidSaveBody = await invalidSave.json();
    assert.equal(invalidSave.status, 400);
    assert.equal(invalidSaveBody.error, 'report_binding_not_allowed');
    assert.equal(invalidSaveBody.details.path, `components.${invalidDefinition.components.length - 1}.binding`);

    const advancedDenied = await fetch(`${app.baseUrl}/report-templates/versions/${created.id}`, {
      method: 'PUT', headers: { ...cookie(designerToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock_version: saved.lock_version, editor_mode: 'advanced_json', definition: saved.definition }),
    });
    assert.equal(advancedDenied.status, 403);
    assert.equal((await advancedDenied.json()).error, 'forbidden_permission');

    const submittedResponse = await fetch(`${app.baseUrl}/report-templates/versions/${created.id}/submit`, {
      method: 'POST', headers: { ...cookie(designerToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock_version: saved.lock_version }),
    });
    const submitted = (await submittedResponse.json()).item;
    assert.equal(submittedResponse.status, 200);
    assert.equal(submitted.status, 'IN_REVIEW');
    assert.ok(!submitted.allowed_actions.includes('report_template.publish'));

    const publishDenied = await fetch(`${app.baseUrl}/report-templates/versions/${created.id}/publish`, {
      method: 'POST', headers: { ...cookie(designerToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock_version: submitted.lock_version }),
    });
    assert.equal(publishDenied.status, 403);

    const publishResponse = await fetch(`${app.baseUrl}/report-templates/versions/${created.id}/publish`, {
      method: 'POST', headers: { ...cookie(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock_version: submitted.lock_version }),
    });
    assert.equal(publishResponse.status, 200, JSON.stringify(await publishResponse.clone().json()));
    assert.equal((await publishResponse.json()).item.status, 'PUBLISHED');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('RUN-20 package and synthetic preview use the versioned engine without ticket data or unsafe bypass', async () => {
  const dbPath = tempDbPath('preview-package');
  const fx = freshModules(dbPath);
  let server;
  try {
    installSyntheticUsers(fx.db);
    const adminToken = fx.signToken({ email: 'run20-admin@synthetic.invalid' }, 3600);
    const headers = cookie(adminToken);
    const app = await startApp(fx.reportTemplatesRouter);
    server = app.server;
    const source = fx.db.prepare("SELECT * FROM report_template_versions WHERE definition_code='ROUND1_RESULT' AND status='PUBLISHED' ORDER BY version_no LIMIT 1").get();
    const publishedPreviewResponse = await fetch(`${app.baseUrl}/report-templates/versions/${source.id}/preview?source=synthetic&format=HTML&envelope=1`, { headers });
    const publishedPreview = await publishedPreviewResponse.json();
    assert.equal(publishedPreviewResponse.status, 200, JSON.stringify(publishedPreview));

    const draftResponse = await fetch(`${app.baseUrl}/report-templates/definitions/ROUND1_RESULT/versions`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_version_id: source.id, version_name: 'RUN-20 Preview Draft' }),
    });
    let draft = (await draftResponse.json()).item;
    const tree = structuredClone(draft.definition);
    tree.components.splice(1, 0, { id: 'run20-preview', type: 'text_block', text: 'RUN-20 PREVIEW CHANGE' });
    tree.styles = { page_orientation: 'portrait', font_scale: 1.05, accent_color: '#be123c' };
    const savedResponse = await fetch(`${app.baseUrl}/report-templates/versions/${draft.id}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock_version: draft.lock_version, editor_mode: 'advanced_json', definition: tree }),
    });
    draft = (await savedResponse.json()).item;
    assert.equal(savedResponse.status, 200);

    const previewResponse = await fetch(`${app.baseUrl}/report-templates/versions/${draft.id}/preview?source=synthetic&format=HTML&envelope=1`, { headers });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200, JSON.stringify(preview));
    assert.match(preview.html, /RUN-20 PREVIEW CHANGE/);
    assert.match(preview.html, /--report-accent:#be123c/);
    assert.match(preview.html, /data-page-orientation="portrait"/);
    assert.equal(preview.provenance.template_version_id, draft.id);
    assert.equal(preview.provenance.data_contract_version, 1);
    assert.ok(preview.provenance.scoring_policy);
    assert.deepEqual(preview.provenance.scoring_policy, publishedPreview.provenance.scoring_policy);
    assert.equal(preview.comparison.changed, true);
    assert.deepEqual(preview.formats.map((item) => item.format), ['HTML', 'PDF', 'XLSX']);
    assert.ok(Array.isArray(preview.warnings));

    const packageResponse = await fetch(`${app.baseUrl}/report-templates/versions/${draft.id}/package`, { headers });
    const definitionPackage = await packageResponse.json();
    assert.equal(packageResponse.status, 200);
    assert.equal(definitionPackage.manifest.definition_code, 'ROUND1_RESULT');
    assert.match(definitionPackage.manifest.checksum, /^[a-f0-9]{64}$/);
    assert.equal(definitionPackage.definition.components.some((component) => component.id === 'run20-preview'), true);
    assert.equal(JSON.stringify(definitionPackage).includes('ticket_data'), false);

    const unsafe = structuredClone(definitionPackage);
    unsafe.definition.components.push({ id: 'unsafe', type: 'text_block', text: '<script>alert(1)</script>' });
    const unsafeImport = await fetch(`${app.baseUrl}/report-templates/definitions/ROUND1_RESULT/import-package`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: unsafe, conflict_strategy: 'CREATE_DRAFT' }),
    });
    assert.equal(unsafeImport.status, 400);
    assert.equal((await unsafeImport.json()).error, 'unsafe_report_template');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fx.db.close();
    fx.restore();
    fs.rmSync(dbPath, { force: true });
  }
});

test('RUN-20 Overview presentation changes layout visibility without changing policy-owned rows or result', () => {
  const { getDefinition } = require('../server/reporting/definitionCatalog');
  const { buildSemanticModel, validateComponentTree } = require('../server/reporting/componentRegistry');
  const { buildSyntheticReportContext } = require('../server/reporting/reportPreviewFixture');
  const canonical = getDefinition('ROUND1_RESULT');
  const tree = structuredClone(canonical.componentTree);
  const overview = tree.components.find((component) => component.type === 'compliance_overview');
  overview.presentation = { layout: 'table', category_mode: 'all', show_chart: true, show_legend: false };
  tree.styles = { page_orientation: 'landscape', font_scale: 1, accent_color: '#123456' };
  const validated = validateComponentTree(tree);
  const policyOverview = {
    title: 'Policy-owned title',
    columns: [{ label: 'Hạng mục', key: 'category' }, { label: '%', key: 'percentage' }],
    rows: [{ category: 'LEGAL', percentage: 95 }],
    totals: { category: 'Tổng', percentage: 95 },
    chart: { enabled: true, type: 'radar', categories: ['LEGAL'], values: [95] },
    legend: { label: 'Chú giải', items: [{ code: 'A', label: 'Tốt' }] },
    elimination: { label: 'Loại', applied: false },
    result: { title: 'Kết quả', grade: 'A', label: 'Đạt' },
    warnings: [],
  };
  const semantic = buildSemanticModel(validated, {
    ...buildSyntheticReportContext({ definition: canonical, roundNo: 1 }),
    compliance_overview: policyOverview,
  });
  const section = semantic.sections.find((item) => item.type === 'compliance_overview');
  assert.equal(section.presentation.layout, 'table');
  assert.equal(section.chart.enabled, false);
  assert.equal(section.legend, null);
  assert.equal(section.result.grade, 'A');
  assert.deepEqual(section.data, [['LEGAL', '95'], ['Tổng', '95']]);
  assert.equal(semantic.styles.page_orientation, 'landscape');
});

test('RUN-20 workspace replaces the legacy textarea with an accessible three-pane versioned builder', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'tailwind.css'), 'utf8');
  const actions = require('../public/js/action-registry');

  for (const id of [
    'report-template-catalog', 'report-template-search', 'report-template-status',
    'report-template-version-select', 'report-template-tabs', 'report-template-component-tree',
    'report-template-a4-preview', 'report-template-properties', 'report-template-validation',
    'report-template-version-timeline', 'report-template-scope', 'report-template-preview-source',
    'report-template-preview-round', 'report-template-package-file', 'report-template-advanced-json',
    'report-template-policy-banner', 'report-template-live',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const tab of ['structure', 'data', 'presentation', 'preview', 'validation', 'versions', 'scope']) {
    assert.match(html, new RegExp(`data-report-template-tab="${tab}"`), tab);
  }
  assert.doesNotMatch(html, /id="rt-body"/);
  assert.doesNotMatch(html, /<option value="(?:INTERNAL|NCC)">/);
  for (const actionId of [
    'report_template.create_draft', 'report_template.save_draft', 'report_template.validate',
    'report_template.submit_review', 'report_template.publish', 'report_template.rollback',
    'report_template.preview', 'report_template.component_add', 'report_template.component_move',
    'report_template.export_package', 'report_template.import_package', 'report_template.advanced_json',
  ]) assert.ok(actions.getAction(actionId), actionId);
  assert.match(app, /syncReportTemplateUrl/);
  assert.match(app, /report_template_version_conflict/);
  assert.match(app, /source=synthetic/);
  assert.match(app, /reportTemplateDirty/);
  assert.match(app, /sandbox/);
  assert.match(app, /allowed_actions/);
  assert.match(css, /\.report-template-builder[^}]*grid-template-columns:\s*minmax\([^;]+\)\s+minmax\([^;]+\)\s+minmax\(/s);
  assert.match(css, /@media[^{}]*max-width[^{}]*\{[\s\S]*\.report-template-builder/);
});

test('PROMPT-10 report workspace reduces density and keeps actionable validation paths', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'tailwind.css'), 'utf8');

  assert.match(html, /id="report-template-catalog"[\s\S]*class="report-template-catalog-list"/);
  assert.doesNotMatch(html, /class="data-table report-template-catalog-table"/);
  assert.match(html, /id="report-template-readonly"[\s\S]*id="report-template-create-draft"[\s\S]*<\/div>/);

  const controls = {
    structure: 'report-template-builder-panel',
    data: 'report-template-builder-panel',
    presentation: 'report-template-builder-panel',
    preview: 'report-template-builder-panel',
    validation: 'report-template-validation',
    versions: 'report-template-version-timeline',
    scope: 'report-template-scope',
  };
  Object.entries(controls).forEach(([tab, panel]) => {
    assert.match(html, new RegExp(`id="report-template-tab-${tab}"[^>]+aria-controls="${panel}"`), tab);
  });
  for (const panel of new Set(Object.values(controls))) {
    assert.match(html, new RegExp(`id="${panel}"[^>]+role="tabpanel"`), panel);
  }
  for (const id of [
    'report-template-create-draft', 'report-template-preview-refresh', 'report-template-save-draft',
    'report-template-validate', 'report-template-submit-review', 'report-template-publish',
    'report-template-rollback',
  ]) assert.match(html, new RegExp(`id="${id}"[^>]+data-resource-action="true"`), id);

  assert.match(app, /builder\.dataset\.activeTab\s*=\s*active/);
  assert.match(app, /formatReportTemplateValidationIssue/);
  assert.match(app, /response\.data\?\.details/);
  assert.match(app, /focusReportTemplateValidationTarget/);
  assert.match(css, /\.report-template-builder\[data-active-tab=['"]preview['"]\]/);
  assert.match(css, /\.report-template-catalog-card/);
});
