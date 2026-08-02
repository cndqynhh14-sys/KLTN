function canonicalNonconformity(row) {
  if (!row) return row;
  return {
    ...row,
    nonconformity: row.nonconformity_content,
    remediation: row.remediation_content,
    read_source: 'CANONICAL',
  };
}

class CorrectiveActionRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      listByTicket: db.prepare(`
        SELECT nc.id, nc.ticket_id, nc.round_id,
          nc.nonconformity_content AS issue_description,
          nc.remediation_content AS required_action,
          nc.due_date, nc.status, nc.created_by, nc.created_at,
          nc.updated_by, nc.updated_at, er.round_no
        FROM evaluation_nonconformities nc
        LEFT JOIN evaluation_rounds er ON er.id = nc.round_id
        WHERE nc.ticket_id = ?
          AND NULLIF(TRIM(COALESCE(nc.remediation_content, '')), '') IS NOT NULL
        ORDER BY nc.created_at DESC, nc.id DESC
      `),
      listNonconformitiesByTicket: db.prepare(`
        SELECT nc.*, er.round_no, er.correction_locked, q.question_text,
          q.version_item_id AS question_item_id
        FROM evaluation_nonconformities nc
        LEFT JOIN evaluation_rounds er ON er.id = nc.round_id
        LEFT JOIN evaluation_answers a ON a.id=nc.evaluation_answer_id
        LEFT JOIN pinned_evaluation_questions q ON q.ticket_id = nc.ticket_id AND q.id = a.question_item_id
        WHERE nc.ticket_id = ?
        ORDER BY COALESCE(er.round_no, 0), nc.category, nc.clause_code, nc.created_at
      `),
      getNonconformityForTicket: db.prepare('SELECT * FROM evaluation_nonconformities WHERE id = ? AND ticket_id = ?'),
      updateNonconformityProposal: db.prepare(`
        UPDATE evaluation_nonconformities
        SET remediation_content=@remediation,
            due_date=@due_date,
            status=@status,
            updated_at=datetime('now'),
            updated_by=@updated_by
        WHERE id=@id AND ticket_id=@ticket_id
      `),
    };
  }

  listByTicket(ticketId) {
    return this.statements.listByTicket.all(ticketId);
  }

  listNonconformitiesByTicket(ticketId) {
    return this.statements.listNonconformitiesByTicket.all(ticketId).map(canonicalNonconformity);
  }

  getNonconformityForTicket(id, ticketId) {
    return canonicalNonconformity(this.statements.getNonconformityForTicket.get(id, ticketId));
  }

  updateNonconformityProposal(payload) {
    return this.statements.updateNonconformityProposal.run(payload);
  }
}

module.exports = CorrectiveActionRepository;
