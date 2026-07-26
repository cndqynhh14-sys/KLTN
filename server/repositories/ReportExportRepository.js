class ReportExportRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      getById: db.prepare(`
        SELECT re.*, t.created_by AS ticket_created_by
        FROM report_exports re
        LEFT JOIN evaluation_tickets t ON t.id = re.ticket_id
        WHERE re.id = ?
      `),
    };
  }

  getById(id) {
    return this.statements.getById.get(id);
  }
}

module.exports = ReportExportRepository;
