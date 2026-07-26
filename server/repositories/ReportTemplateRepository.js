class ReportTemplateRepository {
  constructor(db) {
    this.db = db;
    this.listStatementCache = new Map();
    this.statements = {
      getById: db.prepare('SELECT * FROM report_templates WHERE id = ?'),
      insert: db.prepare(`
        INSERT INTO report_templates (template_name, report_type, template_body, active)
        VALUES (?, ?, ?, ?)
      `),
      update: db.prepare(`
        UPDATE report_templates
        SET template_name=?, report_type=?, template_body=?, active=?, updated_at=datetime('now')
        WHERE id=?
      `),
      deactivate: db.prepare("UPDATE report_templates SET active=0, updated_at=datetime('now') WHERE id=?"),
    };
  }

  list({ includeInactive, type }) {
    const where = [];
    const params = {};
    if (!includeInactive) where.push('active = 1');
    if (type) {
      where.push('report_type = @type');
      params.type = type;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const cacheKey = `${includeInactive ? 'withInactive' : 'active'}|${type ? 'type' : 'all'}`;
    let statement = this.listStatementCache.get(cacheKey);
    if (!statement) {
      statement = this.db.prepare(`
        SELECT * FROM report_templates
        ${whereSql}
        ORDER BY active DESC, report_type, template_name
      `);
      this.listStatementCache.set(cacheKey, statement);
    }
    return statement.all(params);
  }

  getById(id) {
    return this.statements.getById.get(id);
  }

  insert(name, type, templateBody, active) {
    return this.statements.insert.run(name, type, templateBody, active);
  }

  update(id, name, type, templateBody, active) {
    return this.statements.update.run(name, type, templateBody, active, id);
  }

  deactivate(id) {
    return this.statements.deactivate.run(id);
  }
}

module.exports = ReportTemplateRepository;
