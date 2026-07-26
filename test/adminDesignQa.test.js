'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('PROMPT-13 keeps the question workspace actions reachable with large banks', () => {
  const html = read('public/index.html');
  const css = read('src/tailwind.css');

  assert.match(html, /class="table-scroll question-items-scroll"[^>]*>[\s\S]*class="data-table question-items-table"/);
  assert.match(css, /\.question-items-scroll\s*\{[^}]*max-height:\s*min\([^;]+;[^}]*overflow-y:\s*auto;/);
  assert.match(css, /\.question-items-scroll\s+\.question-items-table\s*\{[^}]*margin:\s*0;/);
});

test('PROMPT-13 keeps the question catalog and lifecycle legible in constrained workspaces', () => {
  const css = read('src/tailwind.css');

  assert.match(css, /\.question-catalog-table\s+thead\s*\{[^}]*position:\s*absolute;[^}]*clip:/);
  assert.match(css, /\.question-catalog-table\s+tr\s*\{[^}]*display:\s*grid;/);
  assert.match(css, /\.business-config-lifecycle\s*>\s*li\s*\{[^}]*min-width:\s*0;/);
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*\.business-config-lifecycle\s*>\s*li\s*\{[^}]*min-width:\s*96px;/);
});

test('administration modules are nested under the primary desktop navigation instead of a second content rail', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const css = read('src/tailwind.css');

  assert.doesNotMatch(html, /id="view-admin"[\s\S]{0,600}id="admin-module-nav"/);
  assert.match(app, /function renderDesktopAdminNavigation\(host\)/);
  assert.match(app, /className:\s*'admin-grouped-subnav desktop-admin-tree'/);
  assert.match(css, /\.desktop-admin-tree\s*\{[^}]*border-left:/);
  assert.match(css, /#view-admin:not\(\.hidden\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('desktop administration tree keeps setup groups and the selected module visually distinct', () => {
  const css = read('src/tailwind.css');

  assert.match(css, /\.desktop-admin-tree \.admin-navigation-group\s*\{[^}]*border-top:/);
  assert.match(css, /\.desktop-admin-tree \.desktop-admin-route\.active\s*\{[^}]*font-weight:\s*800;[^}]*box-shadow:\s*inset 3px 0 var\(--admin-brand\)/s);
  assert.match(css, /\.desktop-admin-tree \.desktop-admin-route:focus-visible\s*\{[^}]*outline:/);
});

test('PROMPT-13 UAT covers the complete administration route matrix at both target viewports', () => {
  const uat = read('uat/scenarios/smoke.spec.js');

  for (const route of [
    '/admin',
    '/admin/users',
    '/admin/roles',
    '/admin/personnel-import',
    '/admin/data-scopes',
    '/admin/approval-assignments',
    '/admin/question-templates',
    '/admin/report-templates',
    '/admin/scoring-policies',
    '/admin/system-logs',
  ]) {
    assert.match(uat, new RegExp(`['\"]${route.replace('/', '\\/')}['\"]`), route);
  }

  assert.match(uat, /\{ name: 'desktop-1440x1024', width: 1440, height: 1024 \}/);
  assert.match(uat, /\{ name: 'mobile-390x844', width: 390, height: 844 \}/);
  assert.match(uat, /`admin-route-matrix-\$\{viewport\.name\}-\$\{slug\}\.png`/);
  assert.match(uat, /documentElement\.scrollWidth\s*<=\s*documentElement\.clientWidth/);
});
