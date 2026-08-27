'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

async function helper() {
  return import(pathToFileURL(path.join(root, 'public/js/evaluation-status.mjs')).href);
}

test('evaluation status tabs preserve the required business order and exact filtering', async () => {
  const { EVALUATION_STATUS_TABS, evaluationStatusCounts, filterEvaluationsByStatus } = await helper();
  assert.deepEqual(EVALUATION_STATUS_TABS.map((tab) => tab.label), [
    'Tất cả',
    'Khởi tạo',
    'Đang xử lý',
    'Chờ khắc phục',
    'Đang đánh giá lần 2',
    'Chờ duyệt (Lead)',
    'Chờ duyệt (TBP)',
    'Chờ duyệt (GĐK)',
    'Hoàn thành',
  ]);
  const rows = [
    { status: 'Khởi tạo' },
    { status: 'Đang xử lý' },
    { status: 'Đang xử lý' },
    { status: 'Chờ duyệt (Lead)' },
    { status: 'Hủy' },
  ];
  assert.equal(filterEvaluationsByStatus(rows, '').length, 5);
  assert.equal(filterEvaluationsByStatus(rows, 'Đang xử lý').length, 2);
  assert.equal(filterEvaluationsByStatus(rows, 'Chờ duyệt (TBP)').length, 0);
  const counts = evaluationStatusCounts(rows);
  assert.equal(counts[''], 5);
  assert.equal(counts['Đang xử lý'], 2);
  assert.equal(counts['Chờ duyệt (Lead)'], 1);
});

test('workflow stepper omits optional round 2 and approvals until the ticket proves them', async () => {
  const { getEvaluationWorkflowSteps } = await helper();
  const processing = getEvaluationWorkflowSteps({ status: 'Đang xử lý' });
  assert.deepEqual(processing.map((step) => step.status), ['Khởi tạo', 'Đang xử lý', 'Hoàn thành']);
  assert.equal(processing.at(-1).state, 'upcoming');
  assert.ok(!processing.some((step) => step.status.includes('lần 2')));
  assert.ok(!processing.some((step) => step.status.startsWith('Chờ duyệt')));

  const correction = getEvaluationWorkflowSteps({ status: 'Chờ khắc phục' });
  assert.deepEqual(correction.map((step) => step.status), ['Khởi tạo', 'Đang xử lý', 'Chờ khắc phục', 'Hoàn thành']);
  assert.ok(!correction.some((step) => step.status.includes('lần 2')));

  const round2 = getEvaluationWorkflowSteps({ status: 'Đang đánh giá lần 2', round_2_exists: true });
  assert.deepEqual(round2.map((step) => step.status), ['Khởi tạo', 'Đang xử lý', 'Chờ khắc phục', 'Đang đánh giá lần 2', 'Hoàn thành']);

  const completedRound2 = getEvaluationWorkflowSteps({ status: 'Hoàn thành', round_2_exists: true });
  assert.deepEqual(completedRound2.map((step) => step.status), ['Khởi tạo', 'Đang xử lý', 'Chờ khắc phục', 'Đang đánh giá lần 2', 'Hoàn thành']);
});

test('workflow history is transition evidence and repeated approval returns stay one business step', async () => {
  const { getEvaluationWorkflowSteps } = await helper();
  const steps = getEvaluationWorkflowSteps({
    status: 'Chờ duyệt (Lead)',
    workflow_history: [
      { id: 4, from_status: 'Chờ duyệt (TBP)', to_status: 'Chờ duyệt (Lead)', created_at: '2026-08-04T09:00:00Z' },
      { id: 3, from_status: 'Chờ duyệt (Lead)', to_status: 'Chờ duyệt (TBP)', created_at: '2026-08-03T09:00:00Z' },
      { id: 2, from_status: 'Đang xử lý', to_status: 'Chờ duyệt (Lead)', created_at: '2026-08-02T09:00:00Z' },
      { id: 1, from_status: null, to_status: 'Khởi tạo', created_at: '2026-08-01T09:00:00Z' },
    ],
  });
  assert.deepEqual(steps.map((step) => step.status), [
    'Khởi tạo',
    'Đang xử lý',
    'Chờ duyệt (Lead)',
    'Chờ duyệt (TBP)',
    'Hoàn thành',
  ]);
  assert.equal(steps[2].state, 'current');
  assert.equal(steps[2].occurredAt, '2026-08-04T09:00:00Z');
  assert.equal(steps[3].state, 'upcoming');
  assert.equal(steps[0].occurredAt, '2026-08-01T09:00:00Z');
  assert.ok(!steps.some((step) => step.status === 'Chờ duyệt (GĐK)'));
});

