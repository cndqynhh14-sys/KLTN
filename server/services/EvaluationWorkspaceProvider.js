'use strict';

const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');
const { resourceContext } = require('./PolicyService');
const ScoringPolicyRepository = require('../scoring/ScoringPolicyRepository');
const { classifyWithPolicy } = require('../scoring/scoringPolicyEngine');

const TERMINAL = new Set([
  WORKFLOW_STATUSES.COMPLETED,
  WORKFLOW_STATUSES.SUSPENDED,
  WORKFLOW_STATUSES.CANCELLED,
]);

const APPROVAL_STATUS = Object.freeze({
  LEAD: WORKFLOW_STATUSES.WAITING_LEAD,
  TBP: WORKFLOW_STATUSES.WAITING_TBP,
  GDK: WORKFLOW_STATUSES.WAITING_GDK,
});

const APPROVAL_LABEL = Object.freeze({
  LEAD: 'Phê duyệt cấp Lead miền',
  TBP: 'Phê duyệt cấp TBP',
  GDK: 'Phê duyệt cấp GĐK',
});

function safeApproval(policyService, user, level, row, task) {
  if (task.assigned_user_id && task.assigned_user_id !== user.userId && !policyService.has(user, PERMISSIONS.SYSTEM_ADMIN)) {
    return false;
  }
  try {
    policyService.assertApproval(user, 'EVALUATION', level, resourceContext(row));
    return true;
  } catch (_error) {
    return false;
  }
}

