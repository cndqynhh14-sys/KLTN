'use strict';

const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');
const { approvalStageTitle } = require('../domain/notificationWorkflow');
const { isEvaluationCreatedAndResponsible } = require('../domain/evaluationResponsibility');
const { resourceContext } = require('./PolicyService');

const NOTIFICATION_TYPES = Object.freeze({
  EVALUATION_ASSIGNED: 'EVALUATION_ASSIGNED',
  EVALUATION_APPROVAL_ASSIGNED: 'EVALUATION_APPROVAL_ASSIGNED',
  EVALUATION_APPROVED: 'EVALUATION_APPROVED',
  EVALUATION_REJECTED: 'EVALUATION_REJECTED',
  EVALUATION_DEADLINE: 'EVALUATION_DEADLINE',
  SYSTEM_MAINTENANCE: 'SYSTEM_MAINTENANCE',
  SYSTEM_INCIDENT: 'SYSTEM_INCIDENT',
});

const SENSITIVE_PATTERN = /\b(?:otp|one[- ]?time password|bearer|jwt|access[_ -]?token|refresh[_ -]?token|password|secret)\b/i;
const ACTION_TYPES = new Set(['EVALUATION_APPROVAL_ASSIGNED']);

function compact(items) {
  return Array.from(new Set((items || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)));
}

