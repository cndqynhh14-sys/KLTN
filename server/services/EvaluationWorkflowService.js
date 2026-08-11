const { ROLES } = require('../domain/roles');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { resourceContext } = require('./PolicyService');
const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');
const logger = require('../logger');
const { assertTicketMutable } = require('../domain/historicalEvaluation');

function parseTaskPayload(task) {
  try { return JSON.parse(task.comment || '{}'); } catch { return { comment: task.comment || '' }; }
}

class EvaluationWorkflowService {
  constructor({
    db,
    ticketRepository,
    approvalTaskRepository,
    workflowHistoryRepository,
    missingRequiredNonconformityActions,
    ticketRequiresCorrection,
    sendEmail,
    buildWorkflowEmail,
    policyService,
    approvalAssignmentService,
    notificationService,
  }) {
    this.db = db;
    this.ticketRepository = ticketRepository;
    this.approvalTaskRepository = approvalTaskRepository;
    this.workflowHistoryRepository = workflowHistoryRepository;
    this.missingRequiredNonconformityActions = missingRequiredNonconformityActions;
    this.ticketRequiresCorrection = ticketRequiresCorrection;
    this.sendEmail = sendEmail;
    this.buildWorkflowEmail = buildWorkflowEmail;
    this.policyService = policyService;
    this.approvalAssignmentService = approvalAssignmentService;
    this.notificationService = notificationService;
    this.statements = {
      updateStatusIfCurrent: db.prepare(`
        UPDATE evaluation_tickets
        SET current_status=@next_status, updated_at=datetime('now'), updated_by=@actor
        WHERE id=@ticket_id AND current_status=@expected_status
      `),
      updateCancelReasonIfCurrent: db.prepare(`
        UPDATE evaluation_tickets
        SET current_status=@next_status,
            cancelled_reason=@cancelled_reason,
            updated_at=datetime('now'),
            updated_by=@actor
        WHERE id=@ticket_id AND current_status=@expected_status
      `),
      updateFinalStatusIfCurrent: db.prepare(`
        UPDATE evaluation_tickets
        SET current_status=@next_status,
            cancelled_by = CASE WHEN @mark_cancelled THEN @actor ELSE cancelled_by END,
            cancelled_at = CASE WHEN @mark_cancelled THEN datetime('now') ELSE cancelled_at END,
            updated_at=datetime('now'),
            updated_by=@actor
        WHERE id=@ticket_id AND current_status=@expected_status
      `),
      latestRoundForTicket: db.prepare(`
        SELECT *
        FROM evaluation_rounds
        WHERE ticket_id = ?
        ORDER BY round_no DESC
        LIMIT 1
      `),
      roundForTicketAndRound: db.prepare(`
        SELECT *
        FROM evaluation_rounds
        WHERE ticket_id = ? AND round_no = ?
        LIMIT 1
      `),
      failedCriticalCountForRound: db.prepare(`
        SELECT COUNT(*) AS count
        FROM evaluation_answers a
        JOIN evaluation_rounds er ON er.id = a.round_id
        JOIN pinned_evaluation_questions q ON q.ticket_id = er.ticket_id AND q.id = a.question_item_id
        WHERE a.round_id = ?
          AND q.is_critical_clause = 1
          AND a.score = 'D'
      `),
      setCorrectionLock: db.prepare(`
        UPDATE evaluation_rounds
        SET correction_locked = @locked
        WHERE id = @round_id
      `),
    };
  }

  pendingApprovalTask(ticketId) {
    return this.approvalTaskRepository.findPendingByTicket(ticketId);
  }

  approvalTasksForTicket(ticketId) {
    return this.approvalTaskRepository.listByTicket(ticketId).map((task) => ({
      ...task,
      payload: parseTaskPayload(task),
    }));
  }

  workflowHistoryForTicket(ticketId) {
    return this.workflowHistoryRepository.listByTicket(ticketId);
  }

  rejectionHistoryForTicket(ticketId) {
    return this.workflowHistoryRepository.rejectionHistory(ticketId);
  }

