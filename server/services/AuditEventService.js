'use strict';

const crypto = require('node:crypto');
const { getContext, updateContext } = require('../observability/context');
const { redact, sanitizeString } = require('../observability/redact');
const { AUDIT_CATALOG_VERSION, getAuditEventDefinition } = require('../audit/eventCatalog');

const GENESIS_HASH = '0'.repeat(64);
const OUTCOMES = new Set(['SUCCESS', 'FAILURE', 'DENIED', 'DEGRADED']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function allowlist(source, fields) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return Object.fromEntries(fields
    .filter((field) => Object.prototype.hasOwnProperty.call(source, field))
    .map((field) => [field, source[field]]));
}

function allowlistedDiff(before, after, fields) {
  const changes = {};
  for (const field of fields) {
    const previous = before && Object.prototype.hasOwnProperty.call(before, field) ? before[field] : null;
    const next = after && Object.prototype.hasOwnProperty.call(after, field) ? after[field] : null;
    if (canonicalJson(previous) !== canonicalJson(next)) changes[field] = { before: previous, after: next };
  }
  return changes;
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

class AuditEventService {
  constructor(db, options = {}) {
    this.db = db;
    this.clock = options.clock || (() => new Date());
    this.insert = db.prepare(`INSERT INTO audit_events (
      occurred_at, catalog_version, category, event_name, severity,
      actor_user_id, actor_email_snapshot, actor_roles_json, request_id, correlation_id, uat_run_id,
      entity_type, entity_id, action, outcome, reason_code, summary, metadata_json,
      idempotency_key, previous_hash, event_hash
    ) VALUES (
      @occurred_at, @catalog_version, @category, @event_name, @severity,
      @actor_user_id, @actor_email_snapshot, @actor_roles_json, @request_id, @correlation_id, @uat_run_id,
      @entity_type, @entity_id, @action, @outcome, @reason_code, @summary, @metadata_json,
      @idempotency_key, @previous_hash, @event_hash
    )`);
  }

  actorIdentity(identifier) {
    if (!identifier) return null;
    const value = String(identifier).trim();
    return this.db.prepare(`SELECT user_id, email FROM users
      WHERE user_id = ? OR lower(email) = lower(?)`).get(value, value) || null;
  }

  actorRoles(actorUserId, suppliedRoles) {
    if (Array.isArray(suppliedRoles)) return [...new Set(suppliedRoles.map(String))].sort();
    if (!actorUserId) return [];
    try {
      return this.db.prepare(`SELECT DISTINCT r.role_code FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ? AND ur.active = 1 AND r.active = 1
        ORDER BY r.role_code`).all(actorUserId).map((row) => row.role_code);
    } catch {
      return [];
    }
  }

  buildRow(event, previousHash) {
    const definition = getAuditEventDefinition(event.eventName);
    if (!definition) throw Object.assign(new Error('audit_event_not_cataloged'), { code: 'AUDIT_EVENT_NOT_CATALOGED' });
    const outcome = String(event.outcome || 'SUCCESS').toUpperCase();
    if (!OUTCOMES.has(outcome)) throw Object.assign(new Error('audit_outcome_invalid'), { code: 'AUDIT_OUTCOME_INVALID' });
    const context = getContext();
    const metadata = redact(allowlist(event.metadata, definition.metadataFields));
    const changes = redact(allowlistedDiff(event.before, event.after, definition.diffFields));
    if (Object.keys(changes).length) {
      metadata.changed_fields = Object.keys(changes).sort();
      metadata.changes = changes;
    }
    const actor = this.actorIdentity(event.actorUserId);
    const row = {
      occurred_at: this.clock().toISOString(),
      catalog_version: AUDIT_CATALOG_VERSION,
      category: definition.category,
      event_name: definition.name,
      severity: event.severity || definition.severity,
      actor_user_id: actor?.user_id || null,
      actor_email_snapshot: actor?.email || (event.actorEmailSnapshot ? sanitizeString(event.actorEmailSnapshot, 320).toLowerCase() : null),
      actor_roles_json: canonicalJson(this.actorRoles(actor?.user_id || event.actorUserId, event.actorRoles)),
      request_id: sanitizeString(event.requestId || context.request_id || '', 128) || null,
      correlation_id: sanitizeString(event.correlationId || context.correlation_id || '', 128) || null,
      uat_run_id: sanitizeString(event.uatRunId || context.uat_run_id || '', 128) || null,
      entity_type: sanitizeString(event.entityType || definition.category.toUpperCase(), 64),
      entity_id: event.entityId == null ? null : sanitizeString(event.entityId, 320),
      action: sanitizeString(event.action || definition.name.split('.').at(-1).toUpperCase(), 64).toUpperCase(),
      outcome,
      reason_code: event.reasonCode ? sanitizeString(event.reasonCode, 128) : null,
      summary: sanitizeString(event.summary || definition.name, 512),
      metadata_json: Object.keys(metadata).length ? canonicalJson(metadata) : null,
      idempotency_key: event.idempotencyKey ? sanitizeString(event.idempotencyKey, 256) : null,
      previous_hash: previousHash,
    };
    row.event_hash = hashPayload({
      ...row,
      actor_user_id: row.actor_email_snapshot,
      actor_principal_id: row.actor_user_id,
      actor_email_snapshot: undefined,
    });
    return row;
  }

  record(event) {
    if (!event || typeof event !== 'object') throw new TypeError('audit_event_required');
    if (event.idempotencyKey) {
      const existing = this.db.prepare('SELECT id, event_hash FROM audit_events WHERE idempotency_key = ?')
        .get(sanitizeString(event.idempotencyKey, 256));
      if (existing) return { id: existing.id, eventHash: existing.event_hash, deduplicated: true };
    }
    const append = () => {
      if (event.idempotencyKey) {
        const existing = this.db.prepare('SELECT id, event_hash FROM audit_events WHERE idempotency_key = ?')
          .get(sanitizeString(event.idempotencyKey, 256));
        if (existing) return { id: existing.id, eventHash: existing.event_hash, deduplicated: true };
      }
      const previous = this.db.prepare('SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1').get();
      const row = this.buildRow(event, previous?.event_hash || GENESIS_HASH);
      const result = this.insert.run(row);
      const context = getContext();
      updateContext({ audit_mutation_recorded: true, audit_event_id: Number(result.lastInsertRowid) });
      return { id: Number(result.lastInsertRowid), eventHash: row.event_hash, deduplicated: false };
    };
    return this.db.inTransaction ? append() : this.db.transaction(append)();
  }

  verifyChain() {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY id').all();
    const failures = [];
    let previousHash = GENESIS_HASH;
    for (const row of rows) {
      const payload = {
        occurred_at: row.occurred_at,
        catalog_version: row.catalog_version,
        category: row.category,
        event_name: row.event_name,
        severity: row.severity,
        actor_user_id: row.actor_email_snapshot,
        actor_roles_json: row.actor_roles_json,
        request_id: row.request_id,
        correlation_id: row.correlation_id,
        uat_run_id: row.uat_run_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        action: row.action,
        outcome: row.outcome,
        reason_code: row.reason_code,
        summary: row.summary,
        metadata_json: row.metadata_json,
        idempotency_key: row.idempotency_key,
        previous_hash: row.previous_hash,
      };
      if (String(row.catalog_version).localeCompare('1.8.0', undefined, { numeric: true }) >= 0) {
        payload.actor_principal_id = row.actor_user_id;
      }
      const expected = hashPayload(payload);
      if (row.previous_hash !== previousHash || row.event_hash !== expected) {
        failures.push({ id: row.id, previous_hash_valid: row.previous_hash === previousHash, event_hash_valid: row.event_hash === expected });
      }
      previousHash = row.event_hash;
    }
    return { valid: failures.length === 0, checked: rows.length, failures };
  }
}

module.exports = {
  AuditEventService,
  GENESIS_HASH,
  allowlistedDiff,
  canonicalJson,
  hashPayload,
};
