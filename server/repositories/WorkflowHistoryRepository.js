const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');

class WorkflowHistoryRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      insert: db.prepare(`
        INSERT INTO workflow_history (ticket_id, actor_user_id, actor_role, action, from_status, to_status, comment)
        VALUES (@ticket_id, @actor_user_id, @actor_role, @action, @from_status, @to_status, @comment)
      `),
      listByTicket: db.prepare('SELECT * FROM workflow_history WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT 50'),
      rejectionHistory: db.prepare(`
        SELECT *
        FROM workflow_history
        WHERE ticket_id = @ticket_id
          AND comment IS NOT NULL
          AND TRIM(comment) != ''
          AND (
            action LIKE '%REJECT%'
            OR action LIKE '%RETURN%'
            OR (from_status LIKE @waiting_prefix AND to_status = @in_progress_status)
          )
        ORDER BY created_at ASC, id ASC
      `),
    };
  }

  insert({ ticketId, user, action, fromStatus, toStatus, comment }) {
    return this.statements.insert.run({
      ticket_id: ticketId,
      actor_user_id: user.email,
      actor_role: user.primaryRoleCode || user.roleCodes?.[0] || null,
      action,
      from_status: fromStatus || null,
      to_status: toStatus || null,
      comment: comment || null,
    });
  }

  listByTicket(ticketId) {
    return this.statements.listByTicket.all(ticketId);
  }

  rejectionHistory(ticketId) {
    return this.statements.rejectionHistory.all({
      ticket_id: ticketId,
      waiting_prefix: `${WORKFLOW_STATUSES.WAITING_LEAD.slice(0, WORKFLOW_STATUSES.WAITING_LEAD.indexOf('(')).trim()}%`,
      in_progress_status: WORKFLOW_STATUSES.IN_PROGRESS,
    });
  }
}

module.exports = WorkflowHistoryRepository;