function latestHistoryByTicket(db, ticketIds) {
  if (!ticketIds.length) return new Map();
  const placeholders = ticketIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT h.* FROM workflow_history h
    JOIN (
      SELECT ticket_id, MAX(id) AS max_id FROM workflow_history
      WHERE ticket_id IN (${placeholders}) GROUP BY ticket_id
    ) latest ON latest.max_id=h.id
  `).all(...ticketIds);
  return new Map(rows.map((row) => [row.ticket_id, row]));
}

class EvaluationWorkspaceProvider {
  constructor({ db, policyService, scoringPolicyRepository = null }) {
    this.db = db;
    this.policyService = policyService;
    this.scoringPolicyRepository = scoringPolicyRepository || new ScoringPolicyRepository(db);
  }

  async pending(user, context) {
    if (!this.policyService.has(user, PERMISSIONS.EVALUATION_READ)) return [];
    const tickets = this.db.prepare(`
      SELECT t.*,
        CASE WHEN t.current_status IN ('Chờ khắc phục','Gia hạn','Đang đánh giá lần 2') THEN
          COALESCE(
            (SELECT ce.new_due_date FROM correction_extensions ce
              WHERE ce.ticket_id=t.id ORDER BY ce.extension_no DESC, ce.id DESC LIMIT 1),
            (SELECT MIN(due_date) FROM evaluation_nonconformities n
              WHERE n.ticket_id=t.id AND n.status IN ('OPEN','IN_PROGRESS') AND n.due_date IS NOT NULL)
          )
        ELSE t.planned_date END AS workspace_due_date,
        EXISTS(SELECT 1 FROM approval_tasks p WHERE p.ticket_id=t.id AND p.status='PENDING') AS has_pending_approval,
        (SELECT locked_at FROM evaluation_rounds r WHERE r.ticket_id=t.id AND r.round_no=1 LIMIT 1) AS round1_locked_at,
        EXISTS(SELECT 1 FROM evaluation_rounds r WHERE r.ticket_id=t.id AND r.round_no=2) AS has_round2,
        (SELECT COUNT(*) FROM evaluation_nonconformities n
          WHERE n.ticket_id=t.id AND n.severity IN ('B','C','D')
            AND (NULLIF(TRIM(COALESCE(n.remediation_content,'')),'') IS NULL
              OR NULLIF(TRIM(COALESCE(n.due_date,'')),'') IS NULL)) AS missing_nonconformity_action_count,
        (SELECT COUNT(*) FROM evaluation_answers a
          JOIN evaluation_rounds r ON r.id=a.round_id
          LEFT JOIN question_items qi ON qi.id=a.question_item_id
          WHERE r.ticket_id=t.id
            AND r.round_no=COALESCE(NULLIF(t.current_round_no,0), NULLIF(t.completed_round,0), 1)
            AND COALESCE(qi.is_critical_clause,0)=1 AND a.score='D') AS failed_critical_count
      FROM evaluation_tickets t
      WHERE t.is_deleted=0
    `).all();
    const histories = latestHistoryByTicket(this.db, tickets.map((ticket) => ticket.id));
    const result = [];

    for (const ticket of tickets) {
      if (TERMINAL.has(ticket.current_status)) continue;
      const envelope = this.policyService.actionEnvelope('EVALUATION', ticket, user);
      const allowed = new Set(envelope.allowed_actions || []);
      const approvalLevel = Object.keys(APPROVAL_STATUS).find((level) => APPROVAL_STATUS[level] === ticket.current_status);

      if (approvalLevel) {
        const tasks = this.db.prepare(`
          SELECT * FROM approval_tasks
          WHERE ticket_id=? AND approval_level=? AND status='PENDING'
          ORDER BY id
        `).all(ticket.id, approvalLevel);
        const task = tasks.find((candidate) => safeApproval(this.policyService, user, approvalLevel, ticket, candidate));
        if (!task || !allowed.has(`approve_${approvalLevel.toLowerCase()}`)) continue;
        result.push(this.approvalItem(ticket, task, approvalLevel));
        continue;
      }

      let actionId = null;
      let taskType = null;
      let taskLabel = null;
      if (this.canStartRound2(ticket, user)) {
        actionId = 'round2_start';
        taskType = 'ROUND_2_START';
        taskLabel = 'Bắt đầu đánh giá lần 2';
      } else if (this.canClose(ticket, user)) {
        actionId = 'end';
        taskType = 'END';
        taskLabel = 'Kết thúc đánh giá';
      } else if (this.canSubmitLead(ticket, user)) {
        actionId = 'submit_lead';
        taskType = 'SUBMIT_LEAD';
        taskLabel = 'Gửi Lead miền phê duyệt';
      } else if (allowed.has('score')) {
        actionId = 'score';
        taskType = ticket.current_round_no === 2 || ticket.current_status === WORKFLOW_STATUSES.ROUND_2 ? 'ROUND_2_SCORE' : 'SCORE';
        taskLabel = ticket.current_status === WORKFLOW_STATUSES.DRAFT
          ? 'Bắt đầu đánh giá'
          : ticket.current_status === WORKFLOW_STATUSES.ROUND_2
            ? 'Tiếp tục đánh giá lần 2'
            : histories.get(ticket.id)?.action === 'LEAD_REJECT'
              ? 'Chỉnh sửa theo phản hồi Lead miền'
              : 'Tiếp tục chấm điểm';
      }
      if (!actionId) continue;
      result.push(this.specialistItem(ticket, { actionId, taskType, taskLabel }, context));
    }
    return result;
  }

  canStartRound2(ticket, user) {
    if (![WORKFLOW_STATUSES.WAITING_CORRECTION, WORKFLOW_STATUSES.EXTENDED].includes(ticket.current_status)) return false;
    if (ticket.has_pending_approval || ticket.has_round2 || !ticket.round1_locked_at || Number(ticket.completed_round || 0) < 1) return false;
    return this.policyService.decision(user, PERMISSIONS.EVALUATION_SCORE, { context: resourceContext(ticket) }).allowed;
  }

  canClose(ticket, user) {
    if (!ticket.scoring_locked || ticket.has_pending_approval) return false;
    const score = Number(ticket.completed_round >= 2 && ticket.corrected_score_percent != null
      ? ticket.corrected_score_percent : ticket.score_percent);
    if (!Number.isFinite(score)) return false;
    try {
      const policy = this.scoringPolicyRepository.policyForTicket(ticket);
      if (!classifyWithPolicy(policy.definition, score, false).passed) return false;
    } catch (_error) {
      if (score < 60) return false;
    }
    return this.policyService.decision(user, PERMISSIONS.EVALUATION_SCORE, { context: resourceContext(ticket) }).allowed;
  }

  canSubmitLead(ticket, user) {
    if (!ticket.scoring_locked || ticket.has_pending_approval) return false;
    if (![WORKFLOW_STATUSES.IN_PROGRESS, WORKFLOW_STATUSES.WAITING_CORRECTION, WORKFLOW_STATUSES.ROUND_2, WORKFLOW_STATUSES.EXTENDED].includes(ticket.current_status)) return false;
    const roundNo = Number(ticket.current_round_no || ticket.completed_round || 1);
    if (roundNo !== 2 && Number(ticket.missing_nonconformity_action_count || 0) > 0) return false;
    const score = Number(roundNo === 2 && ticket.corrected_score_percent != null
      ? ticket.corrected_score_percent : ticket.score_percent);
    const eligible = (Number.isFinite(score) && score < 60) || Number(ticket.failed_critical_count || 0) > 0;
    if (!eligible) return false;
    return this.policyService.decision(user, PERMISSIONS.EVALUATION_SCORE, { context: resourceContext(ticket) }).allowed;
  }

  specialistItem(ticket, action, context) {
    const dueDate = ticket.workspace_due_date || null;
    return {
      module: 'EVALUATION',
      work_group_key: `EVALUATION:${ticket.id}`,
      entity_id: ticket.id,
      entity_code: ticket.ticket_code,
      supplier_name: ticket.supplier_name || ticket.supplier_code || '—',
      task_type: action.taskType,
      task_label: action.taskLabel,
      status: ticket.current_status,
      due_date: dueDate,
      overdue_days: 0,
      priority: dueDate && dueDate <= context.dueSoonEnd ? 'HIGH' : 'MEDIUM',
      action_id: action.actionId,
      action_label: 'Mở xử lý',
      route: `/qlcl/#/evaluations/scoring?ticket=${encodeURIComponent(ticket.ticket_code)}`,
    };
  }

  approvalItem(ticket, task, level) {
    return {
      module: 'EVALUATION',
      work_group_key: `EVALUATION:${ticket.id}`,
      entity_id: ticket.id,
      entity_code: ticket.ticket_code,
      supplier_name: ticket.supplier_name || ticket.supplier_code || '—',
      task_type: `APPROVE_${level}`,
      task_label: APPROVAL_LABEL[level],
      status: ticket.current_status,
      due_date: null,
      overdue_days: 0,
      priority: 'HIGH',
      action_id: `approve_${level.toLowerCase()}`,
      action_label: 'Mở xử lý',
      route: `/qlcl/#/approvals?workflow=EVALUATION&task=${task.id}`,
    };
  }

  async recent(user) {
    if (!this.policyService.has(user, PERMISSIONS.EVALUATION_READ)) return [];
    const rows = this.db.prepare(`
      SELECT t.*, activity.acted_at, activity.action
      FROM evaluation_tickets t
      JOIN (
        SELECT ticket_id, created_at AS acted_at, action FROM workflow_history
          WHERE actor_user_id=? AND created_at >= datetime('now','-7 days')
        UNION ALL
        SELECT ticket_id, acted_at, 'APPROVAL_' || status FROM approval_tasks
          WHERE acted_by=? AND acted_at >= datetime('now','-7 days')
      ) activity ON activity.ticket_id=t.id
      WHERE t.is_deleted=0
      ORDER BY activity.acted_at DESC
    `).all(user.userId, user.userId);
    return rows.filter((row) => this.policyService.decision(user, PERMISSIONS.EVALUATION_READ, {
      context: resourceContext(row),
    }).allowed).map((row) => ({
      module: 'EVALUATION',
      work_group_key: `EVALUATION:${row.id}`,
      entity_id: row.id,
      entity_code: row.ticket_code,
      supplier_name: row.supplier_name || row.supplier_code || '—',
      task_type: row.action,
      task_label: 'Đã xử lý phiếu đánh giá',
      status: row.current_status,
      acted_at: row.acted_at,
      action_id: 'view',
      action_label: 'Mở xử lý',
      route: `/qlcl/#/evaluations?ticket=${encodeURIComponent(row.ticket_code)}`,
    }));
  }
}

module.exports = { EvaluationWorkspaceProvider };
