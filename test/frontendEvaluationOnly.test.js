const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const navigation = require('../public/js/navigation-manifest');
const actions = require('../public/js/action-registry');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('frontend navigation and actions expose only the evaluation workflow', () => {
  const routeIds = new Set(navigation.NAVIGATION_MANIFEST.map((item) => item.id));
  const removedRoutes = [
    'ncc-input-dossiers',
    'ncc-input-dossier-form',
    'ncc-docs',
    'qc-warehouse',
    'lab',
    'kph',
    'admin-thresholds',
    'admin-upload-history',
  ];
  removedRoutes.forEach((id) => assert.equal(routeIds.has(id), false, `${id} must not be exposed`));

  const workspace = navigation.NAVIGATION_MANIFEST.find((item) => item.id === 'workspace');
  const approvals = navigation.NAVIGATION_MANIFEST.find((item) => item.id === 'approvals');
  assert.deepEqual(workspace.permissions, ['EVALUATION.READ']);
  assert.deepEqual(approvals.permissions, [
    'EVALUATION.APPROVE_LEAD',
    'EVALUATION.APPROVE_TBP',
    'EVALUATION.APPROVE_GDK',
  ]);
  assert.ok(navigation.NAVIGATION_MANIFEST.every((item) =>
    item.permissions.every((permission) => !permission.startsWith('INPUT_DOSSIER.'))));

  assert.ok(actions.ACTION_REGISTRY.every((item) => !item.action_id.startsWith('dossier.')));
  assert.ok(actions.ACTION_REGISTRY.every((item) => !item.action_id.startsWith('upload.')));
  assert.ok(actions.ACTION_REGISTRY.every((item) => item.entity !== 'INPUT_DOSSIER'));
  assert.ok(Object.keys(actions.STATIC_ACTION_BINDINGS).every((id) => !id.includes('input-dossier')));
});

test('frontend source contains no input-dossier page, state or API integration', () => {
  const app = source('public/app.js');
  const html = source('public/index.html');
  const state = source('public/js/state.js');

  for (const [name, value] of Object.entries({ app, html, state })) {
    assert.doesNotMatch(value, /inputDossier|input-dossier|INPUT_DOSSIER|ncc-input-dossier/i, name);
  }

  assert.doesNotMatch(app, /\/dashboard\/(?:ncc-docs|lab-tests|kph-incidents|qc-warehouse)/);
  assert.doesNotMatch(app, /\/uploads(?:\?|\/)|\/admin\/thresholds|renderUploads|renderThresholdWorkspace/);
  assert.doesNotMatch(html, /id="view-(?:ncc-docs|lab|kph|qc)"/);
  assert.doesNotMatch(html, /admin-uploads-tbody|threshold-workspace|admin-thresholds-tbody/);
  assert.match(app, /params\.set\('module', 'EVALUATION'\)/);
  assert.match(app, /supplier_evaluations/);
});
