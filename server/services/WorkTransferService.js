'use strict';

const crypto = require('node:crypto');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');
const { resourceContext } = require('./PolicyService');
const { sanitizeString } = require('../observability/redact');

const ENTITY_TYPES = Object.freeze({
  EVALUATION_TICKET: 'EVALUATION_TICKET',
  EVALUATION_APPROVAL_TASK: 'EVALUATION_APPROVAL_TASK',
  APPROVAL_STAGE_ASSIGNMENT: 'APPROVAL_STAGE_ASSIGNMENT',
});

const APPROVAL_PERMISSIONS = Object.freeze({
  LEAD: PERMISSIONS.EVALUATION_APPROVE_LEAD,
  TBP: PERMISSIONS.EVALUATION_APPROVE_TBP,
  GDK: PERMISSIONS.EVALUATION_APPROVE_GDK,
});

class WorkTransferError extends Error {
  constructor(code, status = 400, details = {}) {
    super(code);
    this.name = 'WorkTransferError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeReason(value) {
  const reason = sanitizeString(String(value || '').trim(), 500);
  if (reason.length < 8 || reason.length > 500) {
    throw new WorkTransferError('change_reason_required', 400);
  }
  return reason;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) {
    throw new WorkTransferError('idempotency_key_required', 400);
  }
  return key;
}

function checksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function json(value) {
  return JSON.stringify(value);
}

class WorkTransferService {
  constructor(db, authorizationService, auditEventService = null) {
    this.db = db;
    this.authorizationService = authorizationService;
    this.auditEventService = auditEventService;
    this.userByIdentity = db.prepare(`SELECT user_id, email, display_name, is_active, authz_version
      FROM users WHERE user_id = @identity OR lower(email) = lower(@identity) LIMIT 1`);
  }

  resolveUser(identity) {
    const value = String(identity || '').trim();
    return value ? this.userByIdentity.get({ identity: value }) || null : null;
  }

  _ticketParticipants(ticketId, user) {
    return this.db.prepare(`SELECT p.id, p.ticket_id, p.round_id, p.user_id, p.principal_id,
        p.display_name, p.participant_role, p.active, p.assigned_at, p.assigned_by,
        p.assigned_by_user_id
      FROM evaluation_participants p
      LEFT JOIN evaluation_rounds er ON er.id = p.round_id
      WHERE p.active = 1
        AND (p.principal_id = @user_id OR (p.principal_id IS NULL AND lower(p.user_id) = lower(@email)))
        AND p.participant_role IN ('OWNER', 'EVALUATOR')
        AND (p.ticket_id = @ticket_id OR (er.ticket_id = @ticket_id AND er.completed_at IS NULL))
      ORDER BY p.id`).all({ ticket_id: ticketId, user_id: user.user_id, email: user.email });
  }

