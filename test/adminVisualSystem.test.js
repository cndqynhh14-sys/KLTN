'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('PROMPT-03 exposes one accessible visual primitive set for administration', () => {
  const css = read('src/tailwind.css');
  const html = read('public/index.html');
  const app = read('public/app.js');

  for (const selector of [
    '.admin-page-header',
    '.admin-breadcrumb',
    '.admin-grouped-subnav',
    '.admin-master-detail',
    '.admin-status-badge',
    '.admin-stepper',
    '.admin-metric-card',
    '.admin-sticky-action-bar',
    '.admin-state',
  ]) {
    assert.match(css, new RegExp(selector.replace('.', '\\.') + '\\s*[,{]'), selector);
  }

  assert.match(css, /--admin-navy:\s*var\(--sidebar-bg\)/);
  assert.match(css, /\.admin-[^{]+:focus-visible/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*#view-admin[^{]*\{[^}]*overflow-x:\s*(?:clip|hidden)/);
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*\.admin-sticky-action-bar[^{]*\{[^}]*safe-area-inset-bottom/);

  assert.match(html, /id="breadcrumb-items"[^>]*admin-breadcrumb/);
  assert.match(html, /id="view-admin"[\s\S]*admin-page-header/);
  assert.doesNotMatch(html, /id="admin-module-nav"/);
  assert.match(app, /id:\s*'admin-module-nav'[\s\S]{0,160}'data-navigation-surface':\s*'admin'/);
  assert.match(app, /className:\s*'admin-grouped-subnav desktop-admin-tree'/);
  assert.match(html, /authz-master-detail admin-master-detail/);
  assert.match(html, /question-wizard-steps admin-stepper/);
  assert.match(html, /(?:authz-sticky-save|question-sticky-actions|report-template-sticky-actions) admin-sticky-action-bar/);
  assert.match(html, /authz-admin-state admin-state/);

  assert.match(app, /function setDisabledReason\(/);
  assert.match(app, /className:\s*'question-overview-card admin-metric-card'/);
  assert.match(app, /'aria-label':\s*`[^`]*\$\{label\}/);
});

test('PROMPT-03 keeps the existing icon and behavior boundaries intact', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');

  assert.match(app, /function iconSvg\(name\)/);
  assert.doesNotMatch(app, /const\s+ADMIN_(?:COMPONENTS|PRIMITIVES|MENU)\s*=/);
  assert.match(html, /font-family:\s*'Be Vietnam Pro'/);
  assert.match(html, /--brand:\s*#c8102e/);
  assert.match(html, /--sidebar-bg:\s*#0f172a/);
});
