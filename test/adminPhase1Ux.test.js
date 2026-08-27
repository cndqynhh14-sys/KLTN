'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Phase 1 exposes accessible personnel and role drawers', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');

  assert.match(html, /id="authz-user-detail"[^>]*authz-user-drawer[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="authz-role-form"[^>]*authz-role-drawer[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="authz-user-detail-backdrop"/);
  assert.match(html, /id="authz-role-form-backdrop"/);
  assert.match(app, /async function openAuthzUserEditor\(userId, trigger = null\)/);
  assert.match(app, /async function openAuthzRoleEditor\(roleCode, trigger = null\)/);
  assert.match(app, /function trapAuthzDrawerFocus\(event\)/);
  assert.match(app, /\/admin\/authorization\/users\/\$\{encodeURIComponent\(userId\)\}/);
});

test('Phase 2 keeps role search and delegates history filtering and pagination to the server', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');

  for (const id of [
    'authz-role-search',
    'authz-role-status-filter',
    'authz-history-date-from',
    'authz-history-date-to',
    'authz-history-prev',
    'authz-history-next',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);

  assert.match(app, /const AUTHZ_HISTORY_PAGE_SIZE = 20/);
  assert.match(app, /function authzHistoryQuery\(\)/);
  assert.match(app, /pageSize: String\(AUTHZ_HISTORY_PAGE_SIZE\)/);
  assert.match(app, /from: \$\('authz-history-date-from'\)/);
  assert.match(app, /to: \$\('authz-history-date-to'\)/);
  assert.match(app, /\/admin\/authorization\/history\?\$\{authzHistoryQuery\(\)\.toString\(\)\}/);
  assert.doesNotMatch(app, /filteredRows\.slice\(pageStart, pageStart \+ AUTHZ_HISTORY_PAGE_SIZE\)/);
});

test('Phase 1 drawers and history remain responsive', () => {
  const css = read('src/tailwind.css');

  assert.match(css, /#authz-pane-users #authz-user-detail\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?max-height:\s*100dvh;/);
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?#authz-pane-users #authz-user-detail\s*\{[^}]*width:\s*100vw;/);
  assert.match(css, /\.authz-history-table tbody\s*\{[^}]*display:\s*grid;/);
  assert.match(css, /\.authz-pagination\s*\{[^}]*display:\s*flex;/);
});
