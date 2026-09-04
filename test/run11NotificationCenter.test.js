const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { NotificationService } = require('../server/services/NotificationService');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

class FakeNotificationRepository {
  constructor() {
    this.rows = [];
    this.users = new Set(['owner@masangroup.com', 'lead@masangroup.com', 'tbp@masangroup.com', 'gdk@masangroup.com', 'other@masangroup.com']);
    this.tickets = new Map();
    this.deadlines = [];
  }

  activeUser(email) { return this.users.has(String(email).toLowerCase()) ? { user_id: email, email } : null; }
  insert(payload) {
    if (this.rows.some((row) => row.unique_key === payload.unique_key)) return { changes: 0 };
    this.rows.push({ id: this.rows.length + 1, is_read: 0, created_at: '2026-07-16 08:00:00', ...payload });
    return { changes: 1 };
  }
  allByReceiver(email) { return this.rows.filter((row) => row.receiver_user_id === email); }
  getForReceiver(id, email) { return this.rows.find((row) => row.id === Number(id) && row.receiver_user_id === email); }
  markRead(id, email) {
    const row = this.getForReceiver(id, email);
    if (!row) return { changes: 0 };
    row.is_read = 1;
    row.read_at = '2026-07-16 09:00:00';
    return { changes: 1 };
  }
  evaluationById(id) { return this.tickets.get(Number(id)); }
  deadlineCandidates() { return this.deadlines; }
}

function notificationFixture() {
  const repository = new FakeNotificationRepository();
  const ticket = {
    id: 41,
    ticket_code: 'DG-041',
    supplier_code: 'NCC-041',
    supplier_name: 'NCC phạm vi đúng',
    created_by: 'owner@masangroup.com',
    assigned_specialist_id: 'owner@masangroup.com',
  };
  repository.tickets.set(ticket.id, ticket);
  const policyService = {
    assert(user) { if (user.denied) throw new Error('forbidden_scope'); },
    has(user, permission) { return permission === 'SYSTEM.ADMIN' && Boolean(user.admin); },
    actionEnvelope(_type, _row, user) { return { allowed_actions: user.approver ? ['approve_lead'] : [] }; },
    decision(user) { return { allowed: !user.denied }; },
  };
  const service = new NotificationService({
    notificationRepository: repository,
    policyService,
    warningDays: 3,
    now: () => new Date('2026-07-16T10:00:00'),
  });
  return { repository, service, ticket };
}

test('RUN-11 exposes an authenticated notification API', () => {
  const routePath = path.join(root, 'server/routes/notifications.js');
  assert.equal(fs.existsSync(routePath), true, 'notification route must exist');

  const route = read('server/routes/notifications.js');
  assert.match(route, /requireAuth/);
  assert.match(route, /read-all/);
  assert.match(route, /NotificationService/);

  const server = read('server/index.js');
  assert.match(server, /\/api\/notifications/);
});

test('RUN-11 renders the bell, unread badge, filters, and responsive panel', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');

  assert.match(html, /id="notification-panel"/);
  assert.match(html, /id="notification-unread-badge"/);
  assert.match(html, /data-notification-filter="all"/);
  assert.match(html, /data-notification-filter="unread"/);
  assert.match(html, /data-notification-filter="action"/);
  assert.match(app, /loadNotifications/);
  assert.match(app, /markNotificationRead/);
  assert.match(app, /openNotificationTarget/);
});

test('RUN-11 preserves the existing approval stage order in the notification catalog', () => {
  const catalogPath = path.join(root, 'server/domain/notificationWorkflow.js');
  assert.equal(fs.existsSync(catalogPath), true, 'workflow-derived notification catalog must exist');

  const catalog = read('server/domain/notificationWorkflow.js');
  assert.match(catalog, /LEAD[^]*Lead miền/);
  assert.match(catalog, /TBP[^]*TBP/);
  assert.match(catalog, /GDK[^]*GĐK/);
});

