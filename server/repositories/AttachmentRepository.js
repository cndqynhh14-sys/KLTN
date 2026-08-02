class AttachmentRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      getById: db.prepare('SELECT * FROM evaluation_attachments WHERE id = ?'),
      listForTicket: db.prepare(`
        SELECT ea.*, er.round_no, q.question_code, q.category
        FROM evaluation_attachments ea
        LEFT JOIN evaluation_answers a ON a.id = ea.answer_id
        LEFT JOIN evaluation_rounds er ON er.id = a.round_id
        LEFT JOIN pinned_evaluation_questions q ON q.ticket_id = er.ticket_id AND q.id = a.question_item_id
        WHERE ea.ticket_id = ?
           OR er.ticket_id = ?
        ORDER BY ea.uploaded_at DESC, ea.id DESC
      `),
      listByRound: db.prepare(`
        SELECT ea.*
        FROM evaluation_attachments ea
        JOIN evaluation_answers ans ON ans.id = ea.answer_id
        WHERE ans.round_id = ?
        ORDER BY ea.uploaded_at DESC
      `),
      listLegalByKind: db.prepare(`
        SELECT * FROM evaluation_attachments
        WHERE ticket_id = ? AND answer_id IS NULL AND storage_key LIKE ?
        ORDER BY uploaded_at DESC, id DESC
      `),
      deleteLegalByKind: db.prepare(`
        DELETE FROM evaluation_attachments
        WHERE ticket_id = ? AND answer_id IS NULL AND storage_key LIKE ?
      `),
      insert: db.prepare(`
        INSERT INTO evaluation_attachments (answer_id, ticket_id, file_name, file_path, storage_key, mime_type, size_bytes, uploaded_by)
        VALUES (@answer_id, @ticket_id, @file_name, @file_path, @storage_key, @mime_type, @size_bytes, @uploaded_by)
      `),
      inheritedExists: db.prepare('SELECT id FROM evaluation_attachments WHERE answer_id = ? AND storage_key = ?'),
    };
  }

  getById(id) {
    return this.statements.getById.get(id);
  }

  listForTicket(ticketId) {
    return this.statements.listForTicket.all(ticketId, ticketId);
  }

  listByRound(roundId) {
    return this.statements.listByRound.all(roundId);
  }

  listLegalByKind(ticketId, kind) {
    return this.statements.listLegalByKind.all(ticketId, `LEGAL:${kind}:%`);
  }

  deleteLegalByKind(ticketId, kind) {
    return this.statements.deleteLegalByKind.run(ticketId, `LEGAL:${kind}:%`);
  }

  insert(payload) {
    return this.statements.insert.run(payload);
  }

  inheritedExists(answerId, storageKey) {
    return this.statements.inheritedExists.get(answerId, storageKey);
  }
}

module.exports = AttachmentRepository;
