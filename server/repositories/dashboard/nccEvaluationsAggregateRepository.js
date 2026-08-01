class NccEvaluationsAggregateRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      roundCandidates: db.prepare(`
        WITH round_facts AS (
          SELECT
            r.id AS round_id,
            r.ticket_id,
            r.round_no,
            r.assessment_date,
            r.completed_at,
            r.locked_at,
            r.started_at,
            r.total_score,
            r.final_result AS round_final_result,
            r.classification AS round_classification,
            CASE
              WHEN NULLIF(TRIM(r.assessment_date), '') IS NOT NULL
               AND date(NULLIF(TRIM(r.assessment_date), '')) IS NOT NULL
                THEN NULLIF(TRIM(r.assessment_date), '')
              WHEN NULLIF(TRIM(r.completed_at), '') IS NOT NULL
               AND date(NULLIF(TRIM(r.completed_at), '')) IS NOT NULL
                THEN NULLIF(TRIM(r.completed_at), '')
              WHEN NULLIF(TRIM(r.locked_at), '') IS NOT NULL
               AND date(NULLIF(TRIM(r.locked_at), '')) IS NOT NULL
                THEN NULLIF(TRIM(r.locked_at), '')
              ELSE NULL
            END AS reporting_at,
            COALESCE(NULLIF(TRIM(r.completed_at), ''), NULLIF(TRIM(r.locked_at), ''), NULLIF(TRIM(r.assessment_date), ''), NULLIF(TRIM(r.started_at), '')) AS completion_at
          FROM evaluation_rounds r
          WHERE r.locked_at IS NOT NULL
             OR r.completed_at IS NOT NULL
             OR LOWER(TRIM(COALESCE(r.status, ''))) IN ('hoàn thành', 'hoan thanh', 'completed')
        )
        SELECT
          rf.*,
          t.id AS ticket_primary_key,
          t.ticket_code,
          t.supplier_id,
          t.supplier_code,
          t.supplier_name,
          t.current_status,
          t.result_label AS ticket_result_label,
          t.final_conclusion AS ticket_final_conclusion,
          t.product_group,
          t.mch3,
          t.mch2,
          supplier_by_id.id AS supplier_master_id,
          supplier_by_code.id AS supplier_code_master_id
        FROM round_facts rf
        JOIN evaluation_tickets t ON t.id = rf.ticket_id
        LEFT JOIN supplier_master supplier_by_id ON supplier_by_id.id = t.supplier_id
        LEFT JOIN supplier_master supplier_by_code ON UPPER(TRIM(supplier_by_code.supplier_code)) = UPPER(TRIM(t.supplier_code))
        WHERE COALESCE(t.is_deleted, 0) = 0
          AND COALESCE(t.current_status, '') NOT IN ('Hủy', 'Huy')
          AND rf.reporting_at >= @month_start
          AND rf.reporting_at < @next_month_start
        ORDER BY rf.reporting_at DESC, rf.completion_at DESC, rf.round_no DESC, rf.round_id DESC
      `),
      dataQuality: db.prepare(`
        WITH round_facts AS (
          SELECT
            r.id AS round_id,
            CASE
              WHEN NULLIF(TRIM(r.assessment_date), '') IS NOT NULL
               AND date(NULLIF(TRIM(r.assessment_date), '')) IS NOT NULL
                THEN NULLIF(TRIM(r.assessment_date), '')
              WHEN NULLIF(TRIM(r.completed_at), '') IS NOT NULL
               AND date(NULLIF(TRIM(r.completed_at), '')) IS NOT NULL
                THEN NULLIF(TRIM(r.completed_at), '')
              WHEN NULLIF(TRIM(r.locked_at), '') IS NOT NULL
               AND date(NULLIF(TRIM(r.locked_at), '')) IS NOT NULL
                THEN NULLIF(TRIM(r.locked_at), '')
              ELSE NULL
            END AS reporting_at
          FROM evaluation_rounds r
          JOIN evaluation_tickets t ON t.id = r.ticket_id
          WHERE COALESCE(t.is_deleted, 0) = 0
            AND COALESCE(t.current_status, '') NOT IN ('Hủy', 'Huy')
            AND (
              r.locked_at IS NOT NULL
              OR r.completed_at IS NOT NULL
              OR LOWER(TRIM(COALESCE(r.status, ''))) IN ('hoàn thành', 'hoan thanh', 'completed')
            )
        )
        SELECT
          SUM(CASE WHEN reporting_at IS NULL THEN 1 ELSE 0 END) AS excluded_missing_reporting_date
        FROM round_facts
      `),
      reportingMonths: db.prepare(`
        SELECT
          substr(COALESCE(assessment_date, completed_at, locked_at), 1, 7) AS report_month,
          MAX(COALESCE(completed_at, locked_at, started_at)) AS updated_at
        FROM evaluation_rounds
        WHERE COALESCE(assessment_date, completed_at, locked_at) IS NOT NULL
        GROUP BY substr(COALESCE(assessment_date, completed_at, locked_at), 1, 7)
        HAVING report_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
          AND CAST(substr(report_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
        ORDER BY report_month DESC
      `),
    };
  }

  listRoundCandidates(range) {
    return this.statements.roundCandidates.all({
      month_start: range.monthStart,
      next_month_start: range.nextMonthStart,
    });
  }

  dataQualityCounts() {
    return this.statements.dataQuality.get() || {};
  }

  listReportingMonths() {
    return this.statements.reportingMonths.all();
  }

  listViolationSources(roundIds) {
    if (!roundIds.length) return { primary: [], fallback: [] };
    const placeholders = roundIds.map(() => '?').join(', ');
    const primary = this.db.prepare(`
      SELECT
        'primary' AS source,
        nc.round_id,
        nc.clause_code,
        nc.category,
        nc.nonconformity_content AS nonconformity,
        q.question_code,
        q.question_text
      FROM evaluation_nonconformities nc
      JOIN evaluation_rounds er ON er.id = nc.round_id
      LEFT JOIN pinned_evaluation_questions q ON q.ticket_id = er.ticket_id AND q.id = nc.question_id
      WHERE nc.round_id IN (${placeholders})
        AND COALESCE(nc.status, 'OPEN') != 'CANCELLED'
    `).all(...roundIds);
    const fallback = this.db.prepare(`
      SELECT
        'fallback' AS source,
        a.round_id,
        NULL AS clause_code,
        q.category,
        NULL AS nonconformity,
        q.question_code,
        q.question_text
      FROM evaluation_answers a
      JOIN evaluation_rounds er ON er.id = a.round_id
      JOIN pinned_evaluation_questions q ON q.ticket_id = er.ticket_id AND q.id = a.question_id
      WHERE a.round_id IN (${placeholders})
        AND a.score IN ('B', 'C', 'D')
    `).all(...roundIds);
    return { primary, fallback };
  }
}

module.exports = NccEvaluationsAggregateRepository;