test('RUN-11 creates role-correct assignments and results once per receiver', () => {
  const { repository, service, ticket } = notificationFixture();
  const stages = [
    ['LEAD', 'lead@masangroup.com', 'Lead miền'],
    ['TBP', 'tbp@masangroup.com', 'TBP'],
    ['GDK', 'gdk@masangroup.com', 'GĐK'],
  ];
  stages.forEach(([level, receiver, label], index) => {
    const task = { id: index + 1 };
    service.createEvaluationApprovalAssignment({ ticket, task, level, receivers: [receiver], actor: { email: 'owner@masangroup.com' } });
    service.createEvaluationApprovalAssignment({ ticket, task, level, receivers: [receiver], actor: { email: 'owner@masangroup.com' } });
    const row = repository.rows.find((item) => item.receiver_user_id === receiver);
    assert.equal(row.title, 'Phiếu chờ duyệt');
    assert.match(row.message, new RegExp(label));
    assert.equal(JSON.parse(row.payload_json).action_label, 'Phê duyệt');
  });
  assert.equal(repository.rows.length, 3, 'retry must not duplicate a recipient event');

  service.createEvaluationApprovalResult({ ticket, task: { id: 11 }, level: 'LEAD', decision: 'APPROVED', actor: { email: 'lead@masangroup.com' } });
  service.createEvaluationApprovalResult({ ticket, task: { id: 12 }, level: 'GDK', decision: 'REJECTED', actor: { email: 'gdk@masangroup.com' } });
  const approved = repository.rows.find((row) => row.title === 'Lead miền đã duyệt');
  const rejected = repository.rows.find((row) => row.title === 'GĐK từ chối');
  assert.equal(JSON.parse(approved.payload_json).action_label, 'Xem phiếu');
  assert.equal(JSON.parse(rejected.payload_json).action_label, 'Xem lý do');
  assert.match(JSON.parse(rejected.payload_json).deep_link, /evaluations\?ticket=DG-041&reason=1/);
  assert.doesNotMatch(rejected.title, /DG-041|NCC phạm vi đúng/);
});

test('RUN-11 rechecks scope for list/read and supports badge read state', () => {
  const { repository, service, ticket } = notificationFixture();
  service.createEvaluationAssigned({ ticket, actor: { email: 'owner@masangroup.com' } });
  const owner = { userId: 'owner@masangroup.com', email: 'owner@masangroup.com' };
  const listed = service.listForUser(owner, { filter: 'all' });
  assert.equal(listed.total, 1);
  assert.equal(listed.unread_count, 1);
  assert.equal(service.markReadForUser(listed.items[0].id, owner).is_read, true);
  assert.equal(service.listForUser(owner, { filter: 'unread' }).total, 0);

  service.createEvaluationApprovalAssignment({
    ticket,
    task: { id: 51 },
    level: 'LEAD',
    receivers: ['owner@masangroup.com'],
    actor: owner,
  });
  const actionItem = service.listForUser(owner, { filter: 'action' }).items[0];
  service.markReadForUser(actionItem.id, owner);
  assert.equal(service.listForUser(owner, { filter: 'action' }).total, 1, 'read state must not hide a still-pending action');

  const hidden = { ...repository.rows[0], id: 99, receiver_user_id: 'other@masangroup.com', unique_key: 'hidden' };
  repository.rows.push(hidden);
  assert.equal(service.listForUser({ userId: 'other@masangroup.com', email: 'other@masangroup.com', denied: true }).total, 0);
  assert.equal(service.markReadForUser(99, { userId: 'other@masangroup.com', email: 'other@masangroup.com', denied: true }), null);
});

test('RUN-11 uses existing round 1/round 2 dates with a notification-only warning horizon', () => {
  const { repository, service, ticket } = notificationFixture();
  repository.deadlines = [
    { ...ticket, id: 41, deadline_round: 1, deadline_date: '2026-07-18' },
    { ...ticket, id: 42, ticket_code: 'DG-042', deadline_round: 2, deadline_date: '2026-07-15' },
  ];
  repository.tickets.set(42, repository.deadlines[1]);
  service.syncDeadlineNotifications();
  const deadlines = repository.rows.filter((row) => row.notification_type === 'EVALUATION_DEADLINE');
  assert.deepEqual(deadlines.map((row) => row.title).sort(), ['Quá hạn đánh giá lần 2', 'Sắp đến hạn đánh giá lần 1']);
  service.syncDeadlineNotifications();
  assert.equal(repository.rows.filter((row) => row.notification_type === 'EVALUATION_DEADLINE').length, 2);
});

test('RUN-11 refuses sensitive notification content', () => {
  const { service } = notificationFixture();
  assert.throws(() => service.createSystemAnnouncement({
    type: 'SYSTEM_INCIDENT',
    title: 'Sự cố',
    message: 'Access token bị lộ',
    receivers: ['owner@masangroup.com'],
    eventKey: 'incident-1',
  }), /sensitive_notification_content/);
});

test('RUN-11 keeps backend workflow hooks while the frontend notification surface is evaluation-only', () => {
  const evaluationWorkflow = read('server/services/EvaluationWorkflowService.js');
  const app = read('public/app.js');
  assert.match(evaluationWorkflow, /createEvaluationApprovalAssignment/);
  assert.match(evaluationWorkflow, /createEvaluationApprovalResult/);
  assert.match(app, /isEvaluationNotification/);
});
