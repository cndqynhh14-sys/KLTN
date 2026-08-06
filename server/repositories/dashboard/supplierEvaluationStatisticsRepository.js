function placeholders(values) {
  return values.map(() => '?').join(', ');
}

class SupplierEvaluationStatisticsRepository {
  constructor(db) {
    this.db = db;
  }

  filterClause(filters, params) {
    const clauses = [];
    [
      ['regions', 't.region'],
      ['evaluationTypes', 't.evaluation_type'],
      ['mch2', 't.mch2'],
    ].forEach(([key, column]) => {
      const values = Array.isArray(filters[key]) ? filters[key] : [];
      if (!values.length) return;
      clauses.push(`${column} IN (${placeholders(values)})`);
      params.push(...values);
    });
    return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
  }

  listTicketsBefore(periodEndExclusive, filters) {
    const params = [periodEndExclusive];
    const filterSql = this.filterClause(filters, params);
    return this.db.prepare(`
      SELECT
        t.id,
        t.ticket_code,
        t.supplier_id,
        COALESCE(NULLIF(TRIM(sm.supplier_code), ''), NULLIF(TRIM(t.supplier_code), '')) AS supplier_code,
        COALESCE(NULLIF(TRIM(sm.supplier_name), ''), NULLIF(TRIM(t.supplier_name), ''), 'Chưa xác định') AS supplier_name,
        t.region,
        t.evaluation_type,
        t.mch2,
        t.current_status,
        t.created_at,
        t.cancelled_at
      FROM evaluation_tickets t
      LEFT JOIN supplier_master sm ON sm.id = t.supplier_id
      WHERE COALESCE(t.is_deleted, 0) = 0
        AND datetime(t.created_at) < datetime(?)
        ${filterSql}
      ORDER BY t.id
    `).all(...params);
  }

  listWorkflowHistory(ticketIds, periodEndExclusive) {
    if (!ticketIds.length) return [];
    return this.db.prepare(`
      SELECT id, ticket_id, action, from_status, to_status, created_at
      FROM workflow_history
      WHERE ticket_id IN (${placeholders(ticketIds)})
        AND datetime(created_at) < datetime(?)
      ORDER BY ticket_id, datetime(created_at), id
    `).all(...ticketIds, periodEndExclusive);
  }

  listCompletedRounds(ticketIds, periodEndExclusive) {
    if (!ticketIds.length) return [];
    return this.db.prepare(`
      SELECT
        id,
        ticket_id,
        round_no,
        assessment_date,
        completed_at,
        locked_at,
        total_score,
        final_result,
        classification,
        status
      FROM evaluation_rounds
      WHERE ticket_id IN (${placeholders(ticketIds)})
        AND (
          completed_at IS NOT NULL
          OR locked_at IS NOT NULL
          OR LOWER(TRIM(COALESCE(status, ''))) IN ('hoàn thành', 'hoan thanh', 'completed')
        )
        AND datetime(COALESCE(completed_at, locked_at, assessment_date, started_at)) < datetime(?)
      ORDER BY ticket_id, round_no, datetime(COALESCE(completed_at, locked_at, assessment_date, started_at)), id
    `).all(...ticketIds, periodEndExclusive);
  }

  filterOptions() {
    const read = (column) => this.db.prepare(`
      SELECT DISTINCT TRIM(${column}) AS value
      FROM evaluation_tickets
      WHERE COALESCE(is_deleted, 0) = 0
        AND NULLIF(TRIM(${column}), '') IS NOT NULL
      ORDER BY value COLLATE NOCASE
    `).all().map((row) => row.value);
    return {
      regions: read('region'),
      evaluation_types: read('evaluation_type'),
      mch2: read('mch2'),
    };
  }
}

module.exports = SupplierEvaluationStatisticsRepository;

