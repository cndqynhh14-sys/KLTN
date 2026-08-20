'use strict';

class AuditEventRepository {
  constructor(db) {
    this.db = db;
  }

  _where(filters = {}) {
    const where = [];
    const params = {};
    const add = (sql, key, value) => {
      if (value == null) return;
      where.push(sql);
      params[key] = value;
    };
    add('occurred_at >= @from', 'from', filters.from);
    add('occurred_at <= @to', 'to', filters.to);
    add('category = @category', 'category', filters.category);
    add('event_name = @event', 'event', filters.event);
    add('severity = @severity', 'severity', filters.severity);
    add('(LOWER(actor_user_id) = @actor OR actor_principal_id = @actor)', 'actor', filters.actor);
    add('entity_id = @entity', 'entity', filters.entity);
    add('entity_type = @entity_type', 'entity_type', filters.entity_type);
    add('outcome = @outcome', 'outcome', filters.outcome);
    add('request_id = @request', 'request', filters.request);
    add('correlation_id = @correlation', 'correlation', filters.correlation);
    add('uat_run_id = @uat', 'uat', filters.uat);
    if (filters.cursor) {
      where.push('(occurred_at < @cursor_time OR (occurred_at = @cursor_time AND id < @cursor_id))');
      params.cursor_time = filters.cursor.occurred_at;
      params.cursor_id = filters.cursor.id;
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  list(filters) {
    const { sql, params } = this._where(filters);
    return this.db.prepare(`SELECT * FROM audit_events ${sql}
      ORDER BY occurred_at DESC, id DESC LIMIT @fetch_limit`)
      .all({ ...params, fetch_limit: filters.limit + 1 });
  }

  exportRows(filters) {
    const { sql, params } = this._where(filters);
    return this.db.prepare(`SELECT * FROM audit_events ${sql}
      ORDER BY occurred_at DESC, id DESC LIMIT @fetch_limit`)
      .all({ ...params, fetch_limit: filters.limit + 1 });
  }

  getById(id) {
    return this.db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id) || null;
  }

  retentionPolicies() {
    return this.db.prepare(`SELECT retention_class, categories_json, retention_days,
      purge_approved, approval_reference, config_version
      FROM audit_retention_policies ORDER BY retention_class`).all();
  }

  countBefore(categories, cutoff) {
    if (!Array.isArray(categories) || categories.length === 0) return 0;
    const placeholders = categories.map(() => '?').join(',');
    return this.db.prepare(`SELECT COUNT(*) AS count FROM audit_events
      WHERE category IN (${placeholders}) AND occurred_at < ?`).get(...categories, cutoff).count;
  }
}

module.exports = { AuditEventRepository };
