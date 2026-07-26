const crypto = require('node:crypto');
const logger = require('../logger');
const { runWithContext } = require('../observability/context');

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function validClientId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function clientId(req, headerName, fallback) {
  const value = req.get(headerName);
  if (validClientId(value)) return { value, source: 'client', rejected: false };
  return { value: fallback(), source: 'generated', rejected: value != null && value !== '' };
}

function normalizeFallbackPath(pathname) {
  return String(pathname || '/')
    .split('/')
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ':id';
      if (/^[0-9a-f]{24,}$/i.test(segment)) return ':id';
      return segment;
    })
    .join('/') || '/';
}

function normalizedRoute(req) {
  const pathname = String(req.originalUrl || req.url || '/').split('?')[0];
  const routePath = req.route && typeof req.route.path === 'string' ? req.route.path : null;
  if (!routePath) return normalizeFallbackPath(pathname);
  if (routePath === '/' || routePath === pathname) return normalizeFallbackPath(pathname);

  const originalSegments = pathname.split('/').filter(Boolean);
  const routeSegments = routePath.split('/').filter(Boolean);
  if (routeSegments.length <= originalSegments.length) {
    const prefix = originalSegments.slice(0, originalSegments.length - routeSegments.length);
    return `/${[...prefix, ...routeSegments].join('/')}`;
  }
  return normalizeFallbackPath(pathname);
}

function eventCodeForStatus(statusCode) {
  if (statusCode === 401) return 'AUTH_UNAUTHORIZED';
  if (statusCode === 403) return 'AUTH_FORBIDDEN';
  if (statusCode === 429) return 'RATE_LIMITED';
  if (statusCode >= 500) return 'HTTP_SERVER_ERROR';
  if (statusCode >= 400) return 'HTTP_CLIENT_ERROR';
  return 'HTTP_SUCCESS';
}

function stripStackFields(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stripStackFields(item, seen));
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === 'stack') continue;
    output[key] = stripStackFields(child, seen);
  }
  return output;
}

function enhanceErrorPayload(body, requestId) {
  const base = body && typeof body === 'object' && !Array.isArray(body)
    ? stripStackFields(body)
    : { error: 'request_failed' };
  const errorCode = typeof base.error_code === 'string'
    ? base.error_code
    : (typeof base.error === 'string' ? base.error : 'request_failed');
  return { ...base, error_code: errorCode, request_id: requestId };
}

function requestContext(options = {}) {
  const requestLogger = options.logger || logger;
  const idFactory = options.idFactory || (() => crypto.randomUUID());

  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    const requestIdResult = clientId(req, 'x-request-id', idFactory);
    const correlationIdResult = clientId(req, 'x-correlation-id', () => requestIdResult.value);
    const uatHeader = req.get('x-uat-run-id');
    const uatRunId = validClientId(uatHeader) ? uatHeader : null;
    const rejectedClientIds = [];
    if (requestIdResult.rejected) rejectedClientIds.push('request_id');
    if (correlationIdResult.rejected) rejectedClientIds.push('correlation_id');
    if (uatHeader && !uatRunId) rejectedClientIds.push('uat_run_id');

    const context = {
      request_id: requestIdResult.value,
      correlation_id: correlationIdResult.value,
      uat_run_id: uatRunId,
      method: req.method,
      route: normalizeFallbackPath(String(req.originalUrl || req.url || '/').split('?')[0]),
      actor: null,
      duration_ms: null,
    };

    runWithContext(context, () => {
      res.locals.operational_logger = requestLogger;
      res.setHeader('X-Request-Id', context.request_id);
      res.setHeader('X-Correlation-Id', context.correlation_id);
      if (context.uat_run_id) res.setHeader('X-UAT-Run-Id', context.uat_run_id);

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 400) {
          const enhanced = enhanceErrorPayload(body, context.request_id);
          res.locals.error_code = enhanced.error_code;
          return originalJson(enhanced);
        }
        return originalJson(body);
      };

      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        context.route = normalizedRoute(req);
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        context.duration_ms = Number(durationMs.toFixed(3));
        requestLogger.info('http.request.completed', {
          status_code: res.statusCode,
          duration_ms: context.duration_ms,
          event_code: eventCodeForStatus(res.statusCode),
          error_code: res.locals.error_code || null,
          content_length: Number(res.getHeader('content-length')) || null,
          aborted: !res.writableFinished,
          request_id_source: requestIdResult.source,
          correlation_id_source: correlationIdResult.source,
          rejected_client_ids: rejectedClientIds,
        });
      };
      res.once('finish', complete);
      res.once('close', complete);
      next();
    });
  };
}

function apiErrorHandler(err, req, res, next) {
  const status = err && err.code === 'LIMIT_FILE_SIZE'
    ? 413
    : (err && err.message === 'only_xlsx_allowed' ? 415 : 500);
  const errorCode = status === 413
    ? 'file_too_large'
    : (status === 415 ? 'only_xlsx_allowed' : 'internal_error');
  if (status === 500) {
    const operationalLogger = res.locals.operational_logger || logger;
    operationalLogger.error('http.request.unhandled_error', {
      error: err,
      status_code: status,
      error_code: errorCode,
    });
  }
  if (res.headersSent) return next(err);
  res.locals.error_code = errorCode;
  return res.status(status).json({ error: errorCode });
}

module.exports = {
  ID_PATTERN,
  apiErrorHandler,
  enhanceErrorPayload,
  eventCodeForStatus,
  normalizedRoute,
  requestContext,
  stripStackFields,
  validClientId,
};