  logWorkflow(ticketId, user, action, fromStatus, toStatus, comment) {
    return this.workflowHistoryRepository.insert({ ticketId, user, action, fromStatus, toStatus, comment });
  }

  createTbpTask(ticket, user, action, payload, nextStatus) {
    const result = this.db.transaction(() => {
      this.createApprovalTask(ticket, 'TBP', ROLES.TBP, user, action, payload, nextStatus);
      return this.ticketRepository.getByCode(ticket.ticket_code);
    })();
    this.notifyAssignment('TBP', 'Phiếu chờ TBP phê duyệt', result, payload?.comment || '', user);
    return result;
  }

  submitToLead({ ticketId, body, user }) {
    const ticket = this.requireTicket(ticketId);
    this.assertVisible(ticket, user);
    this.assertNoPendingTask(ticket.id);
    if (![
      WORKFLOW_STATUSES.IN_PROGRESS,
      WORKFLOW_STATUSES.WAITING_CORRECTION,
      WORKFLOW_STATUSES.ROUND_2,
      WORKFLOW_STATUSES.EXTENDED,
      'Dang xu ly',
    ].includes(ticket.current_status)) {
      throw this.httpError(409, { error: 'invalid_workflow_status', current_status: ticket.current_status });
    }
    const roundNo = Number(ticket.current_round_no || ticket.completed_round || 1);
    if (roundNo !== 2) {
      const missing = this.missingRequiredNonconformityActions(ticket.id);
      if (missing.length) throw this.httpError(400, { error: 'missing_corrective_requirements', items: missing });
    }
    if (!ticket.scoring_locked) throw this.httpError(400, { error: 'scoring_not_completed' });
    const eligibility = this.leadSubmissionEligibility(ticket);
    if (!eligibility.eligible) throw this.httpError(400, { error: 'lead_submission_not_eligible', ...eligibility });
    const comment = String(body?.comment || '').trim() || null;
    const result = this.db.transaction(() => {
      this.createApprovalTask(ticket, 'LEAD', ROLES.LEAD, user, 'EVALUATION_RESULT', { comment }, WORKFLOW_STATUSES.WAITING_LEAD);
      return this.responseFor(ticket.id, ticket.ticket_code);
    })();
    this.notifyAssignment('LEAD', 'Phiếu chờ Lead miền phê duyệt', result.ticket, comment, user);
    return result;
  }

  cancelRequest({ ticketId, body, user }) {
    const ticket = this.requireTicket(ticketId);
    this.assertVisible(ticket, user);
    const reason = String(body?.reason || '').trim();
    if (!reason) throw this.httpError(400, { error: 'cancel_reason_required' });
    this.assertNoPendingTask(ticket.id);
    const comment = String(body?.comment || '').trim() || null;
    const result = this.db.transaction(() => {
      this.createApprovalTask(ticket, 'TBP', ROLES.TBP, user, 'CANCEL', { reason, comment }, WORKFLOW_STATUSES.WAITING_TBP, {
        cancelledReason: reason,
      });
      return this.responseFor(ticket.id, ticket.ticket_code);
    })();
    this.notifyAssignment('TBP', 'Phiếu chờ TBP phê duyệt', result.ticket, comment, user);
    return result;
  }

  leadApprove({ ticketId, body, user }) {
    const ticket = this.requireTicket(ticketId);
    if (!this.policyService.has(user, PERMISSIONS.EVALUATION_APPROVE_LEAD)) throw this.httpError(403, { error: 'forbidden_permission' });
    const task = this.requirePendingLevel(ticket.id, 'LEAD');
    const comment = String(body?.comment || '').trim() || null;
    const result = this.db.transaction(() => {
      this.closeApprovalTask(task, 'APPROVED', user, comment);
      this.createApprovalTask(ticket, 'TBP', ROLES.TBP, user, 'LEAD_APPROVED', { comment }, WORKFLOW_STATUSES.WAITING_TBP);
      this.logWorkflow(ticket.id, user, 'LEAD_APPROVE', ticket.current_status, WORKFLOW_STATUSES.WAITING_TBP, comment);
      return this.responseFor(ticket.id, ticket.ticket_code);
    })();
    this.notifyApprovalResult(result.ticket, task, 'LEAD', 'APPROVED', user);
    this.notifyAssignment('TBP', 'Phiếu chờ TBP phê duyệt', result.ticket, comment, user);
    return result;
  }

