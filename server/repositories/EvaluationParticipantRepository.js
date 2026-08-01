'use strict';

function parseJsonArray(value) {
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
    opening: !!(value?.opening || value?.opening_meeting),
    closing: !!(value?.closing || value?.closing_meeting),
  };
}

class EvaluationParticipantRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      ticket: db.prepare('SELECT * FROM evaluation_tickets WHERE id = ?'),
      round: db.prepare('SELECT * FROM evaluation_rounds WHERE id = ?'),
      ticketParticipants: db.prepare(`SELECT * FROM evaluation_participants
        WHERE ticket_id = ? AND active = 1
        ORDER BY participant_role, id`),
      roundParticipants: db.prepare(`SELECT * FROM evaluation_participants
        WHERE round_id = ? AND active = 1
        ORDER BY participant_role, id`),
      usersByEmail: db.prepare(`SELECT email, display_name FROM users
        WHERE lower(email) = lower(?) ORDER BY email`),
      deleteTicketProjection: db.prepare(`DELETE FROM evaluation_participants
        WHERE ticket_id = ? AND participant_role IN ('OWNER', 'QA_LEAD', 'QA_SUPPORT', 'EVALUATOR')`),
      deleteRoundProjection: db.prepare(`DELETE FROM evaluation_participants
        WHERE round_id = ? AND participant_role IN ('EVALUATOR', 'ATTENDEE')`),
      insert: db.prepare(`INSERT OR IGNORE INTO evaluation_participants (
        ticket_id, round_id, user_id, display_name, participant_role,
        opening_meeting, closing_meeting, assigned_at, assigned_by
      ) VALUES (
        @ticket_id, @round_id, @user_id, @display_name, @participant_role,
        @opening_meeting, @closing_meeting, @assigned_at, @assigned_by
      )`),
    };
  }

  user(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    const rows = this.statements.usersByEmail.all(normalized);
    return rows.length === 1 ? rows[0] : null;
  }

  actor(value) {
    return this.user(value)?.email || null;
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

  legacyParticipant({ ticketId = null, roundId = null, identity, displayName = null,
    role, opening = false, closing = false }) {
    const normalized = String(identity || displayName || '').trim();
    if (!normalized) return null;
    const user = this.user(identity);
    return {
      id: null,
      ticket_id: ticketId,
      round_id: roundId,
      user_id: user?.email || null,
      display_name: String(displayName || user?.display_name || user?.email || normalized).trim(),
      participant_role: role,
      opening_meeting: !!opening,
      closing_meeting: !!closing,
      active: true,
      assigned_at: null,
      assigned_by: null,
      source: 'LEGACY',
    };
  }

  legacyTicketParticipants(ticket) {
    if (!ticket) return [];
    const participants = [
      this.legacyParticipant({ ticketId: ticket.id, identity: ticket.assigned_specialist_id, role: 'OWNER' }),
      this.legacyParticipant({ ticketId: ticket.id, identity: ticket.qa_lead_id, role: 'QA_LEAD' }),
      this.legacyParticipant({
        ticketId: ticket.id,
        identity: ticket.evaluator_name,
        displayName: ticket.evaluator_name,
        role: 'EVALUATOR',
      }),
    ];
    for (const support of parseJsonArray(ticket.qa_support_ids)) {
      if (typeof support !== 'string') continue;
      participants.push(this.legacyParticipant({
        ticketId: ticket.id,
        identity: support,
        displayName: support,
        role: 'QA_SUPPORT',
      }));
    }
    return participants.filter(Boolean);
  }

  legacyRoundParticipants(round) {
    if (!round) return [];
    const participants = [this.legacyParticipant({
      roundId: round.id,
      identity: round.evaluator_id,
      role: 'EVALUATOR',
    })];
    for (const raw of parseJsonArray(round.attendees_json)) {
      const attendee = normalizedAttendee(raw);
      if (!attendee.name) continue;
      participants.push(this.legacyParticipant({
        roundId: round.id,
        identity: attendee.name,
        displayName: attendee.name,
        role: 'ATTENDEE',
        opening: attendee.opening,
        closing: attendee.closing,
      }));
    }
    return participants.filter(Boolean);
  }

  resolveParticipants(canonical, legacy) {
    const canonicalByRole = new Map();
    const legacyByRole = new Map();
    for (const participant of canonical) {
      const rows = canonicalByRole.get(participant.participant_role) || [];
      rows.push(participant);
      canonicalByRole.set(participant.participant_role, rows);
    }
    for (const participant of legacy) {
      const rows = legacyByRole.get(participant.participant_role) || [];
      rows.push(participant);
      legacyByRole.set(participant.participant_role, rows);
    }

    const identity = (participant) => String(
      participant.user_id || participant.display_name || '',
    ).trim().toLocaleLowerCase('en-US');
    const roles = new Set([...canonicalByRole.keys(), ...legacyByRole.keys()]);
    const participants = [];
    let fallbackCount = 0;
    let mismatchCount = 0;
    for (const role of roles) {
      const canonicalRows = canonicalByRole.get(role) || [];
      const legacyRows = legacyByRole.get(role) || [];
      if (canonicalRows.length) {
        participants.push(...canonicalRows);
        if (legacyRows.length) {
          const canonicalIdentities = canonicalRows.map(identity).sort().join('|');
          const legacyIdentities = legacyRows.map(identity).sort().join('|');
          if (canonicalIdentities !== legacyIdentities) mismatchCount += 1;
        }
      } else {
        participants.push(...legacyRows);
        fallbackCount += legacyRows.length;
      }
    }
    const canonicalCount = participants.filter((row) => row.source === 'CANONICAL').length;
    const source = canonicalCount && fallbackCount
      ? 'MIXED'
      : canonicalCount
        ? 'CANONICAL'
        : fallbackCount
          ? 'LEGACY'
          : 'NONE';
    return {
      participants,
      source,
      mismatch: mismatchCount > 0,
      mismatch_count: mismatchCount,
      fallback_count: fallbackCount,
    };
  }

  resolveTicketParticipants(ticketId) {
    return this.resolveParticipants(
      this.canonicalParticipants('ticket', ticketId),
      this.legacyTicketParticipants(this.statements.ticket.get(ticketId)),
    );
  }

  resolveRoundParticipants(roundId) {
    return this.resolveParticipants(
      this.canonicalParticipants('round', roundId),
      this.legacyRoundParticipants(this.statements.round.get(roundId)),
    );
  }

  insertParticipant({ ticketId = null, roundId = null, identity = null, displayName = null,
    role, opening = false, closing = false, assignedAt = null, assignedBy = null }) {
    const user = this.user(identity);
    const name = String(displayName || user?.display_name || user?.email || identity || '').trim();
    if (!name) return;
    this.statements.insert.run({
      ticket_id: ticketId,
      round_id: roundId,
      user_id: user?.email || null,
      display_name: name,
      participant_role: role,
      opening_meeting: opening ? 1 : 0,
      closing_meeting: closing ? 1 : 0,
      assigned_at: assignedAt || new Date().toISOString(),
      assigned_by: this.actor(assignedBy),
    });
  }

  syncTicket(ticketId, actor = null) {
    const ticket = this.statements.ticket.get(ticketId);
    if (!ticket) return;
    this.statements.deleteTicketProjection.run(ticket.id);
    const common = {
      ticketId: ticket.id,
      assignedAt: ticket.created_at,
      assignedBy: actor || ticket.updated_by || ticket.created_by,
    };
    this.insertParticipant({ ...common, identity: ticket.assigned_specialist_id, role: 'OWNER' });
    this.insertParticipant({ ...common, identity: ticket.qa_lead_id, role: 'QA_LEAD' });
    for (const support of parseJsonArray(ticket.qa_support_ids)) {
      if (typeof support !== 'string') continue;
      this.insertParticipant({ ...common, identity: support, displayName: support, role: 'QA_SUPPORT' });
    }
    this.insertParticipant({
      ...common,
      identity: ticket.evaluator_name,
      displayName: ticket.evaluator_name,
      role: 'EVALUATOR',
    });
  }

  syncRound(roundId, actor = null) {
    const round = this.statements.round.get(roundId);
    if (!round) return;
    this.statements.deleteRoundProjection.run(round.id);
    const common = {
      roundId: round.id,
      assignedAt: round.started_at,
      assignedBy: actor || round.evaluator_id || round.locked_by,
    };
    this.insertParticipant({ ...common, identity: round.evaluator_id, role: 'EVALUATOR' });
    const attendees = new Map();
    for (const raw of parseJsonArray(round.attendees_json)) {
      const attendee = normalizedAttendee(raw);
      if (!attendee.name) continue;
      const key = attendee.name.toLocaleLowerCase('en-US');
      const existing = attendees.get(key) || { ...attendee, opening: false, closing: false };
      existing.opening = existing.opening || attendee.opening;
      existing.closing = existing.closing || attendee.closing;
      attendees.set(key, existing);
    }
    for (const attendee of attendees.values()) {
      this.insertParticipant({
        ...common,
        identity: attendee.name,
        displayName: attendee.name,
        role: 'ATTENDEE',
        opening: attendee.opening,
        closing: attendee.closing,
      });
    }
  }
}

module.exports = EvaluationParticipantRepository;
