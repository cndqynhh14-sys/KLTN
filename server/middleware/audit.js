'use strict';

const logger = require('../logger');
const { getContext } = require('../observability/context');
const { normalizedRoute } = require('./requestContext');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUDIT_WRITE_ERROR_CODE = 'audit_write_failed';

function isAuditedRequest(req) {
  if (MUTATION_METHODS.has(req.method)) return true;
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  return req.method === 'GET' && (pathname.endsWith('/download') || pathname.endsWith('/export-db'));
}

function authEvent(route, statusCode) {
  const rateLimited = statusCode === 429;
  if (route.endsWith('/request-otp')) return rateLimited
    ? 'auth.otp.request.rate_limited'
    : (statusCode < 400 ? 'auth.otp.request.succeeded' : 'auth.otp.request.failed');
  if (route.endsWith('/verify-otp')) return rateLimited
    ? 'auth.login.rate_limited'
    : (statusCode < 400 ? 'auth.login.succeeded' : 'auth.login.failed');
  if (route.endsWith('/logout')) return 'auth.logout.succeeded';
  return 'auth.rules.acknowledged';
}

function classifyMutation({ method, route, statusCode = 200 }) {
  const normalizedMethod = String(method || '').toUpperCase();
  const normalized = String(route || '').split('?')[0];
  const auditedRead = normalizedMethod === 'GET' && (normalized.endsWith('/download') || normalized.endsWith('/export-db'));
  if (!MUTATION_METHODS.has(normalizedMethod) && !auditedRead) return null;
  let eventName;
  if (normalizedMethod === 'GET' && normalized.endsWith('/export-db')) eventName = 'config.backup.exported';
  else if (normalizedMethod === 'GET' && normalized.endsWith('/download')) eventName = 'artifact.downloaded';
  else if (normalized.includes('/api/auth/')) eventName = authEvent(normalized, statusCode);
  else if (normalized.includes('/api/admin/authorization/personnel-import/')) {
    if (statusCode >= 400) eventName = 'personnel.import.failed';
    else if (normalized.endsWith('/preview')) eventName = 'personnel.import.previewed';
    else if (normalized.endsWith('/validate')) eventName = 'personnel.import.validated';
    else if (normalized.endsWith('/commit')) eventName = 'personnel.import.committed';
    else eventName = 'personnel.import.failed';
  }
  else if (normalized.includes('/api/admin/authorization/approval-assignments')) eventName = 'approval.assignment.changed';
  else if (normalized.includes('/api/admin/authorization/users/')) eventName = 'user.authorization.changed';
  else if (normalized.includes('/api/admin/authorization/roles/')
      && (normalized.endsWith('/permissions') || normalized.endsWith('/configuration'))) eventName = 'role.permissions.changed';
  else if (normalized.includes('/api/admin/authorization/roles')) eventName = 'role.catalog.changed';
  else if (normalized.includes('/api/admin/users')) eventName = normalized.endsWith('/reactivate')
    ? 'user.account.reactivated'
    : (normalizedMethod === 'DELETE' ? 'user.account.deactivated' : 'user.account.upserted');
  else if (normalized.endsWith('/api/admin/export-db')) eventName = 'config.backup.exported';
  else if (normalized.endsWith('/api/admin/restore-db')) eventName = 'config.restore.requested';
  else if (normalized.includes('/api/suppliers') && normalized.includes('import-excel')) eventName = statusCode < 400 ? 'import.completed' : 'import.failed';
  else if (normalized.includes('/api/suppliers')) eventName = normalizedMethod === 'POST' ? 'supplier.created' : 'supplier.updated';
  else if (normalized.includes('/api/evaluations') && /(?:approve|reject|send-gdk|approval-tasks)/.test(normalized)) eventName = 'approval.decision.recorded';
  else if (normalized.includes('/api/evaluations') && normalized.endsWith('/answers')) eventName = 'scoring.answers.updated';
  else if (normalized.includes('/api/evaluations') && normalized.endsWith('/complete')) eventName = 'scoring.round.completed';
  else if (normalized.includes('/api/evaluations') && normalized.includes('/attachments')) eventName = 'artifact.created';
  else if (normalized.includes('/api/evaluations') && /(?:export|reports)/.test(normalized)) eventName = statusCode < 400 ? 'export.generated' : 'export.failed';
  else if (normalized.includes('/api/evaluations')) eventName = normalizedMethod === 'DELETE'
    ? 'evaluation.deleted' : (normalizedMethod === 'POST' && /\/api\/evaluations\/?$/.test(normalized) ? 'evaluation.created' : 'evaluation.updated');
  else if (normalized.includes('/api/question-templates') && normalized.includes('/imports/')) {
    if (statusCode >= 400) eventName = 'question.import.failed';
    else if (normalized.endsWith('/preview')) eventName = 'question.import.previewed';
    else if (normalized.endsWith('/commit')) eventName = 'question.import.committed';
    else if (normalized.endsWith('/rollback')) eventName = 'question.import.rolled_back';
    else eventName = 'question.template.changed';
  }
  else if (normalized.includes('/api/question-templates')) eventName = 'question.template.changed';
  else if (normalized.includes('/api/report-templates')) eventName = 'report.template.changed';
  else eventName = 'audit.write.failed';
  return { eventName };
}

