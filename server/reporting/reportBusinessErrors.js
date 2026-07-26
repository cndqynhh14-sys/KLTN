'use strict';

const NEXT_ACTIONS = Object.freeze({
  round_not_found: ['complete_required_round'],
  report_round_not_ready: ['complete_and_lock_required_round'],
  report_round_not_allowed: ['select_allowed_round'],
  report_context_invalid: ['complete_required_report_data'],
  report_binding_value_invalid: ['complete_required_report_data'],
  report_definition_not_found: ['select_canonical_report_type'],
  published_report_template_not_found: ['contact_report_publisher'],
  report_template_version_not_found: ['select_available_template_version'],
  template_not_found: ['select_canonical_report_type'],
  artifact_missing: ['run_legacy_artifact_reconciliation'],
  artifact_unavailable: ['verify_artifact_availability'],
  export_not_stored: ['run_legacy_artifact_reconciliation'],
  report_artifact_not_found: ['check_export_job_status'],
  report_legacy_mapping_pending: ['select_canonical_report_type'],
  report_legacy_creation_disabled: ['create_canonical_report_draft'],
});

function businessErrorPayload(errorOrCode, details = undefined) {
  const error = typeof errorOrCode === 'string' ? null : errorOrCode;
  const code = typeof errorOrCode === 'string'
    ? errorOrCode
    : (error?.code || 'report_operation_failed');
  const finalDetails = details === undefined ? error?.details : details;
  return {
    error: code,
    details: finalDetails && Object.keys(finalDetails).length ? finalDetails : undefined,
    allowed_next_actions: NEXT_ACTIONS[code] || ['contact_support_with_request_id'],
  };
}

module.exports = { NEXT_ACTIONS, businessErrorPayload };
