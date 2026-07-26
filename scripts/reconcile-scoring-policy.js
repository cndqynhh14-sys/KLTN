'use strict';

const { db } = require('../server/db');
const {
  GOLDEN_V1_DEFINITION,
  classifyWithPolicy,
  definitionChecksum,
  formulaChecksum,
} = require('../server/scoring/scoringPolicyEngine');

function count(sql, params = []) {
  return Number(db.prepare(sql).get(...params).n || 0);
}

function main() {
  const published = db.prepare(`
    SELECT v.id, v.version_no, v.checksum, v.formula_checksum
    FROM scoring_policy_assignments a
    JOIN scoring_policy_versions v ON v.id=a.scoring_policy_version_id
    WHERE a.active=1 AND a.is_default=1 AND v.status='PUBLISHED'
      AND a.template_id IS NULL AND a.facility_type='ALL'
      AND a.supplier_scale='ALL' AND a.evaluation_type='ALL'
    LIMIT 1
  `).get() || null;
  const boundaries = [59.999, 60, 75, 75.000001, 90, 90.000001];
  const expectedGrades = ['D', 'C', 'C', 'B', 'B', 'A'];
  const actualGrades = boundaries.map((score) => classifyWithPolicy(GOLDEN_V1_DEFINITION, score, false).grade);
  const report = {
    work_item: 'RUN-19',
    mode: 'DRY_RUN',
    mutation: false,
    decision: {
      id: 'SCORE-001',
      status: 'PENDING',
      publish_enabled: process.env.SCORING_POLICY_PUBLISH_ACK === 'SCORE-001:APPROVED',
    },
    golden_v1: {
      definition_checksum: definitionChecksum(GOLDEN_V1_DEFINITION),
      formula_checksum: formulaChecksum(GOLDEN_V1_DEFINITION),
      boundaries: boundaries.map((score, index) => ({ score, expected_grade: expectedGrades[index], actual_grade: actualGrades[index] })),
      unexpected_conclusion_change_count: actualGrades.filter((grade, index) => grade !== expectedGrades[index]).length,
    },
    published_default: published,
    categories: {
      evaluation_question_count: count('SELECT COUNT(*) AS n FROM evaluation_questions'),
      evaluation_question_unmapped_count: count("SELECT COUNT(*) AS n FROM evaluation_questions WHERE category_code IS NULL OR trim(category_code)=''"),
      version_item_count: count('SELECT COUNT(*) AS n FROM question_items'),
      version_item_unmapped_count: count("SELECT COUNT(*) AS n FROM question_items WHERE category_code IS NULL OR trim(category_code)=''"),
    },
    pins: {
      ticket_unpinned_count: count('SELECT COUNT(*) AS n FROM evaluation_tickets WHERE scoring_policy_version_id IS NULL'),
      round_unpinned_count: count('SELECT COUNT(*) AS n FROM evaluation_rounds WHERE scoring_policy_version_id IS NULL'),
      ticket_round_mismatch_count: count(`
        SELECT COUNT(*) AS n FROM evaluation_rounds r
        JOIN evaluation_tickets t ON t.id=r.ticket_id
        WHERE r.scoring_policy_version_id IS NOT t.scoring_policy_version_id
      `),
      locked_round_missing_snapshot_count: count(`
        SELECT COUNT(*) AS n FROM evaluation_rounds
        WHERE locked_at IS NOT NULL AND scoring_result_snapshot_json IS NULL
      `),
    },
    artifacts: {
      versioned_job_count: count('SELECT COUNT(*) AS n FROM report_export_jobs WHERE scoring_policy_version_id IS NOT NULL'),
      legacy_marker_job_count: count("SELECT COUNT(*) AS n FROM report_export_jobs WHERE scoring_rules_marker='LEGACY_RULES_V1'"),
      versioned_job_missing_checksum_count: count(`
        SELECT COUNT(*) AS n FROM report_export_jobs
        WHERE scoring_policy_version_id IS NOT NULL AND scoring_policy_checksum IS NULL
      `),
    },
  };
  const blockers = [
    !published ? 'published_default_missing' : null,
    report.golden_v1.unexpected_conclusion_change_count ? 'golden_v1_changed' : null,
    report.categories.evaluation_question_unmapped_count ? 'evaluation_category_unmapped' : null,
    report.categories.version_item_unmapped_count ? 'version_category_unmapped' : null,
    report.pins.ticket_unpinned_count ? 'ticket_unpinned' : null,
    report.pins.round_unpinned_count ? 'round_unpinned' : null,
    report.pins.ticket_round_mismatch_count ? 'ticket_round_policy_mismatch' : null,
    report.artifacts.versioned_job_missing_checksum_count ? 'artifact_policy_checksum_missing' : null,
  ].filter(Boolean);
  report.blockers = blockers;
  report.status = blockers.length ? 'FAILED' : 'CLEAN';
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (blockers.length) process.exitCode = 1;
}

try {
  main();
} finally {
  db.close();
}