function entityFromRequest(req, eventName) {
  const params = req.params || {};
  const id = params.batchId || params.ticketId || params.code || params.id || params.templateId || params.questionId || params.taskId || null;
  const category = eventName.split('.')[0];
  return { entityType: category.toUpperCase(), entityId: id == null ? null : String(id) };
}

function safeAuditFailureBody(context) {
  return JSON.stringify({
    error: AUDIT_WRITE_ERROR_CODE,
    error_code: AUDIT_WRITE_ERROR_CODE,
    request_id: context.request_id || null,
  });
}

function responseCallback(encoding, callback) {
  return typeof encoding === 'function' ? encoding : callback;
}

function queueResponseCallback(callback) {
  if (typeof callback === 'function') queueMicrotask(callback);
}

function replaceWithAuditFailure(res, context, originalEnd) {
  const body = safeAuditFailureBody(context);
  res.statusCode = 500;
  res.locals.error_code = AUDIT_WRITE_ERROR_CODE;
  for (const header of [
    'Accept-Ranges', 'Content-Disposition', 'Content-Encoding', 'Content-Range',
    'ETag', 'Last-Modified', 'Location', 'Set-Cookie', 'Transfer-Encoding',
  ]) res.removeHeader(header);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  originalEnd.call(res, body, 'utf8');
}

function auditMutations(auditEventService, options = {}) {
  const operationalLogger = options.logger || logger;
  return (req, res, next) => {
    if (!isAuditedRequest(req)) return next();
    const originalEnd = res.end;
    const originalWrite = res.write;
    let auditAttempted = false;
    let closedByAudit = false;

    const auditBeforeResponse = () => {
      if (auditAttempted) return closedByAudit;
      auditAttempted = true;
      const context = getContext();
      // Some multipart handlers (notably database restore) can complete after
      // the AsyncLocalStorage request context has been lost. Those handlers
      // mark the response explicitly after persisting their own audit event so
      // the middleware does not attempt a duplicate write against a closed DB.
      if (context.audit_mutation_recorded || res.locals.audit_mutation_recorded) return false;
      const route = normalizedRoute(req);
      context.route = route;
      const classified = classifyMutation({ method: req.method, route, statusCode: res.statusCode });
      if (!classified) return false;
      const entity = entityFromRequest(req, classified.eventName);
      const actionIdHeader = String(req.get('x-action-id') || '');
      const actionId = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/.test(actionIdHeader) ? actionIdHeader : null;
      try {
        auditEventService.record({
          eventName: classified.eventName,
          actorUserId: req.user?.email || null,
          actorRoles: req.user?.roleCodes || [],
          ...entity,
          action: req.method,
          outcome: res.statusCode < 400 ? 'SUCCESS' : (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429 ? 'DENIED' : 'FAILURE'),
          reasonCode: res.locals.error_code || null,
          summary: `${req.method} ${route}`,
          idempotencyKey: req.get('idempotency-key') || null,
          metadata: { method: req.method, route, status_code: res.statusCode, action_id: actionId },
        });
      } catch (error) {
        operationalLogger.error('audit.event.write_failed', {
          error,
          status_code: res.statusCode,
          error_code: AUDIT_WRITE_ERROR_CODE,
        });
        if (res.statusCode < 400 && !res.headersSent) {
          closedByAudit = true;
          replaceWithAuditFailure(res, context, originalEnd);
        }
      }
      return closedByAudit;
    };

    res.write = function auditedWrite(chunk, encoding, callback) {
      if (auditBeforeResponse()) {
        queueResponseCallback(responseCallback(encoding, callback));
        return true;
      }
      return originalWrite.call(this, chunk, encoding, callback);
    };

    res.end = function auditedEnd(chunk, encoding, callback) {
      if (auditBeforeResponse()) {
        queueResponseCallback(responseCallback(encoding, callback));
        return this;
      }
      return originalEnd.call(this, chunk, encoding, callback);
    };
    next();
  };
}

module.exports = {
  AUDIT_WRITE_ERROR_CODE,
  MUTATION_METHODS,
  auditMutations,
  classifyMutation,
  entityFromRequest,
  isAuditedRequest,
  replaceWithAuditFailure,
  safeAuditFailureBody,
};
