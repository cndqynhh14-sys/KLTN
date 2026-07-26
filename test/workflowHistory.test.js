const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KEY_WORKFLOW_TRANSITIONS,
  WORKFLOW_STATUSES,
  isReturnTransition,
} = require('../server/domain/workflowHistory');

test('BRD workflow status constants include the audit timeline states', () => {
  assert.deepEqual(Object.values(WORKFLOW_STATUSES), [
    'Khởi tạo',
    'Đang xử lý',
    'Chờ duyệt (Lead)',
    'Chờ duyệt (TBP)',
    'Chờ duyệt (GĐK)',
    'Chờ khắc phục',
    'Đang đánh giá lần 2',
    'Gia hạn',
    'Tạm ngừng',
    'Hoàn thành',
    'Hủy',
  ]);
});

test('key approval transitions match BRD status flow', () => {
  assert.deepEqual(KEY_WORKFLOW_TRANSITIONS.LEAD_APPROVE, {
    from: 'Chờ duyệt (Lead)',
    to: 'Chờ duyệt (TBP)',
  });
  assert.deepEqual(KEY_WORKFLOW_TRANSITIONS.TBP_SEND_GDK, {
    from: 'Chờ duyệt (TBP)',
    to: 'Chờ duyệt (GĐK)',
  });
  assert.deepEqual(KEY_WORKFLOW_TRANSITIONS.GDK_REJECT, {
    from: 'Chờ duyệt (GĐK)',
    to: 'Chờ duyệt (TBP)',
  });
  assert.deepEqual(KEY_WORKFLOW_TRANSITIONS.ROUND_1_APPROVE_WITH_CORRECTION, {
    from: 'Chờ duyệt (TBP)',
    to: 'Chờ khắc phục',
  });
  assert.deepEqual(KEY_WORKFLOW_TRANSITIONS.ROUND_2_OPEN, {
    from: 'Chờ khắc phục',
    to: 'Đang đánh giá lần 2',
  });
});

test('return transitions can be highlighted in ticket detail timeline', () => {
  assert.equal(isReturnTransition('LEAD_REJECT', 'Chờ duyệt (Lead)', 'Đang xử lý'), true);
  assert.equal(isReturnTransition('STATUS_CHANGE', 'Chờ duyệt (Lead)', 'Đang xử lý'), true);
  assert.equal(isReturnTransition('ROUND_1_COMPLETE', 'Khởi tạo', 'Đang xử lý'), false);
});
