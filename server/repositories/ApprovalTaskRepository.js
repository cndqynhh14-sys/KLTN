class ApprovalTaskRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      listByTicket: db.prepare('SELECT * FROM approval_tasks WHERE ticket_id = ? ORDER BY created_at DESC, id DESC'),
      findPendingByTicket: db.prepare(`
        SELECT * FROM approval_tasks
        WHERE ticket_id = ? AND status = 'PENDING'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `),
      findPendingLevel: db.prepare(`
        SELECT * FROM approval_tasks
        WHERE ticket_id = ? AND approval_level = ? AND status = 'PENDING'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `),
      findByIdAndTicket: db.prepare('SELECT * FROM approval_tasks WHERE id = ? AND ticket_id = ?'),
      insert: db.prepare(`
        INSERT INTO approval_tasks (ticket_id, approval_level, assigned_role, status, comment)
        VALUES (@ticket_id, @approval_level, @assigned_role, @status, @comment)
      `),
      closePending: db.prepare(`
        UPDATE approval_tasks
        SET status=@status, comment=@comment, acted_at=datetime('now'), acted_by=@actor
        WHERE id=@id AND status='PENDING'
      `),
    };
  }

  listByTicket(ticketId) {
    return this.statements.listByTicket.all(ticketId);
  }

  findPendingByTicket(ticketId) {
    return this.statements.findPendingByTicket.get(ticketId);
  }

  findPendingLevel(ticketId, level) {
    return this.statements.findPendingLevel.get(ticketId, level);
  }

  findByIdAndTicket(id, ticketId) {
    return this.statements.findByIdAndTicket.get(id, ticketId);
  }

  insert({ ticketId, approvalLevel, assignedRole, status = 'PENDING', comment }) {
    return this.statements.insert.run({
      ticket_id: ticketId,
      approval_level: approvalLevel,
      assigned_role: assignedRole,
      status,
      comment,
    });
  }

  closePending({ id, status, comment, actor }) {
    return this.statements.closePending.run({ id, status, comment, actor });
  }
}

module.exports = ApprovalTaskRepository;
