'use strict';

const AUDIT_CATALOG_VERSION = '1.7.0';
const AUDIT_CATEGORIES = Object.freeze([
  'auth', 'authz', 'user', 'role', 'supplier', 'dossier', 'evaluation',
  'approval', 'question', 'report', 'scoring', 'import', 'export',
  'artifact', 'config', 'audit', 'uat',
]);

const COMMON_METADATA = Object.freeze(['method', 'route', 'status_code']);

function definition(name, category, severity = 'INFO', metadataFields = [], diffFields = []) {
  return Object.freeze({
    name,
    category,
    severity,
    metadataFields: Object.freeze([...new Set([...COMMON_METADATA, ...metadataFields])]),
    diffFields: Object.freeze([...diffFields]),
  });
}

const definitions = [
  definition('auth.otp.request.succeeded', 'auth'),
  definition('auth.otp.request.failed', 'auth', 'WARN'),
  definition('auth.otp.request.rate_limited', 'auth', 'HIGH'),
  definition('auth.otp.request.degraded', 'auth', 'WARN', ['delivery_channel']),
  definition('auth.otp.delivery.unavailable', 'auth', 'HIGH', ['delivery_mode', 'config_reason']),
  definition('auth.login.succeeded', 'auth'),
  definition('auth.login.degraded', 'auth', 'WARN', ['delivery_channel']),
  definition('auth.login.failed', 'auth', 'WARN'),
  definition('auth.login.rate_limited', 'auth', 'HIGH'),
  definition('auth.logout.succeeded', 'auth'),
  definition('auth.rules.acknowledged', 'auth', 'INFO', ['rules_version']),

  definition('authz.compatibility.synced', 'authz', 'INFO', ['role_code']),
  definition('authz.permission.denied', 'authz', 'HIGH', ['permission_code', 'scope_type']),
  definition('authz.scope.assigned', 'authz', 'HIGH', ['scope_type', 'scope_value', 'effect']),
  definition('authz.exported', 'authz', 'HIGH', ['export_format', 'row_count', 'filter_names']),
  definition('role.assignment.changed', 'role', 'HIGH', ['role_code', 'change_type']),
  definition('role.catalog.changed', 'role', 'HIGH', ['role_code', 'change_type', 'reason', 'authz_version'], ['display_label', 'active', 'role_kind']),
  definition('role.permissions.changed', 'role', 'HIGH', ['role_code', 'change_type', 'reason', 'authz_version'], ['permissions', 'authz_version']),
  definition('user.authorization.changed', 'authz', 'HIGH', ['target_user_id', 'change_type', 'reason', 'authz_version'], ['role_codes', 'scopes', 'authz_version']),
  definition('approval.assignment.changed', 'approval', 'HIGH', ['workflow_type', 'stage_code', 'reason', 'authz_version'], ['assignedUserId', 'roleCode', 'scopeType', 'scopeValue', 'priority', 'active']),
  definition('user.account.upserted', 'user', 'HIGH',
    ['target_user_id', 'role_code', 'reason', 'authz_version'],
    ['active', 'display_name', 'role_code']),
  definition('user.account.deactivated', 'user', 'HIGH',
    ['target_user_id', 'reason', 'authz_version'], ['active']),
  definition('user.account.reactivated', 'user', 'HIGH',
    ['target_user_id', 'reason', 'authz_version'], ['active']),

  definition('supplier.created', 'supplier', 'INFO', ['supplier_code', 'source_type'], ['supplier_name', 'region']),
  definition('supplier.updated', 'supplier', 'INFO', ['supplier_code', 'source_type'], ['supplier_name', 'region']),
  definition('dossier.created', 'dossier', 'INFO', ['dossier_code']),
  definition('dossier.updated', 'dossier', 'INFO', ['dossier_code'], ['status', 'conclusion', 'qa_owner']),
  definition('dossier.cancelled', 'dossier', 'WARN', ['dossier_code']),
  definition('dossier.item.updated', 'dossier', 'INFO', ['dossier_code', 'item_id'], ['status', 'conclusion']),
  definition('dossier.item.cancelled', 'dossier', 'WARN', ['dossier_code', 'item_id']),
  definition('dossier.review.recorded', 'dossier', 'INFO', ['dossier_code', 'item_id', 'review_id']),
  definition('evaluation.created', 'evaluation', 'INFO', ['ticket_code']),
  definition('evaluation.updated', 'evaluation', 'INFO', ['ticket_code'], ['current_status', 'round_no']),
  definition('evaluation.deleted', 'evaluation', 'HIGH', ['ticket_code']),
  definition('evaluation.workflow.transitioned', 'evaluation', 'INFO', ['ticket_code', 'from_status', 'to_status']),
  definition('approval.decision.recorded', 'approval', 'HIGH', ['workflow_type', 'stage_code', 'decision', 'task_id']),
  definition('question.template.changed', 'question', 'HIGH', ['template_id', 'question_id', 'change_type']),
  definition('question.import.previewed', 'import', 'INFO', ['template_id', 'version_id', 'batch_id']),
  definition('question.import.committed', 'import', 'HIGH', ['template_id', 'version_id', 'batch_id']),
  definition('question.import.rolled_back', 'import', 'WARN', ['template_id', 'version_id', 'batch_id']),
  definition('question.import.failed', 'import', 'WARN', ['template_id', 'version_id', 'failure_stage']),
  definition('personnel.import.previewed', 'import', 'INFO', ['batch_id', 'source_checksum', 'row_count', 'size_bytes']),
  definition('personnel.import.validated', 'import', 'INFO', ['batch_id', 'plan_checksum', 'row_count', 'error_count', 'risk_flags']),
  definition('personnel.import.committed', 'import', 'HIGH', [
    'batch_id', 'source_checksum', 'plan_checksum', 'counts', 'risk_flags', 'reason', 'authz_version',
  ]),
  definition('personnel.import.failed', 'import', 'WARN', ['batch_id', 'failure_stage']),
  definition('report.template.changed', 'report', 'HIGH', ['template_id', 'report_type', 'change_type']),
  definition('scoring.answers.updated', 'scoring', 'INFO', ['ticket_id', 'round_no', 'answer_count']),
  definition('scoring.round.completed', 'scoring', 'HIGH', ['ticket_id', 'round_no', 'score']),

  definition('import.completed', 'import', 'INFO', ['source_type', 'upload_id', 'row_count', 'rejected_count']),
  definition('import.failed', 'import', 'WARN', ['source_type', 'failure_stage']),
  definition('export.generated', 'export', 'INFO', ['report_type', 'artifact_id', 'row_count', 'dossier_count']),
  definition('export.failed', 'export', 'WARN', ['report_type', 'failure_stage']),
  definition('artifact.created', 'artifact', 'INFO', ['artifact_type', 'artifact_id', 'size_bytes']),
  definition('artifact.downloaded', 'artifact', 'INFO', ['artifact_type', 'artifact_id']),
  definition('artifact.deleted', 'artifact', 'HIGH', ['artifact_type', 'artifact_id', 'upload_id']),
  definition('config.backup.exported', 'config', 'HIGH', ['table_counts']),
  definition('config.restore.requested', 'config', 'CRITICAL', ['table_counts', 'backup_reference']),
  definition('config.changed', 'config', 'HIGH', ['config_key']),
  definition('audit.chain.verified', 'audit', 'INFO', ['checked_count', 'failure_count']),
  definition('audit.read', 'audit', 'INFO', ['access_type', 'target_event_id', 'row_count', 'filter_names']),
  definition('audit.export', 'audit', 'HIGH', ['access_type', 'export_format', 'row_count', 'filter_names']),
  definition('audit.legacy_access.mapped', 'audit', 'WARN', ['legacy_action']),
  definition('audit.write.failed', 'audit', 'CRITICAL', ['failed_event_name', 'failure_code']),
  definition('uat.request.observed', 'uat', 'INFO', ['scenario', 'status_code']),
];

const EVENT_CATALOG = Object.freeze(Object.fromEntries(definitions.map((item) => [item.name, item])));

function getAuditEventDefinition(eventName) {
  return EVENT_CATALOG[String(eventName || '')] || null;
}

module.exports = {
  AUDIT_CATALOG_VERSION,
  AUDIT_CATEGORIES,
  EVENT_CATALOG,
  getAuditEventDefinition,
};
