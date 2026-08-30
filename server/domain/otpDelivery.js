'use strict';

const OTP_DELIVERY_MODES = Object.freeze(['email', 'screen', 'test']);
const PRODUCTION_SCREEN_ACK = 'I_ACCEPT_TEMPORARY_SCREEN_OTP_RISK_UNTIL_EXPIRY';
const ACTIVE_DATABASE_USERS_SCOPE = 'active_database_users';
const DATABASE_SCOPE_ACK = 'I_ACCEPT_TEMPORARY_SCREEN_OTP_FOR_ACTIVE_DATABASE_USERS_UNTIL_EXPIRY';
const SCREEN_ACCOUNT_SCOPES = Object.freeze(['allow_list', ACTIVE_DATABASE_USERS_SCOPE]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_SCREEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isMasanEmail(value) {
  const email = normalizeEmail(value);
  const domain = email.split('@')[1] || '';
  return Boolean(email.split('@')[0]) && /(^|\.)masangroup\.com$/.test(domain);
}

function isProductionEnvironment(env) {
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  const appEnv = String(env.APP_ENV || '').trim().toLowerCase();
  return nodeEnv === 'production' || appEnv === 'production' || appEnv === 'prd';
}

function isExactDevelopmentEnvironment(env) {
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  const appEnv = String(env.APP_ENV || '').trim().toLowerCase();
  return nodeEnv === 'development' && ['', 'development', 'dev', 'local'].includes(appEnv);
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function unavailable(mode, reason, retryAfterSeconds) {
  return Object.freeze({
    available: false,
    mode: OTP_DELIVERY_MODES.includes(mode) ? mode : 'unavailable',
    reason,
    retryAfterSeconds,
    accountScope: null,
    allowsEmail: () => false,
  });
}

function exactEmailAllowList(value) {
  const entries = String(value || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
  if (!entries.length || entries.some((email) => (
    email.includes('*') || !/^[^@\s]+@(?:[^@\s]+\.)?masangroup\.com$/.test(email)
  ))) return null;
  return [...new Set(entries)];
}

function resolveOtpDeliveryConfig(env = process.env, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const mode = String(env.OTP_DELIVERY_MODE || 'email').trim().toLowerCase();
  const retryAfterSeconds = positiveInteger(env.OTP_RESEND_COOLDOWN_SECONDS, 60, 1, 300);

  if (env.DEV_SHOW_OTP === 'true' || env.SHOW_TEST_OTP === 'true') {
    return unavailable(mode, 'legacy_otp_flag_forbidden', retryAfterSeconds);
  }
  if (!OTP_DELIVERY_MODES.includes(mode)) return unavailable(mode, 'delivery_mode_invalid', retryAfterSeconds);

  const hmacSecret = String(env.OTP_HMAC_SECRET || '');
  if (Buffer.byteLength(hmacSecret, 'utf8') < 32) {
    return unavailable(mode, 'otp_hmac_secret_invalid', retryAfterSeconds);
  }
  if (env.JWT_SECRET && hmacSecret === String(env.JWT_SECRET)) {
    return unavailable(mode, 'otp_hmac_secret_reused', retryAfterSeconds);
  }

  if (mode === 'email') {
    return Object.freeze({
      available: true,
      mode,
      retryAfterSeconds,
      expiresAt: null,
      securityProfile: 'guarded',
      productionReady: true,
      accountScope: null,
      allowsEmail: () => true,
    });
  }

  if (mode === 'test') {
    if (env.NODE_ENV !== 'test') return unavailable(mode, 'test_mode_forbidden', retryAfterSeconds);
    return Object.freeze({
      available: true,
      mode,
      retryAfterSeconds,
      expiresAt: null,
      securityProfile: 'test_only',
      productionReady: false,
      accountScope: null,
      allowsEmail: () => true,
    });
  }

  if (env.SCREEN_OTP_ENABLED !== 'true') return unavailable(mode, 'screen_disabled', retryAfterSeconds);
  if (env.SCREEN_OTP_DEV_RELAXED === 'true') {
    if (!isExactDevelopmentEnvironment(env) || isProductionEnvironment(env)) {
      return unavailable(mode, 'development_relaxed_forbidden', retryAfterSeconds);
    }
    return Object.freeze({
      available: true,
      mode,
      retryAfterSeconds,
      expiresAt: null,
      securityProfile: 'development_relaxed',
      productionReady: false,
      accountScope: 'masan_domain',
      allowsEmail: isMasanEmail,
    });
  }
  const rawExpiry = String(env.SCREEN_OTP_EXPIRES_AT || '').trim();
  if (!ISO_INSTANT.test(rawExpiry)) return unavailable(mode, 'screen_expiry_invalid', retryAfterSeconds);
  const expiry = new Date(rawExpiry);
  if (!Number.isFinite(expiry.getTime())) return unavailable(mode, 'screen_expiry_invalid', retryAfterSeconds);
  if (expiry.getTime() <= now.getTime()) return unavailable(mode, 'screen_expired', retryAfterSeconds);
  if (expiry.getTime() - now.getTime() > MAX_SCREEN_WINDOW_MS) {
    return unavailable(mode, 'screen_expiry_too_far', retryAfterSeconds);
  }

  const owner = String(env.SCREEN_OTP_OWNER || '').trim();
  if (!owner || owner.length > 320) return unavailable(mode, 'screen_owner_required', retryAfterSeconds);
  const accountScope = String(env.SCREEN_OTP_ACCOUNT_SCOPE || 'allow_list').trim().toLowerCase();
  if (!SCREEN_ACCOUNT_SCOPES.includes(accountScope)) {
    return unavailable(mode, 'screen_account_scope_invalid', retryAfterSeconds);
  }
  const rawAllowList = String(env.SCREEN_OTP_ALLOWED_EMAILS || '').trim();
  const allowedEmails = rawAllowList ? exactEmailAllowList(rawAllowList) : [];
  if (rawAllowList && !allowedEmails) return unavailable(mode, 'screen_allow_list_invalid', retryAfterSeconds);
  if (accountScope === 'allow_list' && !allowedEmails.length) {
    return unavailable(mode, 'screen_allow_list_required', retryAfterSeconds);
  }
  if (isProductionEnvironment(env) && env.SCREEN_OTP_PRODUCTION_ACK !== PRODUCTION_SCREEN_ACK) {
    return unavailable(mode, 'production_acknowledgement_required', retryAfterSeconds);
  }
  if (isProductionEnvironment(env) && accountScope === ACTIVE_DATABASE_USERS_SCOPE
      && env.SCREEN_OTP_DATABASE_SCOPE_ACK !== DATABASE_SCOPE_ACK) {
    return unavailable(mode, 'database_scope_acknowledgement_required', retryAfterSeconds);
  }

  const allowed = new Set(allowedEmails);
  return Object.freeze({
    available: true,
    mode,
    retryAfterSeconds,
    expiresAt: expiry.toISOString(),
    securityProfile: 'guarded',
    productionReady: true,
    accountScope,
    allowsEmail: (email) => allowed.has(normalizeEmail(email)),
  });
}

function otpReadiness(env = process.env, options = {}) {
  const config = resolveOtpDeliveryConfig(env, options);
  if (!config.available) {
    return {
      status: 'degraded',
      component: 'otp_delivery',
      error: 'otp_delivery_unavailable',
      reason: config.reason,
      mode: config.mode,
    };
  }
  return {
    status: 'ready',
    component: 'otp_delivery',
    mode: config.mode,
    expiresAt: config.expiresAt || null,
    accountScope: config.accountScope || null,
    securityProfile: config.securityProfile || 'guarded',
    productionReady: config.productionReady !== false,
  };
}

module.exports = {
  ACTIVE_DATABASE_USERS_SCOPE,
  DATABASE_SCOPE_ACK,
  OTP_DELIVERY_MODES,
  PRODUCTION_SCREEN_ACK,
  exactEmailAllowList,
  normalizeEmail,
  otpReadiness,
  resolveOtpDeliveryConfig,
};
