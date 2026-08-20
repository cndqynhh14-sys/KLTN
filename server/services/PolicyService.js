'use strict';

const { PERMISSIONS, ROLE_CODES, isActivePermission } = require('../authorization/permissionCatalog');
const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');
const { stableMch2Id } = require('../domain/mchIdentifiers');
const {
  APPROVAL_PERMISSION_BY_LEVEL,
  POLICY_VERSION,
  NAVIGATION_VERSION,
  ACTION_VERSION,
} = require('../authorization/policyCatalog');

const NON_GLOBAL_SCOPE_ROLE_CODES_BY_PERMISSION = Object.freeze({});

const ENTERPRISE_READ_ROLE_CODES_BY_PERMISSION = Object.freeze({
  [PERMISSIONS.SUPPLIER_READ]: Object.freeze([ROLE_CODES.QLCL_SPECIALIST]),
});

class PolicyError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.name = 'PolicyError';
    this.code = code;
    this.status = status;
  }
}

function resourceContext(row = {}) {
  return {
    ownerUserId: row.created_by_user_id || row.owner_user_id || null,
    ownerId: row.created_by || row.owner_id || row.ownerId || null,
    assignedPrincipalId: row.assigned_specialist_user_id || row.assigned_principal_id || null,
    assignedUserId: row.assigned_specialist_id || row.qa_owner || row.assigned_user_id || null,
    regionId: row.region_id || row.regionId || row.region || null,
    mch2Id: row.mch2_id || row.mch2Id || stableMch2Id(row.mch2) || null,
    supplierId: row.supplier_code || row.supplier_id || row.supplierId || null,
  };
}

class PolicyService {
  constructor(authorizationService, approvalAssignmentService) {
    this.authorizationService = authorizationService;
    this.approvalAssignmentService = approvalAssignmentService;
  }

  capabilities(user) {
    const capabilities = Array.isArray(user?.capabilities)
      ? user.capabilities
      : this.authorizationService.effectivePermissions(user?.userId || user?.email).permissions;
    return capabilities.filter(isActivePermission);
  }

  has(user, permissionCode) {
    return this.capabilities(user).includes(permissionCode);
  }

  scopeOptions(user, permissionCode) {
    const constrainedRoleCodes = NON_GLOBAL_SCOPE_ROLE_CODES_BY_PERMISSION[permissionCode] || [];
    if (!constrainedRoleCodes.length) return {};
    const activeRoleCodes = new Set(user?.roleCodes || this.authorizationService.effectivePermissions(user?.userId || user?.email).roleCodes);
    return {
      excludeGlobalRoleCodes: constrainedRoleCodes.filter((roleCode) => activeRoleCodes.has(roleCode)),
    };
  }

  hasEnterpriseRead(user, permissionCode) {
    const allowedRoleCodes = ENTERPRISE_READ_ROLE_CODES_BY_PERMISSION[permissionCode] || [];
    if (!allowedRoleCodes.length) return false;
    const activeRoleCodes = new Set(
      user?.roleCodes || this.authorizationService.effectivePermissions(user?.userId || user?.email).roleCodes
    );
    return allowedRoleCodes.some((roleCode) => activeRoleCodes.has(roleCode));
  }

  decision(user, permissionCode, options = {}) {
    if (!user || !this.has(user, permissionCode)) return { allowed: false, reason: 'forbidden_permission' };
    if (options.requireGlobalScope && !this.authorizationService.hasGlobalScope(user.userId || user.email)) {
      return { allowed: false, reason: 'forbidden_scope' };
    }
    if (options.context && !this.hasEnterpriseRead(user, permissionCode) && !this.authorizationService.isInScope(
      user.userId || user.email,
      options.context,
      this.scopeOptions(user, permissionCode)
    )) {
      return { allowed: false, reason: 'forbidden_scope' };
    }
    if (options.stateAllowed === false) return { allowed: false, reason: options.stateReason || 'action_not_available_in_state' };
    return { allowed: true, reason: null };
  }

  assert(user, permissionCode, options = {}) {
    const result = this.decision(user, permissionCode, options);
    if (!result.allowed) throw new PolicyError(result.reason);
    return result;
  }

  filter(user, permissionCode, rows, contextFactory = resourceContext) {
    this.assert(user, permissionCode);
    if (this.hasEnterpriseRead(user, permissionCode)) return [...rows];
    return this.authorizationService.applyScope(
      user.userId || user.email,
      rows,
      contextFactory,
      this.scopeOptions(user, permissionCode)
    );
  }