  _openWork(user) {
    const tickets = this.db.prepare(`SELECT t.*
      FROM evaluation_tickets t
      WHERE t.source_kind = 'NATIVE' AND t.is_deleted = 0
        AND t.current_status NOT IN (@completed, @cancelled)
        AND (
          t.assigned_specialist_user_id = @user_id
          OR (t.assigned_specialist_user_id IS NULL AND lower(t.assigned_specialist_id) = lower(@email))
          OR EXISTS (
            SELECT 1 FROM evaluation_participants p
            LEFT JOIN evaluation_rounds er ON er.id = p.round_id
            WHERE p.active = 1
              AND (p.principal_id = @user_id OR (p.principal_id IS NULL AND lower(p.user_id) = lower(@email)))
              AND p.participant_role IN ('OWNER', 'EVALUATOR')
              AND (p.ticket_id = t.id OR (er.ticket_id = t.id AND er.completed_at IS NULL))
          )
        )
      ORDER BY t.id`).all({
      user_id: user.user_id,
      email: user.email,
      completed: WORKFLOW_STATUSES.COMPLETED,
      cancelled: WORKFLOW_STATUSES.CANCELLED,
    }).map((row) => {
      const participants = this._ticketParticipants(row.id, user);
      const transfersAssignee = row.assigned_specialist_user_id === user.user_id
        || (!row.assigned_specialist_user_id && String(row.assigned_specialist_id || '').toLowerCase() === user.email.toLowerCase());
      return {
        entity_type: ENTITY_TYPES.EVALUATION_TICKET,
        entity_id: String(row.id),
        reference: row.ticket_code,
        status: row.current_status,
        required_permission: PERMISSIONS.EVALUATION_SCORE,
        transfers_assignee: transfersAssignee,
        participant_roles: [...new Set(participants.map((item) => item.participant_role))],
        row,
        participants,
      };
    });

    const approvals = this.db.prepare(`SELECT a.*, t.ticket_code, t.current_status,
        t.source_kind, t.is_deleted, t.region, t.mch2, t.supplier_code,
        t.supplier_id, t.assigned_specialist_user_id, t.assigned_specialist_id,
        t.created_by_user_id, t.created_by
      FROM approval_tasks a
      JOIN evaluation_tickets t ON t.id = a.ticket_id
      WHERE a.status = 'PENDING'
        AND a.assigned_principal_id = @user_id
        AND t.source_kind = 'NATIVE' AND t.is_deleted = 0
        AND t.current_status NOT IN (@completed, @cancelled)
      ORDER BY a.id`).all({
        user_id: user.user_id,
        completed: WORKFLOW_STATUSES.COMPLETED,
        cancelled: WORKFLOW_STATUSES.CANCELLED,
      })
      .map((row) => ({
        entity_type: ENTITY_TYPES.EVALUATION_APPROVAL_TASK,
        entity_id: String(row.id),
        reference: `${row.ticket_code} · ${row.approval_level}`,
        status: row.status,
        approval_level: row.approval_level,
        required_permission: APPROVAL_PERMISSIONS[row.approval_level] || null,
        row,
      }));

    const assignments = this.db.prepare(`SELECT asa.*
      FROM approval_stage_assignments asa
      WHERE asa.workflow_type = 'EVALUATION'
        AND asa.assigned_principal_id = ? AND asa.active = 1
        AND (asa.valid_from IS NULL OR asa.valid_from <= datetime('now'))
        AND (asa.valid_until IS NULL OR asa.valid_until > datetime('now'))
      ORDER BY asa.id`).all(user.user_id).map((row) => ({
      entity_type: ENTITY_TYPES.APPROVAL_STAGE_ASSIGNMENT,
      entity_id: String(row.id),
      reference: `${row.workflow_type} · ${row.stage_code}`,
      status: 'ACTIVE',
      approval_level: row.stage_code,
      required_permission: APPROVAL_PERMISSIONS[row.stage_code] || null,
      row,
    }));
    return [...tickets, ...approvals, ...assignments];
  }

  _summary(items) {
    const count = (type) => items.filter((item) => item.entity_type === type).length;
    return {
      total: items.length,
      evaluation_tickets: count(ENTITY_TYPES.EVALUATION_TICKET),
      evaluation_approval_tasks: count(ENTITY_TYPES.EVALUATION_APPROVAL_TASK),
      approval_stage_assignments: count(ENTITY_TYPES.APPROVAL_STAGE_ASSIGNMENT),
    };
  }

  _publicItem(item) {
    return {
      entity_type: item.entity_type,
      entity_id: item.entity_id,
      reference: item.reference,
      status: item.status,
      required_permission: item.required_permission,
      ...(item.approval_level ? { approval_level: item.approval_level } : {}),
      ...(item.participant_roles?.length ? { participant_roles: item.participant_roles } : {}),
    };
  }

  _assignmentScopeContext(row, recipient) {
    const context = {};
    if (row.scope_type === 'REGION') context.regionId = row.scope_value;
    else if (row.scope_type === 'MCH2') context.mch2Id = row.scope_value;
    else if (row.scope_type === 'SUPPLIER') context.supplierId = row.scope_value;
    else if (row.scope_type === 'ASSIGNED') context.assignedPrincipalId = recipient.user_id;
    else if (row.scope_type === 'OWN') context.ownerUserId = recipient.user_id;
    else if (row.scope_type === 'CUSTOM') {
      context.customSchemaCode = row.custom_schema_code;
      context.customScopeValue = row.scope_value;
    }
    return context;
  }

