'use strict';

const { AuthorizationError } = require('./AuthorizationService');
const { APPROVAL_PERMISSION_BY_LEVEL } = require('../authorization/policyCatalog');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

class ApprovalAssignmentService {
  constructor(db, authorizationService) {
    this.db = db;
    this.authorizationService = authorizationService;
  }

  resolve(workflowType, stageCode, context = {}, options = {}) {
    const now = this.authorizationService._now();
    const workflow = String(workflowType || '').trim().toUpperCase();
    const stage = String(stageCode || '').trim().toUpperCase();
    const approvalLevel = Object.keys(APPROVAL_PERMISSION_BY_LEVEL)
      .find((level) => stage === level || stage.startsWith(`${level}_`));
    const requiredPermission = APPROVAL_PERMISSION_BY_LEVEL[approvalLevel];
    if (workflow !== 'EVALUATION' || !requiredPermission) {
      throw new AuthorizationError('approval_assignment_not_found', 404);
    }
    const assignments = this.db.prepare(`SELECT asa.*, r.role_code
      FROM approval_stage_assignments asa
      LEFT JOIN roles r ON r.id = asa.role_id
      WHERE asa.workflow_type = ? AND asa.stage_code = ? AND asa.active = 1
        AND (asa.assigned_user_id IS NOT NULL OR (asa.role_id IS NOT NULL AND r.active = 1))
        AND (asa.valid_from IS NULL OR asa.valid_from <= ?)
        AND (asa.valid_until IS NULL OR asa.valid_until > ?)
      ORDER BY asa.priority ASC, asa.id ASC`).all(
      workflow, stage, now, now
    );

    for (const assignment of assignments) {
      const scopeProbe = { ...assignment, effect: 'ALLOW' };
      let candidates;
      if (assignment.assigned_principal_id || assignment.assigned_user_id) {
        const user = this.db.prepare(`SELECT user_id, email FROM users
          WHERE is_active = 1 AND (user_id = ? OR (? IS NULL AND lower(email) = lower(?)))`)
          .get(assignment.assigned_principal_id, assignment.assigned_principal_id, assignment.assigned_user_id);
        candidates = user
          && this.authorizationService._scopeMatches(scopeProbe, context, normalizeEmail(user.email))
          && this.authorizationService.isInScope(user.email, context)
          && this.authorizationService.can(user.user_id, requiredPermission)
          ? [user.email] : [];
      } else {
        candidates = this.db.prepare(`SELECT DISTINCT u.email
          FROM user_roles ur JOIN users u ON u.user_id = ur.principal_id
            OR (ur.principal_id IS NULL AND lower(u.email) = lower(ur.user_id))
          WHERE ur.role_id = ? AND ur.active = 1 AND u.is_active = 1
            AND (ur.valid_from IS NULL OR ur.valid_from <= ?)
            AND (ur.valid_until IS NULL OR ur.valid_until > ?)
          ORDER BY u.email`).all(assignment.role_id, now, now).map((row) => row.email)
          .filter((email) => this.authorizationService._scopeMatches(scopeProbe, context, normalizeEmail(email)))
          .filter((email) => this.authorizationService.isInScope(email, context))
          .filter((email) => this.authorizationService.can(email, requiredPermission));
      }
      if (candidates.length || options.allowEmptyCandidates === true) {
        return Object.freeze({
          assignmentId: assignment.id,
          workflowType: assignment.workflow_type,
          stageCode: assignment.stage_code,
          roleCode: assignment.role_code || null,
          assignedUserId: assignment.assigned_user_id || null,
          assignedPrincipalId: assignment.assigned_principal_id || null,
          requiredPermission,
          candidates: Object.freeze(candidates),
        });
      }
    }
    const configured = this.db.prepare(`SELECT valid_from, valid_until FROM approval_stage_assignments
      WHERE workflow_type = ? AND stage_code = ? AND active = 1`).all(workflow, stage);
    if (configured.length && configured.every((row) =>
      (row.valid_from && row.valid_from > now) || (row.valid_until && row.valid_until <= now))) {
      throw new AuthorizationError('assignment_expired', 403);
    }
    throw new AuthorizationError('approval_assignment_not_found', 404);
  }
}

module.exports = { ApprovalAssignmentService };