  sqlScope(user, options = {}) {
    return this.authorizationService.buildSqlScope(user.userId || user.email, options);
  }

  approvalPermission(workflowType, level) {
    if (String(workflowType || '').toUpperCase() !== 'EVALUATION') return null;
    return APPROVAL_PERMISSION_BY_LEVEL[String(level || '').toUpperCase()] || null;
  }

  assertApproval(user, workflowType, level, context = {}) {
    const permission = this.approvalPermission(workflowType, level);
    if (!permission || !this.has(user, permission)) throw new PolicyError('forbidden_permission');
    let assignment;
    try {
      assignment = this.approvalAssignmentService.resolve(workflowType, level, context, {
        allowEmptyCandidates: this.has(user, PERMISSIONS.SYSTEM_ADMIN),
      });
    } catch (error) {
      if (error.code === 'assignment_expired') throw new PolicyError('assignment_expired');
      throw new PolicyError('approval_assignment_missing');
    }
    if (!this.has(user, PERMISSIONS.SYSTEM_ADMIN) && !assignment.candidates.includes(user.email)) {
      throw new PolicyError('forbidden_scope');
    }
    return assignment;
  }

  approvalLevels(user, workflowType) {
    if (String(workflowType || '').toUpperCase() !== 'EVALUATION') return [];
    return Object.entries(APPROVAL_PERMISSION_BY_LEVEL)
      .filter(([, permission]) => this.has(user, permission)).map(([level]) => level);
  }

  actionEnvelope(resourceType, row, user) {
    const baseContext = resourceContext(row);
    const evaluationOwner = row.assigned_specialist_id || row.created_by || null;
    const context = resourceType === 'EVALUATION'
        ? { ...baseContext, ownerId: evaluationOwner, assignedUserId: evaluationOwner }
        : baseContext;
    let definitions = {};
    if (resourceType === 'EVALUATION') {
      definitions = {
        view: [PERMISSIONS.EVALUATION_READ, true],
        edit: [PERMISSIONS.EVALUATION_CREATE, [WORKFLOW_STATUSES.DRAFT, WORKFLOW_STATUSES.IN_PROGRESS].includes(row.current_status)],
        score: [PERMISSIONS.EVALUATION_SCORE, [
          WORKFLOW_STATUSES.DRAFT,
          WORKFLOW_STATUSES.IN_PROGRESS,
          WORKFLOW_STATUSES.ROUND_2,
        ].includes(row.current_status)],
        delete: [PERMISSIONS.EVALUATION_DELETE_DRAFT, row.current_status === WORKFLOW_STATUSES.DRAFT],
        export: [PERMISSIONS.REPORT_EXPORT, true],
        approve_lead: [PERMISSIONS.EVALUATION_APPROVE_LEAD, row.current_status === WORKFLOW_STATUSES.WAITING_LEAD],
        approve_tbp: [PERMISSIONS.EVALUATION_APPROVE_TBP, row.current_status === WORKFLOW_STATUSES.WAITING_TBP],
        approve_gdk: [PERMISSIONS.EVALUATION_APPROVE_GDK, row.current_status === WORKFLOW_STATUSES.WAITING_GDK],
      };
    } else if (resourceType === 'SUPPLIER') {
      definitions = {
        view: [PERMISSIONS.SUPPLIER_READ, true],
        history: [PERMISSIONS.SUPPLIER_READ, true],
        edit: [PERMISSIONS.SUPPLIER_WRITE, true],
      };
    } else if (resourceType === 'REPORT_EXPORT') {
      definitions = { download: [PERMISSIONS.REPORT_READ, true] };
    }
    const allowedActions = [];
    const disabledReasons = {};
    for (const [action, [permission, stateAllowed]] of Object.entries(definitions)) {
      let result = this.decision(user, permission, { context, stateAllowed });
      if (result.allowed && action.startsWith('approve_')) {
        const level = action.slice('approve_'.length).toUpperCase();
        try {
          this.assertApproval(user, resourceType, level, context);
        } catch (error) {
          result = { allowed: false, reason: error.code || 'forbidden_scope' };
        }
      }
      if (result.allowed) allowedActions.push(action);
      else disabledReasons[action] = result.reason;
    }
    return { allowed_actions: allowedActions, disabled_reasons: disabledReasons };
  }

  identityPayload(identity) {
    return {
      ...identity,
      capabilities: this.capabilities(identity),
      policy_version: POLICY_VERSION,
      navigation_version: NAVIGATION_VERSION,
      action_version: ACTION_VERSION,
    };
  }
}

module.exports = { PolicyService, PolicyError, resourceContext };
