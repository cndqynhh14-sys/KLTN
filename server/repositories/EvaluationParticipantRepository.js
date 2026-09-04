'use strict';

function parseIdentityList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizedAttendee(value) {
  return {
    name: String(value?.name || value?.title || '').trim(),
    identity: String(value?.user_id || value?.identity || '').trim(),
    opening: !!(value?.opening || value?.opening_meeting),
    closing: !!(value?.closing || value?.closing_meeting),
  };
}

class EvaluationParticipantRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      ticket: db.prepare('SELECT id, created_at, created_by, updated_by FROM evaluation_tickets WHERE id = ?'),
      round: db.prepare('SELECT id, started_at, locked_by FROM evaluation_rounds WHERE id = ?'),
      roundOwnership: db.prepare(`SELECT r.id, r.started_at, r.completed_at, r.locked_at,
          r.status, t.source_kind, t.assigned_specialist_id
        FROM evaluation_rounds r
        JOIN evaluation_tickets t ON t.id = r.ticket_id
        WHERE r.id = ?`),
      ticketParticipants: db.prepare(`SELECT * FROM evaluation_participants
        WHERE ticket_id = ? AND active = 1
        ORDER BY participant_role, id`),
      roundParticipants: db.prepare(`SELECT * FROM evaluation_participants
        WHERE round_id = ? AND active = 1
        ORDER BY participant_role, id`),
      usersByIdentifier: db.prepare(`SELECT user_id, email, display_name FROM users
        WHERE user_id = ? OR lower(email) = lower(?) ORDER BY email`),
      deleteTicketProjection: db.prepare(`DELETE FROM evaluation_participants
        WHERE ticket_id = ? AND participant_role IN ('OWNER', 'QA_LEAD', 'QA_SUPPORT', 'EVALUATOR')`),
      deleteRoundEvaluator: db.prepare(`DELETE FROM evaluation_participants
        WHERE round_id = ? AND participant_role = 'EVALUATOR'`),
      deleteRoundAttendees: db.prepare(`DELETE FROM evaluation_participants
        WHERE round_id = ? AND participant_role = 'ATTENDEE'`),
      insert: db.prepare(`INSERT INTO evaluation_participants (
        ticket_id, round_id, user_id, display_name, participant_role,
        opening_meeting, closing_meeting, assigned_at, assigned_by
      ) VALUES (
        @ticket_id, @round_id, @user_id, @display_name, @participant_role,
        @opening_meeting, @closing_meeting, @assigned_at, @assigned_by
      )`),
      roundOwnerAttendee: db.prepare(`SELECT * FROM evaluation_participants
        WHERE round_id = @round_id AND participant_role = 'ATTENDEE' AND active = 1
          AND (
            user_id = @user_id
            OR lower(trim(display_name)) = lower(trim(@display_name))
          )
        ORDER BY id LIMIT 1`),
      canonicalizeRoundAttendee: db.prepare(`UPDATE evaluation_participants
        SET user_id = @user_id
        WHERE id = @id AND active = 1`),
    };
  }

  user(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    const rows = this.statements.usersByIdentifier.all(normalized, normalized);
    return rows.length === 1 ? rows[0] : null;
  }

  actor(value) {
    return this.user(value)?.user_id || null;
  }

  canonicalParticipants(scope, id) {
    const statement = scope === 'ticket'
      ? this.statements.ticketParticipants
      : this.statements.roundParticipants;
    return statement.all(id).map((row) => ({
      ...row,
      opening_meeting: !!row.opening_meeting,
      closing_meeting: !!row.closing_meeting,
      active: !!row.active,
      source: 'CANONICAL',
    }));
  }

  canonicalResolution(scope, id) {
    const participants = this.canonicalParticipants(scope, id);
    return {
      participants,
      source: participants.length ? 'CANONICAL' : 'NONE',
      mismatch: false,
      mismatch_count: 0,
      fallback_count: 0,
    };
  }

  resolveTicketParticipants(ticketId) {
    return this.canonicalResolution('ticket', ticketId);
  }

  resolveRoundParticipants(roundId) {
    return this.canonicalResolution('round', roundId);
  }

  ticketAssignments(ticketId) {
    const rows = this.canonicalParticipants('ticket', ticketId);
    const identities = (role) => rows
      .filter((row) => row.participant_role === role)
      .map((row) => row.user_id || row.display_name);
    return {
      evaluator: identities('EVALUATOR')[0] || '',
      qaLead: identities('QA_LEAD')[0] || '',
      qaSupport: identities('QA_SUPPORT'),
    };
  }

  insertParticipant({ ticketId = null, roundId = null, identity = null, displayName = null,
    role, opening = false, closing = false, assignedAt = null, assignedBy = null }) {
    const user = this.user(identity);
    const actor = this.user(assignedBy);
    const name = String(displayName || user?.display_name || user?.email || identity || '').trim();
    if (!name) return;
    this.statements.insert.run({
      ticket_id: ticketId,
      round_id: roundId,
      user_id: user?.user_id || null,
      display_name: name,
      participant_role: role,
      opening_meeting: opening ? 1 : 0,
      closing_meeting: closing ? 1 : 0,
      assigned_at: assignedAt || new Date().toISOString(),
      assigned_by: actor?.user_id || null,
    });
  }

  replaceTicketAssignments(ticketId, assignments = {}, actor = null) {
    const ticket = this.statements.ticket.get(ticketId);
    if (!ticket) return;
    this.statements.deleteTicketProjection.run(ticket.id);
    const common = {
      ticketId: ticket.id,
      assignedAt: ticket.created_at,
      assignedBy: actor || ticket.updated_by || ticket.created_by,
    };
    this.insertParticipant({ ...common, identity: assignments.owner, role: 'OWNER' });
    this.insertParticipant({ ...common, identity: assignments.qaLead, role: 'QA_LEAD' });
    const supports = new Map();
    for (const value of parseIdentityList(assignments.qaSupport)) {
      const identity = String(value || '').trim();
      if (identity) supports.set(identity.toLocaleLowerCase('en-US'), identity);
    }
    for (const identity of supports.values()) {
      this.insertParticipant({ ...common, identity, displayName: identity, role: 'QA_SUPPORT' });
    }
    this.insertParticipant({
      ...common,
      identity: assignments.evaluator,
      displayName: assignments.evaluator,
      role: 'EVALUATOR',
    });
  }

  setRoundEvaluator(roundId, evaluator, actor = null) {
    const round = this.statements.round.get(roundId);
    if (!round) return;
    this.statements.deleteRoundEvaluator.run(round.id);
    this.insertParticipant({
      roundId: round.id,
      identity: evaluator,
      role: 'EVALUATOR',
      assignedAt: round.started_at,
      assignedBy: actor || evaluator || round.locked_by,
    });
  }

  ensureRoundOwnerAttendee(roundId, actor = null) {
    const round = this.statements.roundOwnership.get(roundId);
    if (!round || round.source_kind !== 'NATIVE' || round.completed_at || round.locked_at || round.status === 'Hoàn thành') return null;
    const owner = this.user(round.assigned_specialist_id);
    if (!owner) return null;
    const lookup = {
      round_id: round.id,
      user_id: owner.user_id,
      display_name: owner.display_name || owner.email,
    };
    const existing = this.statements.roundOwnerAttendee.get(lookup);
    if (existing) {
      if (!existing.user_id) {
        this.statements.canonicalizeRoundAttendee.run({
          id: existing.id,
          user_id: owner.user_id,
        });
      }
      return existing.id;
    }
    this.insertParticipant({
      roundId: round.id,
      identity: owner.user_id,
      role: 'ATTENDEE',
      opening: true,
      closing: true,
      assignedAt: round.started_at,
      assignedBy: actor || owner.user_id,
    });
    return this.statements.roundOwnerAttendee.get(lookup)?.id || null;
  }

  setRoundAttendees(roundId, attendees, actor = null) {
    const round = this.statements.round.get(roundId);
    if (!round) return;
    this.statements.deleteRoundAttendees.run(round.id);
    const normalized = new Map();
    for (const raw of Array.isArray(attendees) ? attendees : []) {
      const attendee = normalizedAttendee(raw);
      if (!attendee.name) continue;
      const key = attendee.identity
        ? `identity:${attendee.identity.toLocaleLowerCase('en-US')}`
        : `name:${attendee.name.toLocaleLowerCase('en-US')}`;
      const existing = normalized.get(key) || { ...attendee, opening: false, closing: false };
      existing.opening = existing.opening || attendee.opening;
      existing.closing = existing.closing || attendee.closing;
      normalized.set(key, existing);
    }
    for (const attendee of normalized.values()) {
      this.insertParticipant({
        roundId: round.id,
        identity: attendee.identity || attendee.name,
        displayName: attendee.name,
        role: 'ATTENDEE',
        opening: attendee.opening,
        closing: attendee.closing,
        assignedAt: round.started_at,
        assignedBy: actor || round.locked_by,
      });
    }
  }
}

module.exports = EvaluationParticipantRepository;