  leadReject({ ticketId, body, user }) {
    const ticket = this.requireTicket(ticketId);
    if (!this.policyService.has(user, PERMISSIONS.EVALUATION_APPROVE_LEAD)) throw this.httpError(403, { error: 'forbidden_permission' });
    const comment = String(body?.comment || '').trim();
    if (!comment) throw this.httpError(400, { error: 'reject_comment_required' });
    const task = this.requirePendingLevel(ticket.id, 'LEAD');
    const result = this.db.transaction(() => {
      this.closeApprovalTask(task, 'REJECTED', user, comment);
      this.updateTicketStatus(ticket, WORKFLOW_STATUSES.IN_PROGRESS, user);
      this.logWorkflow(ticket.id, user, 'LEAD_REJECT', ticket.current_status, WORKFLOW_STATUSES.IN_PROGRESS, comment);
      this.setCorrectionFieldsLock(ticket, user, false, ticket.current_status, WORKFLOW_STATUSES.IN_PROGRESS);
      return this.responseFor(ticket.id, ticket.ticket_code);
    })();
    this.notifyApprovalResult(result.ticket, task, 'LEAD', 'REJECTED', user);
    this.notifySpecialist(result.ticket, 'Phiếu bị Lead miền trả về', comment);
    return result;
  }

  tbpReject({ ticketId, body, user }) {
    const ticket = this.requireTicket(ticketId);
    if (!this.policyService.has(user, PERMISSIONS.EVALUATION_APPROVE_TBP)) throw this.httpError(403, { error: 'forbidden_permission' });
    const comment = String(body?.comment || '').trim();
    if (!comment) throw this.httpError(400, { error: 'reject_comment_required' });
    const task = this.requirePendingLevel(ticket.id, 'TBP');
    const result = this.db.transaction(() => {
      this.closeApprovalTask(task, 'REJECTED', user, comment);
      this.createApprovalTask(ticket, 'LEAD', ROLES.LEAD, user, 'TBP_REJECTED', { comment }, WORKFLOW_STATUSES.WAITING_LEAD);
      this.logWorkflow(ticket.id, user, 'TBP_REJECT', ticket.current_status, WORKFLOW_STATUSES.WAITING_LEAD, comment);
      this.setCorrectionFieldsLock(ticket, user, false, ticket.current_status, WORKFLOW_STATUSES.WAITING_LEAD);
      return this.responseFor(ticket.id, ticket.ticket_code);
    })();
    this.notifyApprovalResult(result.ticket, task, 'TBP', 'REJECTED', user);
    this.notifyAssignment('LEAD', 'Phiếu bị TBP trả về Lead miền', result.ticket, comment, user);
    return result;
  }

  tbpSendGdk({ ticketId, body, user }) {
    const ticket = this.requireTicket(ticketId);
    if (!this.policyService.has(user, PERMISSIONS.EVALUATION_APPROVE_TBP)) throw this.httpError(403, { error: 'forbidden_permission' });
    const task = this.requirePendingLevel(ticket.id, 'TBP');
    const comment = String(body?.comment || '').trim() || null;
    const result = this.db.transaction(() => {
      this.closeApprovalTask(task, 'APPROVED', user, comment);
      this.createApprovalTask(ticket, 'GDK', ROLES.GDK, user, 'TBP_SEND_GDK', { comment }, WORKFLOW_STATUSES.WAITING_GDK);
      this.logWorkflow(ticket.id, user, 'TBP_SEND_GDK', ticket.current_status, WORKFLOW_STATUSES.WAITING_GDK, comment);
      return this.responseFor(ticket.id, ticket.ticket_code);
    })();
    this.notifyApprovalResult(result.ticket, task, 'TBP', 'APPROVED', user);
    this.notifyAssignment('GDK', 'Phiếu chờ GĐK phê duyệt', result.ticket, comment, user);
    return result;
  }

  tbpApprove({ ticketId, body, user }) {
    return this.finalApprove({ ticketId, body, user, level: 'TBP', action: 'TBP_APPROVE' });
  }