test('technical history records, repeated saves and refreshes never multiply workflow steps', async () => {
  const { getEvaluationWorkflowSteps } = await helper();
  const ticket = {
    status: 'Hoàn thành',
    workflow_history: [
      { id: 1, action: 'TICKET_CREATE', from_status: null, to_status: 'Khởi tạo', created_at: '2026-08-01T08:00:00Z' },
      { id: 2, action: 'SCORING_DRAFT_SAVE', from_status: 'Khởi tạo', to_status: 'Đang xử lý', created_at: '2026-08-01T09:00:00Z' },
      { id: 3, action: 'SCORING_DRAFT_SAVE', from_status: 'Đang xử lý', to_status: 'Đang xử lý', created_at: '2026-08-01T10:00:00Z' },
      { id: 4, action: 'RESULT_SUBMIT', from_status: 'Đang xử lý', to_status: 'Chờ duyệt (Lead)', created_at: '2026-08-02T08:00:00Z' },
      { id: 5, action: 'CORRECTION_FIELDS_LOCK', from_status: 'Đang xử lý', to_status: 'Chờ duyệt (Lead)', created_at: '2026-08-02T08:00:01Z' },
      { id: 6, action: 'LEAD_APPROVE', from_status: 'Chờ duyệt (Lead)', to_status: 'Chờ duyệt (TBP)', created_at: '2026-08-03T08:00:00Z' },
      { id: 7, action: 'CORRECTION_FIELDS_LOCK', from_status: 'Chờ duyệt (Lead)', to_status: 'Chờ duyệt (TBP)', created_at: '2026-08-03T08:00:01Z' },
      { id: 8, action: 'TBP_APPROVE', from_status: 'Chờ duyệt (TBP)', to_status: 'Hoàn thành', created_at: '2026-08-04T08:00:00Z' },
      { id: 9, action: 'CORRECTION_FIELDS_LOCK', from_status: 'Chờ duyệt (TBP)', to_status: 'Hoàn thành', created_at: '2026-08-04T08:00:01Z' },
    ],
  };
  const firstRender = getEvaluationWorkflowSteps(ticket);
  const refreshedRender = getEvaluationWorkflowSteps(ticket);
  assert.deepEqual(firstRender, refreshedRender);
  assert.deepEqual(firstRender.map((step) => step.status), [
    'Khởi tạo', 'Đang xử lý', 'Chờ duyệt (Lead)', 'Chờ duyệt (TBP)', 'Hoàn thành',
  ]);
  assert.equal(new Set(firstRender.map((step) => step.key)).size, firstRender.length);
});

test('round 2 keeps one canonical milestone for correction and each approval stage', async () => {
  const { getEvaluationWorkflowSteps } = await helper();
  const steps = getEvaluationWorkflowSteps({
    status: 'Hoàn thành',
    round_2_exists: true,
    workflow_history: [
      { id: 1, from_status: null, to_status: 'Khởi tạo', created_at: '2026-08-01T08:00:00Z' },
      { id: 2, from_status: 'Khởi tạo', to_status: 'Đang xử lý', created_at: '2026-08-01T09:00:00Z' },
      { id: 3, from_status: 'Đang xử lý', to_status: 'Chờ duyệt (Lead)', created_at: '2026-08-02T08:00:00Z' },
      { id: 4, from_status: 'Chờ duyệt (Lead)', to_status: 'Chờ duyệt (TBP)', created_at: '2026-08-03T08:00:00Z' },
      { id: 5, from_status: 'Chờ duyệt (TBP)', to_status: 'Chờ khắc phục', created_at: '2026-08-04T08:00:00Z' },
      { id: 6, from_status: 'Chờ khắc phục', to_status: 'Đang đánh giá lần 2', created_at: '2026-08-05T08:00:00Z' },
      { id: 7, from_status: 'Đang đánh giá lần 2', to_status: 'Chờ duyệt (Lead)', created_at: '2026-08-06T08:00:00Z' },
      { id: 8, from_status: 'Chờ duyệt (Lead)', to_status: 'Chờ duyệt (TBP)', created_at: '2026-08-07T08:00:00Z' },
      { id: 9, from_status: 'Chờ duyệt (TBP)', to_status: 'Hoàn thành', created_at: '2026-08-08T08:00:00Z' },
    ],
  });
  assert.deepEqual(steps.map((step) => step.status), [
    'Khởi tạo',
    'Đang xử lý',
    'Chờ khắc phục',
    'Đang đánh giá lần 2',
    'Chờ duyệt (Lead)',
    'Chờ duyệt (TBP)',
    'Hoàn thành',
  ]);
  assert.ok(steps.slice(0, -1).every((step) => step.state === 'complete'));
  assert.equal(steps.at(-1).state, 'current');
});

test('evaluation list and scoring view expose responsive tab/stepper hosts and load real history', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  assert.match(html, /id="eval-status-tabs"[^>]*role="tablist"/);
  assert.match(html, /id="scoring-workflow-stepper"/);
  assert.match(html, /\.evaluation-status-tabs[^}]*overflow-x:\s*auto/);
  assert.match(html, /\.evaluation-workflow-stepper[^}]*overflow-x:\s*auto/);
  assert.match(app, /filterEvaluationsByStatus\(rows, state\.evalStatusTab\)/);
  assert.match(app, /api\('\/evaluations\/' \+ encodeURIComponent\(ticket\.code\)\)/);
  assert.match(app, /ticket\.workflow_history = detail\.data\.workflow_history \|\| \[\]/);
  assert.match(app, /renderEvaluationWorkflowStepper\(selectedTicket\)/);
});