function cleanLine(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function safeText(value, maxLength) {
  const text = cleanLine(value, maxLength);
  if (SENSITIVE_PATTERN.test(text)) throw Object.assign(new Error('sensitive_notification_content'), { code: 'sensitive_notification_content' });
  return text;
}

function parsePayload(row) {
  try { return JSON.parse(row.payload_json || '{}'); } catch { return {}; }
}

function dateOnly(value) {
  const parsed = new Date(`${String(value || '').slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dayDiff(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

class NotificationService {
  constructor({ notificationRepository, policyService, warningDays, now = () => new Date() }) {
    this.notificationRepository = notificationRepository;
    this.policyService = policyService;
    this.warningDays = Math.max(0, Math.min(30, Number.isFinite(Number(warningDays)) ? Number(warningDays) : 3));
    this.now = now;
  }

  createForReceivers({ receivers, sender, ticket = null, type, title, message, payload = {}, uniqueKey }) {
    const safeTitle = safeText(title, 96);
    const safeMessage = safeText(message, 280);
    const safePayload = { ...payload };
    const serialized = JSON.stringify(safePayload);
    if (SENSITIVE_PATTERN.test(serialized)) throw Object.assign(new Error('sensitive_notification_content'), { code: 'sensitive_notification_content' });
    compact(receivers).forEach((receiver) => {
      const receiverUser = this.notificationRepository.activeUser(receiver);
      if (!receiverUser) return;
      const senderIdentifier = sender?.userId || sender?.id || sender?.email || sender || null;
      const senderUser = senderIdentifier ? this.notificationRepository.activeUser(senderIdentifier) : null;
      this.notificationRepository.insert({
        receiver_user_id: receiverUser.user_id,
        sender_user_id: senderUser?.user_id || null,
        ticket_id: ticket?.id || null,
        notification_type: type,
        title: safeTitle,
        message: safeMessage,
        payload_json: serialized,
        unique_key: `${uniqueKey}:${receiverUser.user_id}`,
      });
    });
  }

  createEvaluationAssigned({ ticket, actor }) {
    const receiver = ticket.assigned_specialist_id || ticket.created_by;
    if (!receiver) return;
    this.createForReceivers({
      receivers: [receiver], sender: actor, ticket,
      type: NOTIFICATION_TYPES.EVALUATION_ASSIGNED,
      title: 'Phiếu mới được giao',
      message: 'Bạn được giao phụ trách phiếu đánh giá nhà cung cấp mới.',
      uniqueKey: `evaluation:assigned:${ticket.id}`,
      payload: this.evaluationPayload(ticket, { action_label: 'Xem phiếu', requires_action: false }),
    });
  }

  createEvaluationApprovalAssignment({ ticket, task, level, receivers, actor }) {
    const stage = approvalStageTitle(level);
    this.createForReceivers({
      receivers, sender: actor, ticket,
      type: NOTIFICATION_TYPES.EVALUATION_APPROVAL_ASSIGNED,
      title: 'Phiếu chờ duyệt',
      message: `Bạn có phiếu chờ ${stage} phê duyệt.`,
      uniqueKey: `evaluation:approval-assigned:${ticket.id}:${task?.id || level}`,
      payload: this.evaluationPayload(ticket, {
        approval_task_id: task?.id || null,
        approval_level: String(level || '').toUpperCase(),
        action_label: 'Phê duyệt',
        requires_action: true,
        deep_link: `/qlcl/#/approvals?ticket=${encodeURIComponent(ticket.ticket_code)}`,
      }),
    });
  }

  createEvaluationApprovalResult({ ticket, task, level, decision, actor }) {
    const receiver = ticket.assigned_specialist_id || ticket.created_by;
    if (!receiver) return;
    const rejected = String(decision).toUpperCase() === 'REJECTED';
    const stage = approvalStageTitle(level);
    this.createForReceivers({
      receivers: [receiver], sender: actor, ticket,
      type: rejected ? NOTIFICATION_TYPES.EVALUATION_REJECTED : NOTIFICATION_TYPES.EVALUATION_APPROVED,
      title: `${stage} ${rejected ? 'từ chối' : 'đã duyệt'}`,
      message: rejected ? 'Phiếu đã được trả lại. Xem nhận xét trên phiếu.' : 'Kết quả phê duyệt của phiếu đã được cập nhật.',
      uniqueKey: `evaluation:approval-result:${ticket.id}:${task?.id || level}:${rejected ? 'rejected' : 'approved'}`,
      payload: this.evaluationPayload(ticket, {
        approval_task_id: task?.id || null,
        approval_level: String(level || '').toUpperCase(),
        decision: rejected ? 'REJECTED' : 'APPROVED',
        action_label: rejected ? 'Xem lý do' : 'Xem phiếu',
        requires_action: false,
        deep_link: `/qlcl/#/evaluations?ticket=${encodeURIComponent(ticket.ticket_code)}${rejected ? '&reason=1' : ''}`,
      }),
    });
  }

  createSystemAnnouncement({ type, title, message, receivers, actor, eventKey, severity = 'MEDIUM' }) {
    if (![NOTIFICATION_TYPES.SYSTEM_MAINTENANCE, NOTIFICATION_TYPES.SYSTEM_INCIDENT].includes(type)) {
      throw Object.assign(new Error('invalid_system_notification_type'), { code: 'invalid_system_notification_type' });
    }
    this.createForReceivers({
      receivers, sender: actor, type, title, message,
      uniqueKey: `system:${type}:${eventKey}`,
      payload: { entity_type: 'SYSTEM', severity, requires_action: false, action_label: '' },
    });
  }

  evaluationPayload(ticket, extra = {}) {
    return {
      entity_type: 'EVALUATION',
      ticket_id: ticket.id,
      ticket_code: ticket.ticket_code,
      supplier_code: ticket.supplier_code || '',
      supplier_name: ticket.supplier_name || '',
      severity: 'MEDIUM',
      requires_action: false,
      deep_link: `/qlcl/#/evaluations?ticket=${encodeURIComponent(ticket.ticket_code)}`,
      ...extra,
    };
  }

  syncDeadlineNotifications() {
    const today = this.now();
    const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const rows = this.notificationRepository.deadlineCandidates({
      waiting_correction: WORKFLOW_STATUSES.WAITING_CORRECTION,
      completed: WORKFLOW_STATUSES.COMPLETED,
      cancelled: WORKFLOW_STATUSES.CANCELLED,
      suspended: WORKFLOW_STATUSES.SUSPENDED,
    });
    rows.forEach((ticket) => {
      const receiver = ticket.assigned_specialist_id || ticket.created_by;
      const due = dateOnly(ticket.deadline_date);
      if (!receiver || !due) return;
      const remaining = dayDiff(todayOnly, due);
      if (remaining > this.warningDays) return;
      const bucket = remaining < 0 ? 'OVERDUE' : remaining === 0 ? 'DUE' : 'UPCOMING';
      const round = Number(ticket.deadline_round);
      const title = remaining < 0 ? `Quá hạn đánh giá lần ${round}` : `Sắp đến hạn đánh giá lần ${round}`;
      const message = remaining < 0
        ? `Phiếu đã quá hạn ${Math.abs(remaining)} ngày.`
        : remaining === 0 ? 'Phiếu đến hạn hôm nay.' : `Phiếu còn ${remaining} ngày đến hạn.`;
      this.createForReceivers({
        receivers: [receiver], ticket,
        type: NOTIFICATION_TYPES.EVALUATION_DEADLINE,
        title, message,
        uniqueKey: `evaluation:deadline:${ticket.id}:${round}:${ticket.deadline_date}:${bucket}`,
        payload: this.evaluationPayload(ticket, {
          deadline_round: round,
          deadline_date: ticket.deadline_date,
          deadline_state: bucket,
          severity: remaining < 0 ? 'HIGH' : 'MEDIUM',
          action_label: 'Xem phiếu',
        }),
      });
    });
  }

  canAccess(user, row) {
    const payload = parsePayload(row);
    if (payload.entity_type === 'SYSTEM' || row.notification_type.startsWith('SYSTEM_')) return true;
    if (row.ticket_id || payload.entity_type === 'EVALUATION') {
      const ticket = this.notificationRepository.evaluationById(row.ticket_id || payload.ticket_id);
      if (!ticket) return false;
      try {
        this.policyService.assert(user, PERMISSIONS.EVALUATION_READ, { context: resourceContext(ticket) });
        if (this.policyService.has(user, PERMISSIONS.SYSTEM_ADMIN) || isEvaluationCreatedAndResponsible(ticket, user)) return true;
        const actions = this.policyService.actionEnvelope('EVALUATION', ticket, user).allowed_actions || [];
        return actions.some((action) => ['approve_lead', 'approve_tbp', 'approve_gdk'].includes(action));
      } catch { return false; }
    }
    return false;
  }

  accessibleRows(user) {
    return this.notificationRepository.allByReceiver(user.userId || user.id).filter((row) => this.canAccess(user, row));
  }

  listForUser(user, query = {}) {
    this.syncDeadlineNotifications();
    const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '30', 10) || 30));
    const filter = ['unread', 'action'].includes(query.filter) ? query.filter : 'all';
    const accessible = this.accessibleRows(user);
    const unreadCount = accessible.filter((row) => !row.is_read).length;
    const filtered = accessible.filter((row) => {
      if (filter === 'unread') return !row.is_read;
      if (filter === 'action') return ACTION_TYPES.has(row.notification_type);
      return true;
    });
    const offset = (page - 1) * limit;
    return {
      items: filtered.slice(offset, offset + limit).map((row) => this.mapNotification(row)),
      unread_count: unreadCount,
      total: filtered.length,
      page,
      limit,
      warning_days: this.warningDays,
    };
  }

  markReadForUser(id, user) {
    const userId = user.userId || user.id;
    const existing = this.notificationRepository.getForReceiver(id, userId);
    if (!existing || !this.canAccess(user, existing)) return null;
    this.notificationRepository.markRead(id, userId);
    return this.mapNotification(this.notificationRepository.getForReceiver(id, userId));
  }

  markAllReadForUser(user) {
    this.accessibleRows(user).filter((row) => !row.is_read).forEach((row) => {
      this.notificationRepository.markRead(row.id, user.userId || user.id);
    });
    return { unread_count: 0 };
  }

  mapNotification(row) {
    const payload = parsePayload(row);
    return {
      id: row.id,
      ticket_code: row.ticket_code || payload.ticket_code || '',
      supplier_code: row.supplier_code || payload.supplier_code || '',
      supplier_name: row.supplier_name || payload.supplier_name || '',
      notification_type: row.notification_type,
      title: row.title || '',
      message: row.message,
      severity: payload.severity || 'MEDIUM',
      requires_action: Boolean(payload.requires_action),
      action_label: payload.action_label || 'Xem phiếu',
      deep_link: payload.deep_link || payload.url || '',
      payload,
      is_read: Boolean(row.is_read),
      read_at: row.read_at,
      created_at: row.created_at,
    };
  }
}

module.exports = { NotificationService, NOTIFICATION_TYPES, SENSITIVE_PATTERN };
