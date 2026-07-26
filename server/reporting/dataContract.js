'use strict';

const { reportError } = require('./reportUtils');

const REPORT_CONTEXT_SCHEMA_VERSION = 1;
const SCORING_COMPATIBILITY_MARKER = 'LEGACY_SCORING_V1_UNVERSIONED';

function validateReportContext(context) {
  const problems = [];
  if (!context || typeof context !== 'object') problems.push('context');
  if (Number(context?.context_schema_version) !== REPORT_CONTEXT_SCHEMA_VERSION) problems.push('context_schema_version');
  if (!String(context?.definition_code || '').trim()) problems.push('definition_code');
  if (!context?.ticket?.id) problems.push('ticket.id');
  if (!String(context?.ticket?.code || '').trim()) problems.push('ticket.code');
  if (!context?.ticket?.question_template_version_id) problems.push('ticket.question_template_version_id');
  if (!context?.round?.id) problems.push('round.id');
  if (![1, 2].includes(Number(context?.round?.round_no))) problems.push('round.round_no');
  if (!context?.doc4 || typeof context.doc4 !== 'object') problems.push('doc4');
  for (const key of ['related_information', 'scope', 'participants', 'supplier_introduction', 'result_summary', 'signatures']) {
    if (!context?.doc4?.[key] || typeof context.doc4[key] !== 'object' || Array.isArray(context.doc4[key])) {
      problems.push(`doc4.${key}`);
    }
  }
  for (const key of ['compliance_summary', 'nonconformity_summary']) {
    if (!Array.isArray(context?.doc4?.[key])) problems.push(`doc4.${key}`);
  }
  if (!Array.isArray(context?.doc4?.participants?.rows)) problems.push('doc4.participants.rows');
  if (!Array.isArray(context?.corrective_action_rows)) problems.push('corrective_action_rows');
  if (!Array.isArray(context?.approval_history_rows)) problems.push('approval_history_rows');
  if (context?.scoring?.scoring_policy_version_id != null) {
    if (!/^\d+$/.test(String(context.scoring.scoring_policy_version_id))) problems.push('scoring.scoring_policy_version_id');
    if (!/^[a-f0-9]{64}$/.test(String(context.scoring.scoring_policy_checksum || ''))) problems.push('scoring.scoring_policy_checksum');
    if (!/^[a-f0-9]{64}$/.test(String(context.scoring.formula_checksum || ''))) problems.push('scoring.formula_checksum');
    if (context.scoring.compatibility_marker != null) problems.push('scoring.compatibility_marker');
    if (!context.compliance_overview || !Array.isArray(context.compliance_overview.rows)
      || !Array.isArray(context.compliance_overview.columns)) problems.push('compliance_overview');
  } else if (context?.scoring?.compatibility_marker !== SCORING_COMPATIBILITY_MARKER) {
    problems.push('scoring.compatibility_marker');
  }
  if (problems.length) throw reportError('report_context_invalid', 422, { fields: problems });
  return context;
}

module.exports = {
  REPORT_CONTEXT_SCHEMA_VERSION,
  SCORING_COMPATIBILITY_MARKER,
  validateReportContext,
};
