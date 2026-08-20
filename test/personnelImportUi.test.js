'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const actions = require('../public/js/action-registry');
const navigation = require('../public/js/navigation-manifest');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const html = read('public/index.html');
const app = read('public/app.js');
const css = read('src/tailwind.css');

test('PROMPT-07 exposes the guarded four-step personnel import route', () => {
  const route = navigation.NAVIGATION_MANIFEST.find((item) => item.id === 'admin-personnel-import');
  assert.equal(route.route, '/admin/personnel-import');
  assert.deepEqual(route.permissions, ['USER.MANAGE']);
  assert.equal(route.admin_module, 'personnel-import');

  assert.match(html, /id="admin-personnel-import"[^>]*data-personnel-import-workflow/);
  assert.doesNotMatch(html, /id="admin-personnel-import-placeholder"/);
  assert.match(html, /id="personnel-import-steps"[^>]*admin-stepper/);
  for (const step of ['upload', 'columns', 'roles', 'review']) {
    assert.match(html, new RegExp(`data-personnel-step="${step}"`));
  }
  for (const id of [
    'personnel-import-download-template',
    'personnel-import-open-example',
    'personnel-import-file',
    'personnel-import-column-mapping',
    'personnel-import-role-mapping',
    'personnel-import-preview-tbody',
    'personnel-import-metrics',
    'personnel-import-reason',
    'personnel-import-confirmation',
    'personnel-import-commit',
    'personnel-import-success',
    'personnel-import-return-users',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
});

test('PROMPT-07 catalogues every personnel import CTA and preserves commit boundaries', () => {
  assert.equal(actions.ACTION_VERSION, 15);
  const expected = {
    'personnel_import.download_template': { mutation: false },
    'personnel_import.open_example': { mutation: false },
    'personnel_import.upload_preview': { mutation: false },
    'personnel_import.mapping_continue': { mutation: false },
    'personnel_import.mapping_back': { mutation: false },
    'personnel_import.validate': { mutation: false },
    'personnel_import.retry': { mutation: false },
    'personnel_import.commit': { mutation: true },
    'personnel_import.cancel': { mutation: false },
    'personnel_import.return_users': { mutation: false },
  };
  for (const [id, contract] of Object.entries(expected)) {
    const action = actions.getAction(id);
    assert.ok(action, id);
    assert.equal(action.permission, 'USER.MANAGE', id);
    assert.equal(action.entity, 'PERSONNEL_IMPORT', id);
    assert.equal(action.mutation, contract.mutation, id);
  }
  const commit = actions.getAction('personnel_import.commit');
  assert.equal(commit.reason.required, true);
  assert.equal(commit.confirm.required, true);
  assert.equal(commit.idempotency.required, true);
  assert.equal(commit.event, 'personnel.import.committed');
});

test('PROMPT-07 uses the real API, safe DOM seams and an in-memory resumable batch', () => {
  const workflow = app.match(/\/\/ ============ Personnel import workflow \(PROMPT-07\) ============[\s\S]*?\/\/ ============ Authorization administration/);
  assert.ok(workflow, 'personnel import workflow section must remain discoverable');
  const source = workflow[0];

  for (const endpoint of [
    '/admin/authorization/personnel-import/template.xlsx',
    '/admin/authorization/personnel-import/example.xlsx',
    '/admin/authorization/personnel-import/batches/preview',
    '/admin/authorization/personnel-import/batches/',
    '/admin/authorization/catalog',
  ]) assert.match(source, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), endpoint);

  assert.match(source, /expectedSourceChecksum/);
  assert.match(source, /expectedBatchChecksum/);
  assert.match(source, /requiredConfirmation/);
  assert.match(source, /withActionRequestContext\(\{[\s\S]*actionId:\s*'personnel_import\.commit'/);
  assert.match(source, /personnelImportCommitInFlight/);
  assert.match(source, /crypto\.randomUUID/);
  assert.match(source, /textContent\s*=/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.doesNotMatch(source, /personnelImportState\.file\s*=/);
  assert.match(source, /window\.addEventListener\('beforeunload'/);
  assert.match(source, /confirmPersonnelImportRouteLeave/);
});

test('PROMPT-07 is responsive and keeps the commit action reachable on mobile', () => {
  for (const selector of [
    '.personnel-import-workflow',
    '.personnel-import-file-card',
    '.personnel-import-layout',
    '.personnel-import-mapping-grid',
    '.personnel-import-preview',
    '.personnel-import-summary',
  ]) assert.match(css, new RegExp(selector.replace('.', '\\.') + '\\s*[{,]'), selector);

  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*\.personnel-import-layout[^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /body\.sidebar-collapsed\s+\.desktop-admin-tree\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(html, /id="view-admin"[\s\S]{0,600}id="admin-module-nav"/);
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*\.personnel-import-sticky[^{]*\{[^}]*position:\s*sticky/);
  assert.match(css, /\.personnel-import-table-scroll[^{]*\{[^}]*overflow-x:\s*auto/);
});