  gdkReject({ ticketId, body, user }) {
    const ticket = this.requireTicket(ticketId);
    if (!this.policyService.has(user, PERMISSIONS.EVALUATION_APPROVE_GDK)) throw this.httpError(403, { error: 'forbidden_permission' });
    const comment = String(body?.comment || '').trim();
    if (!comment) throw this.httpError(400, { error: 'reject_comment_required' });
    const task = this.requirePendingLevel(ticket.id, 'GDK');
    const result = this.db.transaction(() => {
      this.closeApprovalTask(task, 'REJECTED', user, comment);
      this.createApprovalTask(ticket, 'TBP', ROLES.TBP, user, 'GDK_REJECTED', { comment }, WORKFLOW_STATUSES.WAITING_TBP);
      this.logWorkflow(ticket.id, user, 'GDK_REJECT', ticket.current_status, WORKFLOW_STATUSES.WAITING_TBP, comment);
      this.setCorrectionFieldsLock(ticket, user, false, ticket.current_status, WORKFLOW_STATUSES.WAITING_TBP);
      return this.responseFor(ticket.id, ticket.ticket_code);
    })();
    this.notifyApprovalResult(result.ticket, task, 'GDK', 'REJECTED', user);
    this.notifyAssignment('TBP', 'Phiếu bị GĐK trả về TBP', result.ticket, comment, user);
    return result;
  }

  gdkApprove({ ticketId, body, user }) {
    return this.finalApprove({ ticketId, body, user, level: 'GDK', action: 'GDK_APPROVE' });
  }

  actOnApprovalTask({ ticketId, taskId, body, user }) {
    const ticket = this.requireTicket(ticketId);
    const task = this.approvalTaskRepository.findByIdAndTicket(parseInt(taskId, 10), ticket.id);
    if (!task) throw this.httpError(404, { error: 'approval_task_not_found' });
    this.assertApproval(user, task.approval_level, ticket);
    if (task.status !== 'PENDING') throw this.httpError(409, { error: 'approval_task_closed' });
    const decision = String(body?.decision || '').toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw this.httpError(400, { error: 'invalid_decision' });
    const comment = String(body?.comment || '').trim() || null;
    const payload = parseTaskPayload(task);
    const toStatus = decision === 'APPROVED'
      ? this.finalStatusFor(ticket, payload).status
      : WORKFLOW_STATUSES.IN_PROGRESS;
    const result = this.db.transaction(() => {
      this.closeApprovalTask(task, decision, user, comment);
      this.updateTicketStatus(ticket, toStatus, user, { markCancelled: decision === 'APPROVED' && payload.type === 'CANCEL' });
      this.logWorkflow(ticket.id, user, `${payload.type || 'APPROVAL'}_${decision}`, ticket.current_status, toStatus, comment);
      this.setCorrectionFieldsLock(ticket, user, decision === 'APPROVED', ticket.current_status, toStatus);
      return this.responseFor(ticket.id, ticket.ticket_code);
    })();
    this.notifyApprovalResult(result.ticket, task, task.approval_level, decision, user);
    return result;
  }

  finalApprove({ ticketId, body, user, level, action }) {
    const ticket = this.requireTicket(ticketId);
    this.assertApproval(user, level, ticket);
    const task = this.requirePendingLevel(ticket.id, level);
    const comment = String(body?.comment || '').trim() || null;
    const payload = parseTaskPayload(task);
    const final = this.finalStatusFor(ticket, payload);
    const result = this.db.transaction(() => {
      this.closeApprovalTask(task, 'APPROVED', user, comment);
      this.updateTicketStatus(ticket, final.status, user, { markCancelled: final.markCancelled });
      this.logWorkflow(ticket.id, user, action, ticket.current_status, final.status, comment);
      this.setCorrectionFieldsLock(ticket, user, true, ticket.current_status, final.status);
      return this.responseFor(ticket.id, ticket.ticket_code);
    })();
    this.notifyApprovalResult(result.ticket, task, level, 'APPROVED', user);
    this.notifyFinalResult(result.ticket, comment || '');
    return result;
  }

