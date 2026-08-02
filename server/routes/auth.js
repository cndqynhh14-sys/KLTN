'use strict';

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const { ROLE_CODES } = require('../authorization/permissionCatalog');
const defaultOtpService = require('../services/otp');
const emailService = require('../services/email');
const { normalizeEmail, resolveOtpDeliveryConfig } = require('../domain/otpDelivery');
const defaultLogger = require('../logger');

const CURRENT_RULES_VERSION = 1;
const RE_ACK_INTERVAL_DAYS = 90;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function requestRateLimitKey(req) {
  const email = normalizeEmail(req.body?.email);
  const emailHash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
  return `${req.ip || ''}:${emailHash}`;
}

function retryAfterSeconds(req, fallback = 60) {
  const reset = req.rateLimit?.resetTime;
  if (reset instanceof Date) return Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000));
  return fallback;
}

function createRequestOtpLimiter(overrides = {}) {
  const windowMs = overrides.windowMs || boundedInteger(process.env.OTP_REQUEST_WINDOW_MS, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);
  const max = overrides.max || boundedInteger(process.env.OTP_REQUEST_MAX, 5, 1, 100);
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: requestRateLimitKey,
    handler(req, res) {
      res.locals.error_code = 'too_many_requests';
      res.status(429).json({
        error: 'too_many_requests',
        retryAfter: retryAfterSeconds(req, Math.ceil(windowMs / 1000)),
      });
    },
    ...(Object.hasOwn(overrides, 'validate') ? { validate: overrides.validate } : {}),
  });
}

function createVerifyOtpLimiter(overrides = {}) {
  const windowMs = overrides.windowMs || 15 * 60 * 1000;
  return rateLimit({
    windowMs,
    max: overrides.max || 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip || '',
    handler(req, res) {
      res.locals.error_code = 'too_many_requests';
      res.status(429).json({ error: 'too_many_requests', retryAfter: retryAfterSeconds(req, Math.ceil(windowMs / 1000)) });
    },
    ...(Object.hasOwn(overrides, 'validate') ? { validate: overrides.validate } : {}),
  });
}

function cookieOptions(ttlSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/qlcl',
    maxAge: ttlSeconds * 1000,
  };
}

