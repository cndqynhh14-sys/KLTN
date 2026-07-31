class CorrectiveActionRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      listByTicket: db.prepare(`
        SELECT ca.*, er.round_no, att.file_name AS evidence_file_name
        FROM corrective_actions ca
        JOIN evaluation_rounds er ON er.id = ca.round_id
        LEFT JOIN evaluation_attachments att ON att.id = ca.evidence_attachment_id
        WHERE ca.ticket_id = ?
        ORDER BY ca.created_at DESC
      `),
      insert: db.prepare(`
        INSERT INTO corrective_actions (
          ticket_id, round_id, issue_description, required_action, responsible_party,
          due_date, status, evidence_attachment_id, created_by
        )
        VALUES (@ticket_id, @round_id, @issue_description, @required_action, @responsible_party,
          @due_date, @status, @evidence_attachment_id, @created_by)
      `),
      listNonconformitiesByTicket: db.prepare(`
        SELECT nc.*, er.round_no, er.correction_locked, q.question_text
        FROM evaluation_nonconformities nc
        LEFT JOIN evaluation_rounds er ON er.id = nc.round_id
        LEFT JOIN pinned_evaluation_questions q ON q.ticket_id = nc.ticket_id AND q.id = nc.question_id
        WHERE nc.ticket_id = ?
        ORDER BY COALESCE(er.round_no, 0), nc.category, nc.clause_code, nc.created_at
      `),
      getNonconformityForTicket: db.prepare('SELECT * FROM evaluation_nonconformities WHERE id = ? AND ticket_id = ?'),
      updateNonconformityProposal: db.prepare(`
        UPDATE evaluation_nonconformities
        SET remediation=@remediation,
            remediation_content=@remediation,
            due_date=@due_date,
            status=@status,
            corrective_action_id=@corrective_action_id,
            updated_at=datetime('now'),
            updated_by=@updated_by
        WHERE id=@id AND ticket_id=@ticket_id
      `),
    };
  }

  listByTicket(ticketId) {
    return this.statements.listByTicket.all(ticketId);
  }

  insert(payload) {
    return this.statements.insert.run(payload);
  }

  listNonconformitiesByTicket(ticketId) {
    return this.statements.listNonconformitiesByTicket.all(ticketId);
  }

  getNonconformityForTicket(id, ticketId) {
    return this.statements.getNonconformityForTicket.get(id, ticketId);
  }

  updateNonconformityProposal(payload) {
    return this.statements.updateNonconformityProposal.run(payload);
  }
}

module.exports = CorrectiveActionRepository;