  _recipientCanReceive(recipient, item) {
    if (!item.required_permission || !this.authorizationService.can(recipient.user_id, item.required_permission)) {
      return false;
    }
    try {
      let context;
      if (item.entity_type === ENTITY_TYPES.EVALUATION_TICKET) {
        context = resourceContext(item.row);
        if (item.transfers_assignee) {
          context.assignedPrincipalId = recipient.user_id;
          context.assignedUserId = recipient.email;
        }
      } else if (item.entity_type === ENTITY_TYPES.EVALUATION_APPROVAL_TASK) {
        context = resourceContext(item.row);
      } else {
        context = this._assignmentScopeContext(item.row, recipient);
      }
      return this.authorizationService.isInScope(recipient.user_id, context);
    } catch {
      return false;
    }
  }

  _eligibleRecipients(fromUser, items) {
    if (items.some((item) => !item.required_permission)) return [];
    return this.db.prepare(`SELECT user_id, email, display_name FROM users
      WHERE is_active = 1 AND user_id != ? ORDER BY COALESCE(display_name, email), email`).all(fromUser.user_id)
      .filter((user) => items.every((item) => this._recipientCanReceive(user, item)));
  }

  workload(identity) {
    const user = this.resolveUser(identity);
    if (!user) throw new WorkTransferError('not_found', 404);
    const items = user.is_active ? this._openWork(user) : [];
    return {
      user: {
        user_id: user.user_id,
        email: user.email,
        display_name: user.display_name,
        active: Boolean(user.is_active),
      },
      summary: this._summary(items),
      items: items.map((item) => this._publicItem(item)),
      required_permissions: [...new Set(items.map((item) => item.required_permission).filter(Boolean))],
      eligible_recipients: items.length ? this._eligibleRecipients(user, items) : [],
    };
  }

  _participantSnapshot(row) {
    return {
      id: row.id,
      ticket_id: row.ticket_id,
      round_id: row.round_id,
      principal_id: row.principal_id,
      user_id: row.user_id,
      display_name: row.display_name,
      participant_role: row.participant_role,
      active: Boolean(row.active),
    };
  }

  _setParticipantRecipient(participant, to, actor) {
    const counterpart = this.db.prepare(`SELECT id FROM evaluation_participants
      WHERE id != @id AND ticket_id IS @ticket_id AND round_id IS @round_id
        AND participant_role = @participant_role
        AND (principal_id = @principal_id OR lower(user_id) = lower(@user_id))
      ORDER BY active DESC, id DESC LIMIT 1`).get({
      id: participant.id,
      ticket_id: participant.ticket_id,
      round_id: participant.round_id,
      participant_role: participant.participant_role,
      principal_id: to.user_id,
      user_id: to.email,
    });
    if (counterpart) {
      this.db.prepare(`UPDATE evaluation_participants SET active = 1, user_id = ?, principal_id = ?,
        display_name = ?, assigned_at = datetime('now'), assigned_by = ?, assigned_by_user_id = ?
        WHERE id = ?`).run(to.email, to.user_id, to.display_name || to.email, actor.email, actor.user_id, counterpart.id);
      this.db.prepare('UPDATE evaluation_participants SET active = 0 WHERE id = ? AND active = 1').run(participant.id);
      return;
    }
    this.db.prepare(`UPDATE evaluation_participants SET user_id = ?, principal_id = ?, display_name = ?,
      assigned_at = datetime('now'), assigned_by = ?, assigned_by_user_id = ?
      WHERE id = ? AND active = 1`).run(
      to.email, to.user_id, to.display_name || to.email, actor.email, actor.user_id, participant.id
    );
  }

