'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const navigation = require('../public/js/navigation-manifest');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('supplier quality navigation keeps forms and scoring contextual', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const evaluation = navigation.NAVIGATION_MANIFEST.find((item) => item.id === 'evaluations');
  const create = navigation.NAVIGATION_MANIFEST.find((item) => item.id === 'evaluation-new');
  const scoring = navigation.NAVIGATION_MANIFEST.find((item) => item.id === 'scoring');

  assert.equal(evaluation.contextual, false);
  assert.equal(create.contextual, true);
  assert.equal(scoring.contextual, true);
  assert.equal(create.parent, 'evaluations');
  assert.equal(scoring.parent, 'evaluations');
  assert.match(html, /data-contextual-navigation="evaluation-new"/);
  assert.doesNotMatch(html, /class="assessment-business-nav"/);
  assert.match(app, /applyContextualNavigationVisibility/);
});

test('supplier workflow and mobile order are derived from manifest metadata', () => {
  const allCapabilities = [...new Set(navigation.NAVIGATION_MANIFEST.flatMap((item) => item.permissions))];
  const visible = navigation.visibleNavigation(allCapabilities);
  const supplierItems = visible.filter((item) => item.parent === 'supplier-business').map((item) => item.id);
  assert.deepEqual(supplierItems, ['evaluations', 'suppliers']);

  const mobile = navigation.mobilePrimary(allCapabilities);
  assert.deepEqual(mobile.map((item) => item.id), ['workspace', 'approvals', 'evaluations', 'suppliers']);
  assert.ok(mobile.length <= 4);
  assert.match(read('public/index.html'), /id="mobile-more-navigation"[^>]*data-navigation-surface="mobile-more"/);
});

test('global period picker is limited by manifest route permission and path', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const periodTabs = navigation.NAVIGATION_MANIFEST
    .filter((item) => item.permissions.includes('DASHBOARD.READ') && item.route?.startsWith('/dashboard'))
    .map((item) => item.id);

  assert.deepEqual(periodTabs, ['overview']);
  assert.match(html, /id="period-controls"[\s\S]*>Kỳ báo cáo<\/span>[\s\S]*id="month-picker"/);
  assert.match(app, /item\.permissions\.includes\('DASHBOARD\.READ'\) && item\.route\.startsWith\('\/dashboard'\)/);
  assert.match(app, /function shouldShowGlobalPeriod\(\)/);
  assert.match(app, /periodControls\.classList\.toggle\('hidden', !\(routeAllowed && shouldShowGlobalPeriod\(\)\)\)/);
});

test('admin desktop, dashboard and mobile trees consume grouped manifest navigation', () => {
  const app = read('public/app.js');
  const html = read('public/index.html');
  assert.match(app, /NAVIGATION\.groupedNavigationFor\('admin'/);
  assert.doesNotMatch(app, /const\s+ADMIN_(?:MENU|GROUPS|ROUTES)\s*=/);
  assert.match(app, /function renderDesktopAdminNavigation\(host\)/);
  assert.match(app, /item\.id === 'admin'[\s\S]{0,200}renderDesktopAdminNavigation\(host\)/);
  assert.doesNotMatch(app, /adminHeader\.after\(moduleNav\)/);
  assert.doesNotMatch(html, /id="admin-module-nav"/);
  assert.match(app, /adminRouteConfig\(state\.tab\)/);
  assert.match(app, /selectAuthzTab\(config\.pane/);
  assert.match(app, /mobileNavigationGroupState/);
  assert.match(app, /data-navigation-group-toggle/);
  assert.match(app, /'aria-expanded'/);
  assert.match(app, /'aria-controls'/);
  assert.match(html, /id="admin-personnel-import"[^>]*data-personnel-import-workflow/);
  assert.match(html, /id="scoring-policy-workspace"[^>]*data-business-config-workspace="scoring-policies"/);
  assert.match(html, /id="scoring-policy-lifecycle"[^>]*business-config-lifecycle/);
});

test('RUN-30 consolidates supplier analytics into the single statistics dashboard route', () => {
  const allCapabilities = [...new Set(navigation.NAVIGATION_MANIFEST.flatMap((item) => item.permissions))];
  const dashboardItems = navigation.NAVIGATION_MANIFEST.filter((item) => item.route?.startsWith('/dashboard'));

  assert.deepEqual(dashboardItems.map((item) => item.id), ['overview']);
  assert.deepEqual(
    navigation.sidebarNavigation(allCapabilities)
      .filter((item) => item.parent === 'analytics')
      .map((item) => item.id),
    ['overview'],
  );
  assert.equal(navigation.resolveRoute('/dashboard/ncc-evaluations', allCapabilities).status, 'not_found');
  assert.deepEqual(navigation.moduleNavigationFor('overview', allCapabilities).map((item) => item.id), ['overview']);
  assert.match(read('public/app.js'), /NAVIGATION\.sidebarNavigation/);
  assert.doesNotMatch(read('public/index.html'), /id="view-ncc-eval"/);
});
