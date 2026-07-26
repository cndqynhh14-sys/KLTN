'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PERMISSIONS } = require('../server/authorization/permissionCatalog');
const navigation = require('../public/js/navigation-manifest');
const { generateMenuActionMatrix } = require('../scripts/generate-menu-action-matrix');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('navigation manifest is complete, unique and permission-safe', () => {
  const errors = navigation.validateManifest();
  assert.deepEqual(errors, []);
  assert.equal(navigation.NAVIGATION_VERSION, 8);

  const requiredFields = [
    'id', 'parent', 'route', 'view', 'label', 'short_label', 'description',
    'icon', 'order', 'active_match', 'permissions', 'feature_flag',
    'mobile_priority', 'breadcrumbs', 'contextual', 'sidebar', 'sidebar_active',
    'admin_module', 'admin_pane', 'version',
  ];
  const permissionValues = new Set(Object.values(PERMISSIONS));
  for (const item of navigation.NAVIGATION_MANIFEST) {
    for (const field of requiredFields) assert.ok(Object.hasOwn(item, field), `${item.id}.${field}`);
    assert.notEqual(item.label, item.permissions[0], `${item.id} label must not be a permission key`);
    for (const permission of item.permissions) assert.ok(permissionValues.has(permission), `${item.id}:${permission}`);
  }

  const ids = navigation.NAVIGATION_MANIFEST.map((item) => item.id);
  const routes = navigation.NAVIGATION_MANIFEST.filter((item) => item.route).map((item) => item.route);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(routes).size, routes.length);
});

test('capability and feature filtering hides empty parents and limits mobile primary navigation', () => {
  const evaluationOnly = navigation.visibleNavigation(['EVALUATION.READ']);
  assert.ok(evaluationOnly.some((item) => item.id === 'supplier-business'));
  assert.ok(evaluationOnly.some((item) => item.id === 'evaluations'));
  assert.ok(!evaluationOnly.some((item) => item.id === 'administration'));

  const noCapabilities = navigation.visibleNavigation([]);
  assert.ok(!noCapabilities.some((item) => item.kind === 'section'));

  const sysAdmin = navigation.visibleNavigation(Object.values(PERMISSIONS));
  assert.ok(!sysAdmin.some((item) => item.id === 'admin-uat-runs'));
  assert.ok(sysAdmin.some((item) => item.id === 'admin-users'));

  const mobilePrimary = navigation.mobilePrimary(Object.values(PERMISSIONS));
  assert.ok(mobilePrimary.length <= 4);
  assert.ok(mobilePrimary.every((item) => !item.contextual && item.route));
});

test('route resolver preserves bookmarks and fails closed before a loader is selected', () => {
  const allPermissions = Object.values(PERMISSIONS);
  const bookmarks = {
    '/workspace': 'workspace',
    '/dashboard': 'overview',
    '/approvals': 'approvals',
    '/evaluations': 'evaluations',
    '/suppliers': 'suppliers',
    '/reports': 'reports',
    '/dashboard/ncc-evaluations': 'ncc-eval',
    '/admin/users': 'admin-users',
    '/admin/roles': 'admin-roles',
    '/admin/personnel-import': 'admin-personnel-import',
    '/admin/data-scopes': 'admin-data-scopes',
    '/admin/approval-assignments': 'admin-approval-assignments',
    '/admin/scoring-policies': 'admin-scoring-policies',
    '/admin/system-logs': 'admin-system-logs',
  };
  for (const [route, id] of Object.entries(bookmarks)) {
    const result = navigation.resolveRoute(route, allPermissions);
    assert.equal(result.status, 'allowed', route);
    assert.equal(result.item.id, id, route);
  }

  assert.equal(navigation.resolveRoute('/admin/users', ['EVALUATION.READ']).status, 'denied');
  assert.equal(navigation.resolveRoute('/admin/uat-runs', allPermissions).status, 'feature_off');
  assert.equal(navigation.resolveRoute('/missing', allPermissions).status, 'not_found');
});