  createApprovalTask(ticket, level, assignedRole, user, action, payload, nextStatus, options = {}) {
    const taskPayload = { type: action, ...payload };
    this.approvalTaskRepository.insert({
      ticketId: ticket.id,
      approvalLevel: level,
      assignedRole,
      comment: JSON.stringify(taskPayload),
    });
    this.updateTicketStatus(ticket, nextStatus, user, options);
    this.logWorkflow(ticket.id, user, action + '_SUBMIT', ticket.current_status, nextStatus, JSON.stringify(taskPayload));
  }

  closeApprovalTask(task, decision, user, comment) {
    const payload = parseTaskPayload(task);
    const info = this.approvalTaskRepository.closePending({
      id: task.id,
      status: decision,
      comment: JSON.stringify({ ...payload, approver_comment: comment || null }),
      actor: user.email,
    });
    if (!info.changes) throw this.httpError(409, { error: 'approval_task_closed' });
    return payload;
  }

  updateTicketStatus(ticket, nextStatus, user, options = {}) {
    let info;
    if (options.cancelledReason) {
      info = this.statements.updateCancelReasonIfCurrent.run({
        ticket_id: ticket.id,
        expected_status: ticket.current_status,
        next_status: nextStatus,
        cancelled_reason: options.cancelledReason,
        actor: user.email,
      });
    } else {
      info = this.statements.updateFinalStatusIfCurrent.run({
        ticket_id: ticket.id,
        expected_status: ticket.current_status,
        next_status: nextStatus,
        mark_cancelled: options.markCancelled ? 1 : 0,
        actor: user.email,
      });
    }
    if (!info.changes) throw this.httpError(409, { error: 'ticket_status_conflict' });
  }

  setCorrectionFieldsLock(ticket, user, locked, fromStatus, toStatus) {
    const round = this.statements.latestRoundForTicket.get(ticket.id);
    if (!round) return;
    this.statements.setCorrectionLock.run({ round_id: round.id, locked: locked ? 1 : 0 });
    this.logWorkflow(
      ticket.id,
      user,
      locked ? 'CORRECTION_FIELDS_LOCK' : 'CORRECTION_FIELDS_UNLOCK',
      fromStatus,
      toStatus,
      JSON.stringify({
        assessment_id: round.id,
        round_no: round.round_no,
        correction_locked: !!locked,
      })
    );
  }

  finalStatusFor(ticket, payload) {
    if (payload.type === 'EXTENSION') return { status: WORKFLOW_STATUSES.EXTENDED, markCancelled: false };
    if (payload.type === 'SUSPENSION') return { status: WORKFLOW_STATUSES.SUSPENDED, markCancelled: false };
    if (payload.type === 'CANCEL') return { status: WORKFLOW_STATUSES.CANCELLED, markCancelled: true };
    return {
      status: this.ticketRequiresCorrection(ticket) ? WORKFLOW_STATUSES.WAITING_CORRECTION : WORKFLOW_STATUSES.COMPLETED,
      markCancelled: false,
    };
  }

  requireTicket(identifier) {
    const ticket = this.ticketRepository.getByIdOrCode(identifier);
    if (!ticket) throw this.httpError(404, { error: 'ticket_not_found' });
    assertTicketMutable(ticket);
    return ticket;
  }

  assertVisible(ticket, user) {
    try { this.policyService.assert(user, PERMISSIONS.EVALUATION_READ, { context: resourceContext(ticket) }); }
    catch (error) { throw this.httpError(403, { error: error.code || 'forbidden_scope' }); }
  }

  assertNoPendingTask(ticketId) {
    if (this.pendingApprovalTask(ticketId)) throw this.httpError(409, { error: 'pending_approval_exists' });
  }

  requirePendingLevel(ticketId, level) {
    const task = this.approvalTaskRepository.findPendingLevel(ticketId, level);
    if (!task) throw this.httpError(404, { error: 'approval_task_not_found' });
    return task;
  }

