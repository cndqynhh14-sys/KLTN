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
        t.mch3,
        t.source_kind,
        t.actual_evaluation_date,
        t.correction_date,
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
        er.id,
        er.ticket_id,
        er.round_no,
        er.assessment_date,
        er.completed_at,
        er.locked_at,
        er.total_score,
        er.final_result,
        er.classification,
        er.status
      FROM evaluation_rounds er
      JOIN evaluation_tickets t ON t.id = er.ticket_id
      WHERE er.ticket_id IN (${placeholders(ticketIds)})
        AND (
          er.completed_at IS NOT NULL
          OR er.locked_at IS NOT NULL
          OR LOWER(TRIM(COALESCE(er.status, ''))) IN ('hoàn thành', 'hoan thanh', 'completed')
        )
        AND (
          (UPPER(COALESCE(t.source_kind, 'NATIVE')) = 'HISTORICAL'
            AND datetime(COALESCE(er.completed_at, er.locked_at, er.assessment_date, er.started_at, t.actual_evaluation_date, t.created_at)) < datetime(?))
          OR
          (UPPER(COALESCE(t.source_kind, 'NATIVE')) != 'HISTORICAL'
            AND datetime(COALESCE(er.completed_at, er.locked_at, er.assessment_date, er.started_at)) < datetime(?))
        )
      ORDER BY er.ticket_id, er.round_no, datetime(COALESCE(er.completed_at, er.locked_at, er.assessment_date, er.started_at, t.actual_evaluation_date, t.created_at)), er.id
    `).all(...ticketIds, periodEndExclusive, periodEndExclusive);
  }

  listViolationSources(roundIds) {
    if (!roundIds.length) return { primary: [], fallback: [] };
    const args = placeholders(roundIds);
    const primary = this.db.prepare(`
      SELECT
        nc.id AS violation_id,
        nc.round_id,
        nc.evaluation_answer_id,
        nc.clause_code,
        nc.category,
        nc.nonconformity_content AS nonconformity,
        q.question_code,
        q.question_text
      FROM evaluation_nonconformities nc
      JOIN evaluation_rounds er ON er.id = nc.round_id
      LEFT JOIN evaluation_answers a ON a.id = nc.evaluation_answer_id
      LEFT JOIN pinned_evaluation_questions q
        ON q.ticket_id = er.ticket_id AND q.id = a.question_item_id
      WHERE nc.round_id IN (${args})
        AND COALESCE(nc.status, 'OPEN') != 'CANCELLED'
      ORDER BY nc.id
    `).all(...roundIds);
    const fallback = this.db.prepare(`
      SELECT
        a.id AS evaluation_answer_id,
        a.round_id,
        NULL AS clause_code,
        q.category,
        NULL AS nonconformity,
        q.question_code,
        q.question_text
      FROM evaluation_answers a
      JOIN evaluation_rounds er ON er.id = a.round_id
      JOIN pinned_evaluation_questions q
        ON q.ticket_id = er.ticket_id AND q.id = a.question_item_id
      WHERE a.round_id IN (${args})
        AND a.score IN ('B', 'C', 'D')
      ORDER BY a.id
    `).all(...roundIds);
    return { primary, fallback };
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

