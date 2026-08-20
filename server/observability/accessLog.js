const { redact, sanitizeString } = require('./redact');

const ACTION_FIELDS = Object.freeze({
  OTP_REQUEST_DEGRADED: ['delivery_channel'],
  OTP_REQUEST_DELIVERY_UNAVAILABLE: ['delivery_mode', 'config_reason'],
  LOGIN_SCREEN_DEGRADED: ['delivery_channel'],
  USER_UPSERT: ['target', 'role', 'role_code', 'is_admin', 'reason', 'authz_version', 'before', 'after'],
  USER_DEACTIVATE: ['target', 'reason', 'authz_version', 'before', 'after'],
  USER_REACTIVATE: ['target', 'reason', 'authz_version', 'before', 'after'],
  DB_EXPORT_REQUEST: ['counts'],
  DB_RESTORE_REQUEST: ['counts', 'backup'],
  SUPPLIER_UPSERT: ['supplier_code', 'source_type'],
  SUPPLIER_UPDATE: ['supplier_id', 'supplier_code'],
  SUPPLIER_IMPORT_EXCEL: ['batch_id', 'filename', 'total_rows', 'success_rows', 'failed_rows'],
});

const NO_DETAIL_ACTIONS = new Set([
  'OTP_REQUEST_INVALID_DOMAIN',
  'OTP_REQUEST_NOT_ALLOWED',
  'OTP_REQUEST_NCC_BLOCKED',
  'OTP_REQUEST',
  'ADMIN_OTP_REQUEST',
  'LOGIN',
  'ADMIN_LOGIN',
  'LOGOUT',
]);

function allowedFieldsForAction(action) {
  if (String(action).startsWith('ACKNOWLEDGE_RULES:v')) return [];
  if (NO_DETAIL_ACTIONS.has(action)) return [];
  return ACTION_FIELDS[action] || [];
}

function sanitizeAccessDetails(action, details) {
  const allowed = allowedFieldsForAction(action);
  if (!details || typeof details !== 'object' || Array.isArray(details) || allowed.length === 0) return null;
  const selected = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(details, key)) selected[key] = details[key];
  }
  return Object.keys(selected).length ? redact(selected) : null;
}

function sanitizeAccessText(value, maxLength) {
  if (value == null) return null;
  return sanitizeString(value, maxLength);
}

module.exports = {
  ACTION_FIELDS,
  NO_DETAIL_ACTIONS,
  allowedFieldsForAction,
  sanitizeAccessDetails,
  sanitizeAccessText,
};