  _ensureTicketOwner(ticketId, from, to, actor) {
    const owners = this.db.prepare(`SELECT * FROM evaluation_participants
      WHERE ticket_id = ? AND participant_role = 'OWNER' AND active = 1 ORDER BY id`).all(ticketId);
    const sourceOwners = owners.filter((row) => row.principal_id === from.user_id
      || (!row.principal_id && String(row.user_id || '').toLowerCase() === from.email.toLowerCase()));
    if (owners.some((row) => !sourceOwners.includes(row))) {
      throw new WorkTransferError('evaluation_participant_conflict', 409, { ticket_id: ticketId });
    }
    if (sourceOwners.length) return;
    const existing = this.db.prepare(`SELECT * FROM evaluation_participants
      WHERE ticket_id = ? AND participant_role = 'OWNER'
        AND (principal_id = ? OR lower(user_id) = lower(?)) ORDER BY id DESC LIMIT 1`).get(ticketId, to.user_id, to.email);
    if (existing) {
      this.db.prepare(`UPDATE evaluation_participants SET active = 1, user_id = ?, principal_id = ?,
        display_name = ?, assigned_at = datetime('now'), assigned_by = ?, assigned_by_user_id = ? WHERE id = ?`)
        .run(to.email, to.user_id, to.display_name || to.email, actor.email, actor.user_id, existing.id);
      return;
    }
    this.db.prepare(`INSERT INTO evaluation_participants
      (ticket_id, user_id, principal_id, display_name, participant_role, active,
       assigned_at, assigned_by, assigned_by_user_id)
      VALUES (?, ?, ?, ?, 'OWNER', 1, datetime('now'), ?, ?)`)
      .run(ticketId, to.email, to.user_id, to.display_name || to.email, actor.email, actor.user_id);
  }

  _transferTicket(item, from, to, actor) {
    const before = {
      ticket: {
        id: item.row.id,
        assigned_specialist_user_id: item.row.assigned_specialist_user_id,
        assigned_specialist_id: item.row.assigned_specialist_id,
        current_status: item.row.current_status,
        source_kind: item.row.source_kind,
      },
      participants: item.participants.map((row) => this._participantSnapshot(row)),
    };
    if (item.transfers_assignee) {
      const changed = this.db.prepare(`UPDATE evaluation_tickets
        SET assigned_specialist_user_id = ?, assigned_specialist_id = ?
        WHERE id = ? AND source_kind = 'NATIVE' AND is_deleted = 0
          AND current_status NOT IN (?, ?)
          AND (assigned_specialist_user_id = ?
            OR (assigned_specialist_user_id IS NULL AND lower(assigned_specialist_id) = lower(?)))`)
        .run(to.user_id, to.email, item.row.id, WORKFLOW_STATUSES.COMPLETED,
          WORKFLOW_STATUSES.CANCELLED, from.user_id, from.email);
      if (changed.changes !== 1) throw new WorkTransferError('workload_changed', 409);
    }
    if (item.transfers_assignee) this._ensureTicketOwner(item.row.id, from, to, actor);
    for (const participant of item.participants) this._setParticipantRecipient(participant, to, actor);
    const afterTicket = this.db.prepare(`SELECT id, assigned_specialist_user_id,
      assigned_specialist_id, current_status, source_kind FROM evaluation_tickets WHERE id = ?`).get(item.row.id);
    const afterParticipants = this.db.prepare(`SELECT p.* FROM evaluation_participants p
      LEFT JOIN evaluation_rounds er ON er.id = p.round_id
      WHERE p.active = 1 AND (p.ticket_id = ? OR (er.ticket_id = ? AND er.completed_at IS NULL))
        AND p.participant_role IN ('OWNER', 'EVALUATOR')
      ORDER BY p.id`).all(item.row.id, item.row.id).map((row) => this._participantSnapshot(row));
    return { before, after: { ticket: afterTicket, participants: afterParticipants } };
  }

  _transferApprovalTask(item, from, to) {
    const before = {
      id: item.row.id,
      ticket_id: item.row.ticket_id,
      approval_level: item.row.approval_level,
      status: item.row.status,
      assigned_principal_id: item.row.assigned_principal_id,
      assigned_user_id: item.row.assigned_user_id,
    };
    const changed = this.db.prepare(`UPDATE approval_tasks
      SET assigned_principal_id = ?, assigned_user_id = ?
      WHERE id = ? AND assigned_principal_id = ? AND status = 'PENDING'`)
      .run(to.user_id, to.email, item.row.id, from.user_id);
    if (changed.changes !== 1) throw new WorkTransferError('workload_changed', 409);
    const after = this.db.prepare(`SELECT id, ticket_id, approval_level, status,
      assigned_principal_id, assigned_user_id FROM approval_tasks WHERE id = ?`).get(item.row.id);
    return { before, after };
  }