test('administration IA groups routes in the required order with stable guards and deep-link metadata', () => {
  const allPermissions = Object.values(PERMISSIONS);
  const groups = navigation.groupedNavigationFor('admin', allPermissions);
  assert.deepEqual(groups.map(({ group }) => group.label), [
    'Nhân sự & phân quyền',
    'Cấu hình nghiệp vụ',
    'Vận hành hệ thống',
  ]);
  assert.deepEqual(groups.map(({ items }) => items.map((item) => item.id)), [
    ['admin-users', 'admin-roles', 'admin-personnel-import', 'admin-data-scopes', 'admin-approval-assignments'],
    ['admin-question-templates', 'admin-report-templates', 'admin-scoring-policies'],
    ['admin-system-logs'],
  ]);

  const expected = {
    'admin-users': ['/admin/users', 'USER.MANAGE', 'authorization', 'users'],
    'admin-roles': ['/admin/roles', 'USER.MANAGE', 'authorization', 'roles'],
    'admin-personnel-import': ['/admin/personnel-import', 'USER.MANAGE', 'personnel-import', null],
    'admin-data-scopes': ['/admin/data-scopes', 'USER.MANAGE', 'authorization', 'scopes'],
    'admin-approval-assignments': ['/admin/approval-assignments', 'USER.MANAGE', 'authorization', 'approvals'],
    'admin-question-templates': ['/admin/question-templates', 'QUESTION_TEMPLATE.MANAGE', 'question-templates', null],
    'admin-report-templates': ['/admin/report-templates', 'REPORT_TEMPLATE.MANAGE', 'report-templates', null],
    'admin-scoring-policies': ['/admin/scoring-policies', 'SCORING_POLICY.MANAGE', 'scoring-policies', null],
    'admin-system-logs': ['/admin/system-logs', 'AUDIT.READ', 'system-logs', null],
  };
  for (const [id, [route, guard, module, pane]] of Object.entries(expected)) {
    const item = navigation.NAVIGATION_MANIFEST.find((candidate) => candidate.id === id);
    assert.equal(item.route, route, id);
    assert.deepEqual(item.permissions, [guard], id);
    assert.equal(item.admin_module, module, id);
    assert.equal(item.admin_pane, pane, id);
    assert.deepEqual(item.breadcrumbs.slice(0, 2), ['administration', 'admin'], id);
    assert.equal(navigation.resolveRoute(route, [guard]).status, 'allowed', id);
    assert.equal(navigation.resolveRoute(route, []).status, 'denied', id);
  }
  assert.deepEqual(
    navigation.NAVIGATION_MANIFEST.find((item) => item.id === 'admin-scoring-policies').permissions,
    ['SCORING_POLICY.MANAGE'],
  );

  const withUat = navigation.groupedNavigationFor('admin', allPermissions, { ADMIN_UAT_RUNS: true });
  assert.equal(withUat.at(-1).items.at(-1).id, 'admin-uat-runs');
  assert.ok(!groups.flatMap(({ items }) => items).some((item) => item.id === 'admin-uat-runs'));
});

test('enabled routes have views and breadcrumbs sourced from the same manifest', () => {
  for (const item of navigation.NAVIGATION_MANIFEST) {
    if (!item.route || !navigation.isFeatureEnabled(item)) continue;
    assert.ok(item.view, `${item.id} view`);
    assert.match(html, new RegExp(`id=["']${item.view}["']`), `${item.id}:${item.view}`);
    const crumbs = navigation.breadcrumbsFor(item.id);
    assert.equal(crumbs.at(-1).id, item.id);
    assert.equal(crumbs.at(-1).label, item.label);
  }
});

test('desktop, mobile, module navigation and route registry use manifest hosts only', () => {
  assert.match(html, /id="desktop-navigation"[^>]*data-navigation-surface="desktop"/);
  assert.match(html, /id="mobile-primary-navigation"[^>]*data-navigation-surface="mobile-primary"/);
  assert.match(html, /id="mobile-more-navigation"[^>]*data-navigation-surface="mobile-more"/);
  assert.match(html, /id="module-navigation"[^>]*data-navigation-surface="module"/);
  assert.doesNotMatch(html, /id="admin-module-nav"/);
  assert.match(app, /id:\s*'admin-module-nav'/);
  assert.match(app, /data-navigation-surface':\s*'admin'/);
  assert.doesNotMatch(html, /class="assessment-business-nav"/);
  assert.doesNotMatch(html, /class="quick-link-grid"/);
  const reportsMarkup = html.slice(html.indexOf('id="view-reports"'), html.indexOf('id="view-overview"'));
  assert.doesNotMatch(reportsMarkup, /btn-open-upload-full|upload-report|Tải báo cáo lên/);
  assert.doesNotMatch(app, /const\s+ROUTES\s*=/);
  assert.doesNotMatch(app, /const\s+TAB_LABELS\s*=/);
  assert.doesNotMatch(app, /applyAuditNavigationLabels/);
  assert.match(app, /ROUTE_REGISTRY/);
  assert.match(app, /resolveAuthorizedRoute/);
  assert.match(app, /renderNavigationSurfaces/);
  assert.ok(html.indexOf('/qlcl/js/navigation-manifest.js') < html.indexOf('/qlcl/app.js'));
});

test('menu action matrix is reproducibly generated and reports no enabled orphans', () => {
  const generated = generateMenuActionMatrix({ root });
  const stored = fs.readFileSync(path.join(root, 'docs', 'menu-action-matrix.md'), 'utf8');
  assert.equal(stored.replace(/\r\n/g, '\n'), generated.replace(/\r\n/g, '\n'));
  assert.match(generated, /Navigation manifest version: `8`/);
  assert.match(generated, /Enabled orphan routes: `0`/);
  assert.match(generated, /Enabled orphan views: `0`/);
  assert.match(generated, /Unknown permissions: `0`/);
  assert.match(generated, /Manifest contract test gaps: `0`/);
});