function createAuthRouter(options = {}) {
  const router = express.Router();
  const dbDependencies = options.stmts && options.logAccess && options.authorizationService && options.policyService
    ? null : require('../db');
  const stmts = options.stmts || dbDependencies.stmts;
  const logAccess = options.logAccess || dbDependencies.logAccess;
  const authorizationService = options.authorizationService || dbDependencies.authorizationService;
  const policyService = options.policyService || dbDependencies.policyService;
  const otpService = options.otpService || {
    createOtpSession: defaultOtpService.createOtpSession,
    verifyOtp: defaultOtpService.verifyOtp,
    invalidate: defaultOtpService.invalidateOtpSession,
  };
  const sendEmail = options.sendEmail || emailService.sendEmail;
  const buildOtpEmail = options.buildOtpEmail || emailService.buildOtpEmail;
  const signToken = options.signToken || authMiddleware.signToken;
  const requireAuth = options.requireAuth || authMiddleware.requireAuth;
  const logger = options.logger || defaultLogger;
  const now = options.now || (() => new Date());
  const getDeliveryConfig = options.getDeliveryConfig || (() => resolveOtpDeliveryConfig(process.env, { now: now() }));
  const requestLimiter = options.requestLimiter || createRequestOtpLimiter();
  const verifyLimiter = options.verifyLimiter || createVerifyOtpLimiter();

  function needsAcknowledgeFor(user) {
    const ack = stmts.getAck.get(user.email);
    if (!ack) return true;
    if ((ack.rules_version | 0) < CURRENT_RULES_VERSION) return true;
    const ackMs = new Date(ack.acknowledged_at.replace(' ', 'T') + 'Z').getTime();
    return Number.isFinite(ackMs) && ackMs < now().getTime() - RE_ACK_INTERVAL_DAYS * 24 * 3600 * 1000;
  }

  function unavailable(req, res, config, reason = config.reason) {
    res.locals.error_code = 'otp_delivery_unavailable';
    logAccess({
      email: normalizeEmail(req.body?.email),
      action: 'OTP_REQUEST_DELIVERY_UNAVAILABLE',
      details: { delivery_mode: config.mode, config_reason: reason },
      ip: req.ip,
      ua: req.get('user-agent'),
    });
    return res.status(503).json({ error: 'otp_delivery_unavailable', retryAfter: config.retryAfterSeconds || 60 });
  }

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/request-otp', requestLimiter, async (req, res) => {
    const raw = req.body?.email;
    if (!raw || typeof raw !== 'string') {
      res.locals.error_code = 'email_required';
      return res.status(400).json({ error: 'email_required' });
    }
    const email = normalizeEmail(raw);
    const domain = (email.split('@')[1] || '').toLowerCase();
    if (!/(^|\.)masangroup\.com$/.test(domain)) {
      res.locals.error_code = 'invalid_domain';
      logAccess({ email, action: 'OTP_REQUEST_INVALID_DOMAIN', ip: req.ip, ua: req.get('user-agent') });
      return res.status(400).json({ error: 'invalid_domain' });
    }

    const config = getDeliveryConfig();
    if (!config.available) return unavailable(req, res, config);
    if (config.mode === 'screen' && !config.allowsEmail(email)) {
      return unavailable(req, res, config, 'screen_email_not_allowed');
    }

    const user = stmts.getUser.get(email);
    const identity = user ? authorizationService.identityForUser(email) : null;
    if (identity?.roleCodes.includes(ROLE_CODES.SUPPLIER_USER)) {
      res.locals.error_code = 'ncc_login_disabled';
      logAccess({ email, action: 'OTP_REQUEST_NCC_BLOCKED', ip: req.ip, ua: req.get('user-agent') });
      return res.status(403).json({ error: 'ncc_login_disabled' });
    }
    const eligible = Boolean(user);

    try {
      const created = await otpService.createOtpSession(email, {
        eligible,
        deliveryMode: config.mode,
        expiresAt: config.mode === 'screen' ? config.expiresAt : null,
        securityProfile: config.securityProfile,
      });
      const response = {
        sessionId: created.sessionId,
        deliveryMode: config.mode,
        expiresAt: created.expiresAt,
        retryAfter: config.retryAfterSeconds,
        securityProfile: config.securityProfile,
      };

      if (config.mode === 'email' && eligible) {
        const message = buildOtpEmail(created.code);
        try {
          await sendEmail({ to: email, subject: message.subject, htmlContent: message.htmlContent });
        } catch {
          await otpService.invalidate(created.sessionId);
          logger.warn('auth.otp.delivery_failed');
          return unavailable(req, res, config, 'email_delivery_failed');
        }
      }
      if (config.mode === 'screen') response.screenCode = created.code;

      if (!eligible) {
        logAccess({ email, action: 'OTP_REQUEST_NOT_ALLOWED', ip: req.ip, ua: req.get('user-agent') });
      } else if (config.mode === 'screen') {
        logAccess({
          email,
          action: 'OTP_REQUEST_DEGRADED',
          details: { delivery_channel: 'screen' },
          ip: req.ip,
          ua: req.get('user-agent'),
        });
      } else {
        logAccess({ email, action: identity.isAdmin ? 'ADMIN_OTP_REQUEST' : 'OTP_REQUEST', ip: req.ip, ua: req.get('user-agent') });
      }
      return res.json(response);
    } catch (error) {
      logger.error('auth.otp.request_failed', { error });
      return unavailable(req, res, config, 'session_store_failed');
    }
  });

  router.post('/verify-otp', verifyLimiter, async (req, res) => {
    const { sessionId, code } = req.body || {};
    if (!sessionId || !code) {
      res.locals.error_code = 'missing_fields';
      return res.status(400).json({ error: 'missing_fields' });
    }

    try {
      const result = await otpService.verifyOtp(String(sessionId), String(code));
      if (!result.ok) {
        res.locals.error_code = result.reason;
        return res.status(401).json({ error: result.reason, attemptsLeft: result.attemptsLeft });
      }

      const email = result.email;
      const user = stmts.getUser.get(email);
      if (!user) {
        res.locals.error_code = 'account_disabled';
        return res.status(403).json({ error: 'account_disabled' });
      }
      const canonicalIdentity = authorizationService.identityForUser(email);
      if (canonicalIdentity.roleCodes.includes(ROLE_CODES.SUPPLIER_USER)) {
        res.locals.error_code = 'ncc_login_disabled';
        return res.status(403).json({ error: 'ncc_login_disabled' });
      }

      const authDeliveryMode = result.deliveryMode === 'screen' ? 'screen' : 'email';
      const authSecurityProfile = result.securityProfile === 'development_relaxed'
        ? 'development_relaxed'
        : 'guarded';
      const token = signToken({ email, authDeliveryMode, authSecurityProfile });
      const identity = policyService.identityPayload(canonicalIdentity);
      const ttl = parseInt(process.env.JWT_TTL_SECONDS || '28800', 10);
      res.cookie('qlcl_token', token, cookieOptions(ttl));

      logAccess({
        email,
        action: authDeliveryMode === 'screen' ? 'LOGIN_SCREEN_DEGRADED' : (identity.isAdmin ? 'ADMIN_LOGIN' : 'LOGIN'),
        details: authDeliveryMode === 'screen' ? { delivery_channel: 'screen' } : undefined,
        ip: req.ip,
        ua: req.get('user-agent'),
      });

      return res.json({
        email,
        isAdmin: identity.isAdmin,
        role: identity.role,
        displayName: identity.displayName,
        needsAcknowledge: needsAcknowledgeFor({ email }),
        rulesVersion: CURRENT_RULES_VERSION,
        role_codes: identity.roleCodes,
        role_labels: identity.roleLabels,
        capabilities: identity.capabilities,
        authz_version: identity.authzVersion,
        policy_version: identity.policy_version,
        navigation_version: identity.navigation_version,
        action_version: identity.action_version,
        authDeliveryMode,
        authSecurityProfile,
        degradedAuth: authDeliveryMode === 'screen',
      });
    } catch (error) {
      logger.error('auth.otp.verify_failed', { error });
      res.locals.error_code = 'internal_error';
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/logout', requireAuth, (req, res) => {
    authorizationService.revokeSession(req.user.sessionId, 'LOGOUT');
    res.clearCookie('qlcl_token', { path: '/qlcl' });
    logAccess({ email: req.user.email, action: 'LOGOUT', ip: req.ip });
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (req, res) => {
    const identity = policyService.identityPayload(req.user);
    const authDeliveryMode = req.user.authDeliveryMode === 'screen' ? 'screen' : 'email';
    const authSecurityProfile = req.user.authSecurityProfile === 'development_relaxed'
      ? 'development_relaxed'
      : 'guarded';
    res.json({
      email: identity.email,
      isAdmin: !!identity.isAdmin,
      role: identity.role,
      displayName: identity.displayName,
      role_codes: identity.roleCodes,
      role_labels: identity.roleLabels,
      capabilities: identity.capabilities,
      authz_version: identity.authzVersion,
      policy_version: identity.policy_version,
      navigation_version: identity.navigation_version,
      action_version: identity.action_version,
      needsAcknowledge: needsAcknowledgeFor(identity),
      rulesVersion: CURRENT_RULES_VERSION,
      authDeliveryMode,
      authSecurityProfile,
      degradedAuth: authDeliveryMode === 'screen',
    });
  });

  router.post('/acknowledge', requireAuth, (req, res) => {
    stmts.upsertAck.run({
      email: req.user.email,
      rules_version: CURRENT_RULES_VERSION,
      ip: req.ip,
      ua: req.get('user-agent') || null,
    });
    logAccess({
      email: req.user.email,
      action: `ACKNOWLEDGE_RULES:v${CURRENT_RULES_VERSION}`,
      ip: req.ip,
      ua: req.get('user-agent'),
    });
    res.json({ ok: true, rulesVersion: CURRENT_RULES_VERSION });
  });

  return router;
}

let defaultRouter = null;
function lazyAuthRouter(req, res, next) {
  if (!defaultRouter) defaultRouter = createAuthRouter();
  return defaultRouter(req, res, next);
}

module.exports = lazyAuthRouter;
module.exports.createAuthRouter = createAuthRouter;
module.exports.createRequestOtpLimiter = createRequestOtpLimiter;
module.exports.createVerifyOtpLimiter = createVerifyOtpLimiter;
module.exports.requestRateLimitKey = requestRateLimitKey;
