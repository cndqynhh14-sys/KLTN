// JWT verification middleware. Reads cookie 'qlcl_token'.
// Tokens are signed with the same JWT_SECRET as masan-rms and cht, but with
// audience=qlcl-app so cross-app tokens cannot be reused here.

const jwt = require('jsonwebtoken');
const { ROLE_CODES, LEGACY_ROLE_TO_CODE } = require('../authorization/permissionCatalog');
const logger = require('../logger');
const { setActor } = require('../observability/context');

const AUDIENCE = process.env.JWT_AUDIENCE || 'qlcl-app';
const SECRET = process.env.JWT_SECRET;

if (!SECRET) {
  logger.error('FATAL: JWT_SECRET not set');
  process.exit(1);
}

function authzService() {
  // Lazy import avoids coupling database bootstrap to HTTP middleware loading.
  return require('../db').authorizationService;
}

function signToken(payload, ttlSeconds) {
  const ttl = ttlSeconds || parseInt(process.env.JWT_TTL_SECONDS || '28800', 10);
  const email = String(payload?.sub || payload?.email || '').trim().toLowerCase();
  const authDeliveryMode = payload?.authDeliveryMode === 'screen' ? 'screen' : 'email';
  const authSecurityProfile = payload?.authSecurityProfile === 'development_relaxed'
    ? 'development_relaxed'
    : 'guarded';
  const session = authzService().createSession(email, { ttlSeconds: ttl });
  return jwt.sign({
    sub: email,
    sid: session.sessionId,
    av: session.authzVersion,
    am: authDeliveryMode,
    asp: authSecurityProfile,
  }, SECRET, {
    algorithm: 'HS256',
    expiresIn: ttl,
    issuer: 'masan-rms',
    audience: AUDIENCE,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.qlcl_token;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const decoded = jwt.verify(token, SECRET, { issuer: 'masan-rms', audience: AUDIENCE });
    if (decoded.sub && decoded.sid && decoded.av !== undefined) {
      req.user = authzService().resolveSession(decoded.sid, decoded.sub, decoded.av);
      req.user.sessionId = decoded.sid;
      req.user.authDeliveryMode = decoded.am === 'screen' ? 'screen' : 'email';
      req.user.authSecurityProfile = decoded.asp === 'development_relaxed' ? 'development_relaxed' : 'guarded';
    } else {
      return res.status(401).json({ error: 'invalid_token', code: 'AUTH_SESSION_INVALID', request_id: req.requestId });
    }
    setActor(req.user);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token', code: e.code || 'AUTH_SESSION_INVALID', request_id: req.requestId });
  }
}

// Admin-only guard — mount after requireAuth.
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.roleCodes?.includes(ROLE_CODES.SYS_ADMIN)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function requireRole(roles) {
  const requested = Array.isArray(roles) ? roles : [roles];
  const allowed = new Set(requested.map((role) => LEGACY_ROLE_TO_CODE[role] || role));
  return (req, res, next) => {
    if (!req.user || !req.user.roleCodes?.some((roleCode) => allowed.has(roleCode))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

function requireInternal(req, res, next) {
  if (!req.user || req.user.roleCodes?.includes(ROLE_CODES.SUPPLIER_USER)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

module.exports = { signToken, requireAuth, requireAdmin, requireRole, requireInternal };
