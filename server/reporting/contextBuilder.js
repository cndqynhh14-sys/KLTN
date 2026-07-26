'use strict';

const { REPORT_CONTEXT_SCHEMA_VERSION, SCORING_COMPATIBILITY_MARKER, validateReportContext } = require('./dataContract');
const { reportError } = require('./reportUtils');
const ScoringPolicyRepository = require('../scoring/ScoringPolicyRepository');
const { buildComplianceOverview } = require('../scoring/scoringPolicyEngine');

function buildPinnedReportContext({ db, ticket, definition, roundNo }) {
  if (!db || !ticket) throw reportError('report_context_source_missing');
  const legacy = require('../services/reporting');
  const context = legacy.buildReportContext(db, ticket, {
    reportType: definition.code,
    roundNo,
    requireRound: true,
  });
  const questionVersionId = context.doc4?.scope?.question_template_version_id
    || ticket.question_template_version_id
    || null;
  const scoringPolicyId = context.selected_round?.scoring_policy_version_id
    || ticket.scoring_policy_version_id
    || null;
  let scoring;
  let complianceOverview = null;
  if (scoringPolicyId) {
    const policies = new ScoringPolicyRepository(db);
    const version = policies.requireVersion(scoringPolicyId);
    const policy = policies.definition(version);
    let resultSnapshot = {};
    try { resultSnapshot = JSON.parse(context.selected_round?.scoring_result_snapshot_json || '{}'); } catch { resultSnapshot = {}; }
    scoring = {
      compatibility_marker: null,
      scoring_policy_version_id: version.id,
      scoring_policy_version_no: version.version_no,
      scoring_policy_checksum: version.checksum,
      formula_checksum: version.formula_checksum,
      source: 'pinned scoring_policy_versions snapshot',
    };
    complianceOverview = buildComplianceOverview(policy, {
      categoryRows: (context.doc4?.compliance_summary || []).map((row) => ({
        ...row,
        category_code: row.category_code || null,
        category_label: row.category_label || row.category,
      })),
      result: {
        grade: resultSnapshot.grade || context.selected_round?.classification || ticket.grade_code,
        label: resultSnapshot.result_label || context.selected_round?.final_result || ticket.result_label,
        passed: resultSnapshot.passed,
        eliminated: resultSnapshot.eliminated,
      },
    });
  } else {
    // Explicit compatibility boundary for pre-RUN-19 synthetic fixtures only.
    scoring = {
      compatibility_marker: SCORING_COMPATIBILITY_MARKER,
      scoring_policy_version_id: null,
      source: 'evaluation_rounds/evaluation_answers compatibility adapter',
    };
  }
  const normalized = {
    ...context,
    context_schema_version: REPORT_CONTEXT_SCHEMA_VERSION,
    definition_code: definition.code,
    ticket: {
      id: ticket.id,
      code: ticket.ticket_code,
      question_template_version_id: questionVersionId,
    },
    round: {
      id: context.selected_round?.id || null,
      round_no: Number(context.round_no || roundNo),
      status: context.selected_round?.status || null,
      locked_at: context.selected_round?.locked_at || null,
      completed_at: context.selected_round?.completed_at || null,
    },
    scoring,
    compliance_overview: complianceOverview,
    corrective_action_rows: context.corrective_action_rows || [],
    approval_history_rows: context.approval_history_rows || [],
  };
  return validateReportContext(normalized);
}

module.exports = { buildPinnedReportContext };
