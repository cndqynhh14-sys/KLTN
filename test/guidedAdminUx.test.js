'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('QLCL-UX option 3 marks every requested admin workspace as one guided flow', () => {
  const html = read('public/index.html');

  for (const [id, workspace] of [
    ['authz-pane-users', 'users'],
    ['authz-pane-roles', 'roles'],
    ['admin-personnel-import', 'personnel-import'],
    ['authz-pane-scopes', 'data-scopes'],
    ['authz-pane-approvals', 'approval-assignments'],
    ['question-management-workspace-root', 'question-templates'],
    ['report-template-workspace', 'report-templates'],
    ['scoring-policy-workspace', 'scoring-policies'],
  ]) {
    assert.match(
      html,
      new RegExp(`id="${id}"(?=[^>]*guided-workspace)(?=[^>]*data-guided-workspace="${workspace}")`),
      workspace,
    );
  }

  assert.equal((html.match(/data-guided-stages/g) || []).length, 8);
  assert.match(html, /data-guided-workspace="data-scopes"[\s\S]*?<span>1<\/span>[\s\S]*?<strong>Chọn nhân sự<\/strong>[\s\S]*?<span>2<\/span>[\s\S]*?<strong>Chọn phạm vi<\/strong>[\s\S]*?<span>3<\/span>[\s\S]*?<strong>Kiểm tra &amp; lưu<\/strong>/);
  assert.match(html, /class="panel guided-authorization-panel" data-testid="authorization-admin"/);
});

test('QLCL-UX option 3 progressively discloses advanced filters and safety fields', () => {
  const html = read('public/index.html');

  for (const id of [
    'authz-user-advanced-filters',
    'authz-scope-advanced',
    'authz-approval-advanced',
    'question-catalog-filters-disclosure',
    'report-template-filters-disclosure',
  ]) assert.match(html, new RegExp(`<details[^>]*id="${id}"`), id);

  for (const lifecycle of ['question-lifecycle', 'report-template-lifecycle', 'scoring-policy-lifecycle']) {
    assert.match(html, new RegExp(`<details[^>]*class="[^"]*guided-lifecycle[^>]*>[\\s\\S]*?<ol id="${lifecycle}"`), lifecycle);
  }
});

test('QLCL-UX option 3 uses a shared responsive visual pattern without duplicating business logic', () => {
  const css = read('src/tailwind.css');
  const app = read('public/app.js');

  for (const selector of [
    '.guided-workspace',
    '.guided-stage-list',
    '.guided-stage-item',
    '.guided-disclosure',
    '.guided-sentence-form',
  ]) assert.match(css, new RegExp(selector.replace('.', '\\.') + '\\s*[,\\{]'), selector);

  assert.match(css, /\.guided-workspace \.authz-tab-step,[\s\S]*?\.guided-workspace \.authz-tab-copy small\s*\{[^}]*display:\s*none/);
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*?\.guided-stage-list/);
  assert.match(app, /function syncGuidedWorkspace\(/);
  assert.match(app, /syncGuidedWorkspace\('data-scopes'/);
  assert.match(app, /state\.tab === 'admin-data-scopes'[\s\S]{0,100}'Điều chỉnh phạm vi dữ liệu'/);
  assert.match(app, /btn-add-user'[\s\S]{0,80}nextTab !== 'users'/);
  assert.match(app, /data-authz-active[\s\S]{0,80}nextTab/);
  assert.doesNotMatch(app, /guidedWorkspace[\s\S]{0,120}(?:roleCode|roleName|permission)/i);
});
