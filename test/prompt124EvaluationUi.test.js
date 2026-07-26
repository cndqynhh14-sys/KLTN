'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const navigation = require('../public/js/navigation-manifest');
const actions = require('../public/js/action-registry');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('PROMPT-124 evaluation module owns the exact four business routes', () => {
  const expected = [
    ['evaluations', 'Phiếu đánh giá', '/evaluations'],
    ['evaluation-new', 'Tạo phiếu đánh giá', '/evaluations/new'],
    ['scoring', 'Chấm điểm', '/evaluations/scoring'],
    ['reports', 'Báo cáo', '/reports'],
  ];
  const actual = expected.map(([id]) => {
    const item = navigation.NAVIGATION_MANIFEST.find((candidate) => candidate.id === id);
    return [item.id, item.label, item.route];
  });
  assert.deepEqual(actual, expected);
  const reports = navigation.NAVIGATION_MANIFEST.find((item) => item.id === 'reports');
  assert.equal(reports.parent, 'evaluations');
  assert.equal(reports.contextual, true);
  const capabilities = ['EVALUATION.READ', 'EVALUATION.CREATE', 'EVALUATION.SCORE', 'REPORT.READ'];
  for (const activeId of expected.map(([id]) => id)) {
    assert.deepEqual(
      navigation.moduleNavigationFor(activeId, capabilities).map((item) => [item.label, item.route]),
      expected.map(([, label, route]) => [label, route]),
      activeId
    );
  }
});

test('PROMPT-124 canonical scoring route wins exact matching and legacy bookmarks redirect', () => {
  const capabilities = ['EVALUATION.READ', 'EVALUATION.SCORE'];
  const canonical = navigation.resolveRoute('/evaluations/scoring?ticket=DG-001', capabilities);
  assert.equal(canonical.status, 'allowed');
  assert.equal(canonical.item.id, 'scoring');
  assert.equal(canonical.canonical_route, '/evaluations/scoring?ticket=DG-001');

  const legacy = navigation.resolveRoute('/scoring?ticket=DG-001', capabilities);
  assert.equal(legacy.status, 'allowed');
  assert.equal(legacy.item.id, 'scoring');
  assert.equal(legacy.redirected_from, '/scoring?ticket=DG-001');
  assert.equal(legacy.canonical_route, '/evaluations/scoring?ticket=DG-001');
});

test('PROMPT-124 action policy keeps only backend-allowed actions for status and context', () => {
  const policyPath = path.join(root, 'public', 'js', 'evaluation-action-policy.js');
  assert.equal(fs.existsSync(policyPath), true, 'centralized evaluation action policy must exist');
  const policy = require(policyPath);

  const draft = policy.getEligibleEvaluationActionIds({
    status: 'Khởi tạo',
    allowed_actions: ['view', 'edit', 'score', 'delete'],
  });
  assert.deepEqual(draft, ['evaluation.view', 'evaluation.score', 'evaluation.history', 'evaluation.edit', 'evaluation.delete']);

  const viewOnlyDraft = policy.getEligibleEvaluationActionIds({
    status: 'Khởi tạo',
    allowed_actions: ['view'],
  });
  assert.deepEqual(viewOnlyDraft, ['evaluation.view', 'evaluation.history']);

  const correction = policy.getEligibleEvaluationActionIds({
    status: 'Chờ khắc phục',
    allowed_actions: ['view', 'end', 'round2_start'],
  });
  assert.deepEqual(correction, ['evaluation.complete', 'evaluation.round2_start', 'evaluation.view', 'evaluation.history']);

  const terminal = policy.getEligibleEvaluationActionIds({
    status: 'Hoàn thành',
    allowed_actions: ['view', 'edit', 'score', 'delete'],
  });
  assert.deepEqual(terminal, ['evaluation.view', 'evaluation.history']);

  assert.deepEqual(policy.getEligibleEvaluationActionIds({
    status: 'Không xác định',
    allowed_actions: [],
  }), []);
});

test('PROMPT-124 partitions eligible row actions after filtering', () => {
  const descriptors = ['evaluation.view', 'evaluation.score', 'evaluation.history', 'evaluation.delete']
    .map((id) => ({ ...actions.getAction(id) }));
  for (let count = 1; count <= 3; count += 1) {
    const partition = actions.partitionRowActions(descriptors.slice(0, count));
    assert.deepEqual(partition.direct, []);
    assert.equal(partition.overflow.length, count);
  }
  const partition = actions.partitionRowActions(descriptors);
  assert.deepEqual(partition.direct, []);
  assert.equal(partition.overflow.length, 4);
  assert.ok(partition.overflow.some((item) => item.action_id === 'evaluation.delete'));
});

test('PROMPT-124 scoring data is cached by exact ticket and round without overwriting the bootstrap bank', () => {
  const state = read('public/js/state.js');
  const app = read('public/app.js');
  const loader = app.match(/async function loadRoundData\(ticket, force\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const selector = app.match(/function questionsForTicket\(ticket\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(state, /roundQuestions:\s*\{\}/);
  assert.match(loader, /state\.roundQuestions\[key\]/);
  assert.doesNotMatch(loader, /questionBank\.splice/);
  assert.match(selector, /state\.roundQuestions\[roundStateKey\(/);
  assert.match(app, /question_template_version_id/);
});

test('PROMPT-124 scoring selection survives refresh and same-tab hash navigation', () => {
  const app = read('public/app.js');
  assert.match(app, /function scoringTicketFromRoute\(/);
  assert.match(app, /params\.get\('ticket'\)/);
  assert.match(app, /state\.tab === 'scoring'[\s\S]{0,800}scoringTicketFromRoute\(\)/);
  assert.match(app, /\/evaluations\/scoring\?ticket=/);
});

test('PROMPT-124 static scoring buttons resolve the selected backend action envelope', () => {
  const app = read('public/app.js');
  assert.match(app, /const selectedScoringResource = \(\) => selectedTicket\(\)/);
  assert.match(app, /btn-save-scoring-draft[\s\S]{0,250}resource: selectedScoringResource/);
  assert.match(app, /btn-complete-scoring[\s\S]{0,250}resource: selectedScoringResource/);
  assert.match(app, /btn-start-round2[\s\S]{0,250}resource: selectedScoringResource/);
  assert.match(app, /btn-end-evaluation[\s\S]{0,250}context: selectedEndEvaluationContext/);
});
