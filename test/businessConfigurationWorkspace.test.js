'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('PROMPT-08 maps backend lifecycle, read-only state and action envelopes without role labels', () => {
  const workspace = require('../public/js/business-configuration-workspace');

  assert.deepEqual(workspace.lifecycleFor('DRAFT').map((step) => step.state), [
    'complete', 'current', 'pending', 'pending', 'pending',
  ]);
  assert.deepEqual(workspace.lifecycleFor('IN_REVIEW').map((step) => step.state), [
    'complete', 'complete', 'complete', 'current', 'pending',
  ]);
  assert.deepEqual(workspace.lifecycleFor('PUBLISHED').map((step) => step.state), [
    'complete', 'complete', 'complete', 'complete', 'current',
  ]);
  assert.equal(workspace.versionState({ status: 'PUBLISHED' }).readOnly, true);
  assert.equal(workspace.versionState({ status: 'RETIRED' }).readOnly, true);
  assert.equal(workspace.versionState({ status: 'DRAFT' }).readOnly, false);

  assert.deepEqual(workspace.actionState({
    allowed_actions: ['scoring_policy.validate'], disabled_reasons: {},
  }, 'scoring_policy.validate'), { state: 'enabled', reason: '' });
  assert.deepEqual(workspace.actionState({
    allowed_actions: [], disabled_reasons: { 'scoring_policy.publish': 'forbidden_permission' },
  }, 'scoring_policy.publish'), { state: 'hidden', reason: 'forbidden_permission' });
  assert.deepEqual(workspace.actionState({
    allowed_actions: [], disabled_reasons: { 'scoring_policy.publish': 'scoring_policy_publish_disabled' },
  }, 'scoring_policy.publish'), { state: 'disabled', reason: 'scoring_policy_publish_disabled' });
  assert.deepEqual(workspace.actionState({}, 'scoring_policy.publish'), { state: 'hidden', reason: 'action_unavailable' });

  assert.deepEqual(workspace.surfaceState({ loading: true }), { state: 'loading', message: 'Đang tải dữ liệu…' });
  assert.deepEqual(workspace.surfaceState({ status: 403 }), { state: 'forbidden', message: 'Bạn không có quyền mở workspace này.' });
  assert.deepEqual(workspace.surfaceState({ status: 409 }), { state: 'conflict', message: 'Phiên bản đã thay đổi. Hãy tải lại trước khi tiếp tục.' });
  assert.equal(
    workspace.workspaceHash('/admin/scoring-policies', { policy: 'LEGACY_RULES', version: 7, tab: 'checks' }),
    '#/admin/scoring-policies?policy=LEGACY_RULES&version=7&tab=checks',
  );
});

test('PROMPT-08 exposes one shared vanilla workspace foundation across retained business modules', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const css = read('src/tailwind.css');

  assert.match(html, /js\/business-configuration-workspace\.js/);
  for (const module of ['question-templates', 'report-templates', 'scoring-policies']) {
    assert.match(html, new RegExp(`data-business-config-workspace="${module}"`), module);
  }
  assert.doesNotMatch(html, /admin-scoring-policies-placeholder/);
  assert.match(html, /id="scoring-policy-workspace"/);
  assert.match(html, /id="question-lifecycle"[^>]*business-config-lifecycle/);
  assert.match(html, /id="report-template-lifecycle"[^>]*business-config-lifecycle/);
  assert.match(html, /id="scoring-policy-lifecycle"[^>]*business-config-lifecycle/);

  for (const selector of [
    '.business-config-workspace',
    '.business-config-shell',
    '.business-config-catalog',
    '.business-config-version',
    '.business-config-lifecycle',
    '.business-config-tabs',
    '.business-config-impact',
    '.business-config-actions',
  ]) assert.match(css, new RegExp(selector.replace('.', '\\.') + '\\s*[,\\{]'), selector);
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*\.business-config-shell/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.business-config-workspace/);

  assert.match(app, /const BUSINESS_CONFIG = window\.QLCL_BUSINESS_CONFIG/);
  assert.match(app, /function renderBusinessConfigLifecycle\(/);
  assert.match(app, /function confirmBusinessConfigRouteLeave\(/);
  assert.match(app, /async function loadScoringPolicyWorkspace\(/);
  assert.doesNotMatch(app, /function renderThresholdWorkspace\(/);
  assert.doesNotMatch(app, /businessConfig[\s\S]{0,120}role(?:Code|Label|Name)/i);
});

test('PROMPT-08 registers separate scoring lifecycle actions and omits retired threshold actions', () => {
  const actions = require('../public/js/action-registry');
  const scoringIds = [
    'scoring_policy.preview',
    'scoring_policy.validate',
    'scoring_policy.save_draft',
    'scoring_policy.submit_review',
    'scoring_policy.publish',
    'scoring_policy.rollback',
    'scoring_policy.create_draft',
    'scoring_policy.tab_open',
  ];
  scoringIds.forEach((id) => assert.ok(actions.getAction(id), id));
  assert.equal(actions.getAction('scoring_policy.publish').permission, 'SCORING_POLICY.PUBLISH');
  assert.equal(actions.getAction('scoring_policy.save_draft').allowed_statuses[0], 'DRAFT');
  assert.equal(actions.getAction('scoring_policy.submit_review').action_id, 'scoring_policy.submit_review');
  assert.equal(actions.getAction('scoring_policy.publish').action_id, 'scoring_policy.publish');
  assert.notEqual(actions.getAction('scoring_policy.submit_review'), actions.getAction('scoring_policy.publish'));
  assert.equal(actions.getAction('threshold.read'), null);
});

test('PROMPT-11 exposes the complete scoring-policy workspace without frontend scoring logic', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const route = read('server/routes/scoringPolicies.js');
  const actions = require('../public/js/action-registry');

  const tabs = [
    ['overview', 'Tổng quan'],
    ['grade-scale', 'Thang điểm'],
    ['bands', 'Khoảng xếp loại'],
    ['penalties', 'Điểm trừ'],
    ['simulation', 'Kiểm thử'],
    ['impact', 'Tác động'],
    ['versions', 'Lịch sử'],
  ];
  for (const [id, label] of tabs) {
    assert.match(html, new RegExp(`data-scoring-policy-tab="${id}"[^>]*>${label}<`), id);
    assert.match(html, new RegExp(`data-scoring-policy-pane="${id}"`), id);
  }
  assert.match(app, /const SCORING_POLICY_TABS = \['overview', 'grade-scale', 'bands', 'penalties', 'simulation', 'impact', 'versions'\]/);
  assert.match(app, /SCORING_POLICY_SYNTHETIC_FIXTURES/);
  assert.match(app, /\/simulate`/);
  assert.match(app, /\/impact`/);
  assert.match(app, /renderScoringPolicySimulationResult/);
  assert.match(app, /renderScoringPolicyImpactResult/);
  assert.doesNotMatch(app, /function\s+(?:calculate|classify|score)ScoringPolicy/i);

  for (const actionId of ['scoring_policy.simulate', 'scoring_policy.impact']) {
    assert.ok(actions.getAction(actionId), actionId);
    assert.equal(actions.getAction(actionId).permission, 'SCORING_POLICY.MANAGE');
    assert.match(route, new RegExp(`'${actionId.replace('.', '\\.')}'`));
  }
  assert.equal(actions.getAction('scoring_policy.publish').permission, 'SCORING_POLICY.PUBLISH');
  assert.equal(actions.getAction('scoring_policy.rollback').permission, 'SCORING_POLICY.PUBLISH');
});
