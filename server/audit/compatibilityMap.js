'use strict';

function entity(entityType, entityId) {
  return { entityType, entityId: entityId == null ? null : String(entityId) };
}

function mapLegacyAccessAction(action, details = {}) {
  const value = String(action || 'UNKNOWN');
  if (value === 'OTP_REQUEST' || value === 'ADMIN_OTP_REQUEST') {
    return { eventName: 'auth.otp.request.succeeded', ...entity('AUTH_SESSION'), action: 'REQUEST', outcome: 'SUCCESS' };
  }
  if (value === 'OTP_REQUEST_DEGRADED') {
    return { eventName: 'auth.otp.request.degraded', ...entity('AUTH_SESSION'), action: 'REQUEST', outcome: 'DEGRADED', metadata: { delivery_channel: details.delivery_channel } };
  }
  if (value === 'OTP_REQUEST_DELIVERY_UNAVAILABLE') {
    return { eventName: 'auth.otp.delivery.unavailable', ...entity('AUTH_SESSION'), action: 'REQUEST', outcome: 'FAILURE', reasonCode: details.config_reason, metadata: { delivery_mode: details.delivery_mode, config_reason: details.config_reason } };
  }
  if (['OTP_REQUEST_INVALID_DOMAIN', 'OTP_REQUEST_NOT_ALLOWED', 'OTP_REQUEST_NCC_BLOCKED'].includes(value)) {
    return { eventName: 'auth.otp.request.failed', ...entity('AUTH_SESSION'), action: 'REQUEST', outcome: 'DENIED', reasonCode: value };
  }
  if (value === 'LOGIN' || value === 'ADMIN_LOGIN') {
    return { eventName: 'auth.login.succeeded', ...entity('AUTH_SESSION'), action: 'LOGIN', outcome: 'SUCCESS' };
  }
  if (value === 'LOGIN_SCREEN_DEGRADED') {
    return { eventName: 'auth.login.degraded', ...entity('AUTH_SESSION'), action: 'LOGIN', outcome: 'DEGRADED', metadata: { delivery_channel: details.delivery_channel } };
  }
  if (value === 'LOGOUT') return { eventName: 'auth.logout.succeeded', ...entity('AUTH_SESSION'), action: 'LOGOUT', outcome: 'SUCCESS' };
  if (value.startsWith('ACKNOWLEDGE_RULES:v')) {
    return { eventName: 'auth.rules.acknowledged', ...entity('USAGE_RULES', value.split(':v')[1]), action: 'ACKNOWLEDGE', outcome: 'SUCCESS', metadata: { rules_version: Number(value.split(':v')[1]) } };
  }
  if (value === 'USER_UPSERT') return {
    eventName: 'user.account.upserted',
    ...entity('USER', details.target),
    action: 'UPSERT',
    outcome: 'SUCCESS',
    metadata: {
      target_user_id: details.target,
      role_code: details.role_code || details.role,
      reason: details.reason,
      authz_version: details.authz_version,
    },
    before: details.before,
    after: details.after,
  };
  if (value === 'USER_DEACTIVATE') return {
    eventName: 'user.account.deactivated',
    ...entity('USER', details.target),
    action: 'DEACTIVATE',
    outcome: 'SUCCESS',
    metadata: {
      target_user_id: details.target,
      reason: details.reason,
      authz_version: details.authz_version,
    },
    before: details.before,
    after: details.after,
  };
  if (value === 'USER_REACTIVATE') return {
    eventName: 'user.account.reactivated',
    ...entity('USER', details.target),
    action: 'REACTIVATE',
    outcome: 'SUCCESS',
    metadata: {
      target_user_id: details.target,
      reason: details.reason,
      authz_version: details.authz_version,
    },
    before: details.before,
    after: details.after,
  };
  if (value === 'DB_EXPORT_REQUEST') return { eventName: 'config.backup.exported', ...entity('DATABASE_BACKUP'), action: 'EXPORT', outcome: 'SUCCESS', metadata: { table_counts: details.counts } };
  if (value === 'DB_RESTORE_REQUEST') return { eventName: 'config.restore.requested', ...entity('DATABASE_RESTORE'), action: 'RESTORE', outcome: 'SUCCESS', metadata: { table_counts: details.counts, backup_reference: details.backup } };
  if (value === 'SUPPLIER_UPSERT') return { eventName: 'supplier.created', ...entity('SUPPLIER', details.supplier_code), action: 'UPSERT', outcome: 'SUCCESS', metadata: { supplier_code: details.supplier_code, source_type: details.source_type } };
  if (value === 'SUPPLIER_UPDATE') return { eventName: 'supplier.updated', ...entity('SUPPLIER', details.supplier_id || details.supplier_code), action: 'UPDATE', outcome: 'SUCCESS', metadata: { supplier_code: details.supplier_code } };
  if (value === 'SUPPLIER_IMPORT_EXCEL') return { eventName: 'import.completed', ...entity('SUPPLIER_IMPORT', details.batch_id), action: 'IMPORT', outcome: 'SUCCESS', metadata: { source_type: 'SUPPLIER', row_count: details.success_rows, rejected_count: details.failed_rows } };
  if (value === 'UPLOAD_REJECTED') return { eventName: 'import.failed', ...entity('UPLOAD'), action: 'IMPORT', outcome: 'FAILURE', reasonCode: details.reason, metadata: { source_type: 'UPLOAD', failure_stage: details.reason } };
  if (value.startsWith('UPLOAD_') && value !== 'UPLOAD_DELETE') return { eventName: 'import.completed', ...entity('UPLOAD', details.upload_id), action: 'IMPORT', outcome: 'SUCCESS', metadata: { source_type: value.slice(7), upload_id: details.upload_id, row_count: details.rows, rejected_count: details.rejected } };
  if (value === 'UPLOAD_DELETE') return { eventName: 'artifact.deleted', ...entity('UPLOAD', details.upload_id), action: 'DELETE', outcome: 'SUCCESS', metadata: { artifact_type: 'UPLOAD', upload_id: details.upload_id } };
  return { eventName: 'audit.legacy_access.mapped', ...entity('LEGACY_ACCESS'), action: 'MAP', outcome: 'SUCCESS', metadata: { legacy_action: value } };
}

module.exports = { mapLegacyAccessAction };