  leadSubmissionEligibility(ticket) {
    const roundNo = Number(ticket.current_round_no || ticket.completed_round || 1);
    const scoreValue = roundNo === 2 && ticket.corrected_score_percent != null
      ? ticket.corrected_score_percent
      : ticket.score_percent;
    const score = Number(scoreValue);
    const round = this.statements.roundForTicketAndRound.get(ticket.id, roundNo)
      || this.statements.latestRoundForTicket.get(ticket.id);
    const failedCriticalCount = round
      ? Number(this.statements.failedCriticalCountForRound.get(round.id)?.count || 0)
      : 0;
    const scoreBelowThreshold = Number.isFinite(score) && score < 60;
    return {
      eligible: scoreBelowThreshold || failedCriticalCount > 0,
      score_percent: Number.isFinite(score) ? score : null,
      score_below_threshold: scoreBelowThreshold,
      failed_critical_count: failedCriticalCount,
    };
  }

  responseFor(ticketId, ticketCode) {
    return {
      ticket: this.ticketRepository.getByCode(ticketCode),
      approval_tasks: this.approvalTasksForTicket(ticketId),
      workflow_history: this.workflowHistoryForTicket(ticketId),
    };
  }

  notifyAssignment(level, title, ticket, comment, actor = null) {
    let recipients = [];
    try {
      recipients = this.approvalAssignmentService.resolve('EVALUATION', level, resourceContext(ticket)).candidates;
    } catch (error) {
      logger.warn('evaluation.approval_assignment_unresolved', {
        error,
        ticket_code: ticket.ticket_code,
        approval_level: level,
      });
    }
    const task = this.approvalTaskRepository.findPendingLevel(ticket.id, level);
    if (this.notificationService) {
      try {
        this.notificationService.createEvaluationApprovalAssignment({ ticket, task, level, receivers: recipients, actor });
      } catch (error) {
        logger.error('evaluation.notification_dispatch_failed', {
          error,
          ticket_code: ticket.ticket_code,
          approval_level: level,
          notification_kind: 'ASSIGNMENT',
        });
      }
    }
    this.notifyEmails(recipients, this.buildWorkflowEmail({
      title,
      ticketCode: ticket.ticket_code,
      supplierName: ticket.supplier_name,
      status: ticket.current_status,
      comment,
    }));
  }

  notifyApprovalResult(ticket, task, level, decision, actor) {
    if (!this.notificationService) return;
    try {
      this.notificationService.createEvaluationApprovalResult({ ticket, task, level, decision, actor });
    } catch (error) {
      logger.error('evaluation.notification_dispatch_failed', {
        error,
        ticket_code: ticket.ticket_code,
        approval_level: level,
        notification_kind: decision,
      });
    }
  }

  assertApproval(user, level, ticket) {
    try {
      return this.policyService.assertApproval(user, 'EVALUATION', level, resourceContext(ticket));
    } catch (error) {
      throw this.httpError(error.status || 403, { error: error.code || 'forbidden_scope' });
    }
  }

  notifySpecialist(ticket, title, comment) {
    this.notifyEmails([ticket.assigned_specialist_id || ticket.created_by], this.buildWorkflowEmail({
      title,
      ticketCode: ticket.ticket_code,
      supplierName: ticket.supplier_name,
      status: ticket.current_status,
      comment,
    }));
  }

  notifyFinalResult(ticket, comment) {
    const cmc = String(process.env.CMC_EMAILS || process.env.CMC_EMAIL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.notifyEmails([ticket.contact_email, ...cmc], this.buildWorkflowEmail({
      title: 'Kết quả đánh giá NCC',
      ticketCode: ticket.ticket_code,
      supplierName: ticket.supplier_name,
      status: ticket.current_status,
      comment,
    }));
  }

  notifyEmails(recipients, email) {
    const targets = Array.from(new Set((recipients || []).filter(Boolean)));
    targets.forEach((to) => {
      this.sendEmail({ to, subject: email.subject, htmlContent: email.htmlContent }).catch((e) =>
        logger.error('[workflow-email]', e.message)
      );
    });
  }

  httpError(status, payload) {
    const error = new Error(payload.error || 'workflow_failed');
    error.status = status;
    error.payload = payload;
    return error;
  }
}

module.exports = EvaluationWorkflowService;