  _transferApprovalAssignment(item, from, to) {
    const fields = ['id', 'workflow_type', 'stage_code', 'scope_type', 'scope_value',
      'active', 'valid_from', 'valid_until', 'assigned_principal_id', 'assigned_user_id'];
    const snapshot = (row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
    const before = snapshot(item.row);
    const changed = this.db.prepare(`UPDATE approval_stage_assignments
      SET assigned_principal_id = ?, assigned_user_id = ?
      WHERE id = ? AND workflow_type = 'EVALUATION'
        AND assigned_principal_id = ? AND active = 1
        AND (valid_from IS NULL OR valid_from <= datetime('now'))
        AND (valid_until IS NULL OR valid_until > datetime('now'))`)
      .run(to.user_id, to.email, item.row.id, from.user_id);
    if (changed.changes !== 1) throw new WorkTransferError('workload_changed', 409);
    const after = snapshot(this.db.prepare('SELECT * FROM approval_stage_assignments WHERE id = ?').get(item.row.id));
    return { before, after };
  }

  _transferItem(item, from, to, actor) {
    if (item.entity_type === ENTITY_TYPES.EVALUATION_TICKET) return this._transferTicket(item, from, to, actor);
    if (item.entity_type === ENTITY_TYPES.EVALUATION_APPROVAL_TASK) return this._transferApprovalTask(item, from, to);
    if (item.entity_type === ENTITY_TYPES.APPROVAL_STAGE_ASSIGNMENT) return this._transferApprovalAssignment(item, from, to);
    throw new WorkTransferError('workload_type_unsupported', 409);
  }

  _result(transferId, replayed = false) {
    const transfer = this.db.prepare('SELECT * FROM work_transfers WHERE transfer_id = ?').get(transferId);
    const items = this.db.prepare(`SELECT id, transfer_id, entity_type, entity_id,
      previous_assignee_user_id, new_assignee_user_id, required_permission,
      before_json, after_json, transferred_at
      FROM work_transfer_items WHERE transfer_id = ? ORDER BY id`).all(transferId)
      .map((item) => ({
        ...item,
        before: JSON.parse(item.before_json),
        after: JSON.parse(item.after_json),
        before_json: undefined,
        after_json: undefined,
      }));
    const user = this.resolveUser(transfer.from_user_id);
    return {
      ok: true,
      replayed,
      transfer: {
        transfer_id: transfer.transfer_id,
        from_user_id: transfer.from_user_id,
        to_user_id: transfer.to_user_id,
        status: transfer.status,
        reason: transfer.reason,
        completed_at: transfer.completed_at,
      },
      transferred_count: items.length,
      items,
      user: {
        user_id: user.user_id,
        email: user.email,
        active: Boolean(user.is_active),
        authz_version: Number(user.authz_version),
      },
    };
  }

  offboard(input = {}) {
    const reason = normalizeReason(input.reason);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey || input.requestId);
    const actor = this.resolveUser(input.createdByUserId);
    if (!actor?.is_active) throw new WorkTransferError('forbidden', 403);
    const from = this.resolveUser(input.fromUserId);
    if (!from) throw new WorkTransferError('not_found', 404);
    if (from.user_id === actor.user_id) throw new WorkTransferError('cannot_deactivate_self', 400);
    const requestedRecipient = this.resolveUser(input.transferToUserId);
    const recipientIdentity = requestedRecipient?.user_id || String(input.transferToUserId || '').trim() || null;
    const requestSha256 = checksum({
      from_user_id: from.user_id,
      to_user_id: recipientIdentity,
      reason,
    });
    const existing = this.db.prepare(`SELECT transfer_id, request_sha256 FROM work_transfers
      WHERE created_by_user_id = ? AND idempotency_key = ?`).get(actor.user_id, idempotencyKey);
    if (existing) {
      if (existing.request_sha256 !== requestSha256) {
        throw new WorkTransferError('idempotency_key_conflict', 409);
      }
      return this._result(existing.transfer_id, true);
    }
    if (!from.is_active) throw new WorkTransferError('account_already_inactive', 409);

    const execute = this.db.transaction(() => {
      const lockedFrom = this.resolveUser(from.user_id);
      if (!lockedFrom?.is_active) throw new WorkTransferError('account_status_conflict', 409);
      const items = this._openWork(lockedFrom);
      let to = null;
      if (items.length) {
        if (!recipientIdentity) {
          throw new WorkTransferError('work_transfer_required', 409, { workload: this._summary(items) });
        }
        to = this.resolveUser(recipientIdentity);
        if (!to?.is_active) throw new WorkTransferError('transfer_recipient_inactive', 409);
        if (to.user_id === lockedFrom.user_id) throw new WorkTransferError('transfer_recipient_same_user', 409);
        const ineligible = items.filter((item) => !this._recipientCanReceive(to, item));
        if (ineligible.length) {
          throw new WorkTransferError('transfer_recipient_ineligible', 409, {
            missing_permissions: [...new Set(ineligible.map((item) => item.required_permission || 'UNMAPPED'))],
            incompatible_items: ineligible.map((item) => this._publicItem(item)),
          });
        }
      }

      const transferId = crypto.randomUUID();
      const beforeSummary = this._summary(items);
      this.db.prepare(`INSERT INTO work_transfers
        (transfer_id, from_user_id, to_user_id, from_email_snapshot, to_email_snapshot,
         reason, created_by_user_id, status, idempotency_key, request_sha256,
         workload_before_json, request_id, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`).run(
        transferId, lockedFrom.user_id, to?.user_id || null, lockedFrom.email, to?.email || null,
        reason, actor.user_id, idempotencyKey, requestSha256, json(beforeSummary),
        input.requestId || null, input.correlationId || null
      );

      for (const item of items) {
        const snapshots = this._transferItem(item, lockedFrom, to, actor);
        this.db.prepare(`INSERT INTO work_transfer_items
          (transfer_id, entity_type, entity_id, previous_assignee_user_id,
           new_assignee_user_id, required_permission, before_json, after_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          transferId, item.entity_type, item.entity_id, lockedFrom.user_id, to.user_id,
          item.required_permission, json(snapshots.before), json(snapshots.after)
        );
      }

      const remaining = this._openWork(lockedFrom);
      if (remaining.length) {
        throw new WorkTransferError('work_transfer_incomplete', 409, { workload: this._summary(remaining) });
      }
      let deactivated;
      try {
        deactivated = this.db.prepare('UPDATE users SET is_active = 0 WHERE user_id = ? AND is_active = 1')
          .run(lockedFrom.user_id);
      } catch (error) {
        if (String(error.message).includes('last_super_admin_required')) {
          throw new WorkTransferError('last_super_admin_required', 409);
        }
        if (String(error.message).includes('work_transfer_required')) {
          throw new WorkTransferError('work_transfer_incomplete', 409);
        }
        throw error;
      }
      if (deactivated.changes !== 1) throw new WorkTransferError('account_status_conflict', 409);
      const afterSummary = this._summary(this._openWork(lockedFrom));
      this.db.prepare(`UPDATE work_transfers
        SET status = 'COMPLETED', completed_at = datetime('now'), workload_after_json = ?
        WHERE transfer_id = ? AND status = 'PENDING'`).run(json(afterSummary), transferId);

      if (this.auditEventService) {
        this.auditEventService.record({
          eventName: 'work.transfer.completed',
          actorPrincipalId: actor.user_id,
          entityType: 'USER',
          entityId: lockedFrom.user_id,
          action: 'OFFBOARD',
          outcome: 'SUCCESS',
          summary: `Transferred ${items.length} active evaluation assignments and deactivated user`,
          requestId: input.requestId,
          correlationId: input.correlationId,
          idempotencyKey: `work-transfer:${actor.user_id}:${idempotencyKey}`,
          metadata: {
            transfer_id: transferId,
            from_user_id: lockedFrom.user_id,
            to_user_id: to?.user_id || null,
            item_count: items.length,
            workload_before: beforeSummary,
            workload_after: afterSummary,
            reason,
          },
        });
      }
      return transferId;
    });
    return this._result(execute());
  }
}

module.exports = {
  ENTITY_TYPES,
  WorkTransferError,
  WorkTransferService,
};
