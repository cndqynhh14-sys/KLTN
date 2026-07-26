'use strict';

const { PolicyError } = require('../services/PolicyService');

function service() {
  return require('../db').policyService;
}

function policyErrorResponse(res, error, req) {
  const allowed = new Set([
    'forbidden_permission', 'forbidden_scope', 'assignment_expired', 'approval_assignment_missing',
  ]);
  const code = allowed.has(error?.code) ? error.code : 'forbidden_permission';
  return res.status(error?.status || 403).json({ error: code, request_id: req.requestId });
}

function requirePermission(permissionCode, options = {}) {
  const middleware = (req, res, next) => {
    try {
      const context = options.context ? options.context(req) : null;
      const policyService = options.policyService || service();
      policyService.assert(req.user, permissionCode, { context, requireGlobalScope: options.requireGlobalScope === true });
      return next();
    } catch (error) {
      if (error instanceof PolicyError || error?.status === 403) return policyErrorResponse(res, error, req);
      return next(error);
    }
  };
  middleware.policy = Object.freeze({ type: 'permission', permissionCode });
  return middleware;
}

function requireAnyPermission(permissionCodes) {
  const permissions = [...new Set((permissionCodes || []).map(String).filter(Boolean))];
  const middleware = (req, res, next) => {
    if (permissions.some((permissionCode) => service().has(req.user, permissionCode))) return next();
    return policyErrorResponse(res, new PolicyError('forbidden_permission'), req);
  };
  middleware.policy = Object.freeze({ type: 'permission_any', permissionCodes: Object.freeze(permissions) });
  return middleware;
}

function requireApproval(workflowType, level, contextResolver = () => ({})) {
  const middleware = (req, res, next) => {
    try {
      const actualLevel = typeof level === 'function' ? level(req) : level;
      req.approvalAssignment = service().assertApproval(req.user, workflowType, actualLevel, contextResolver(req));
      return next();
    } catch (error) {
      return policyErrorResponse(res, error, req);
    }
  };
  middleware.policy = Object.freeze({
    type: 'approval',
    workflowType: String(workflowType || '').toUpperCase(),
    level: typeof level === 'function' ? 'DYNAMIC' : String(level || '').toUpperCase(),
  });
  return middleware;
}

module.exports = { requirePermission, requireAnyPermission, requireApproval, policyErrorResponse };
