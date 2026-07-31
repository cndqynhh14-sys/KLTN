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
