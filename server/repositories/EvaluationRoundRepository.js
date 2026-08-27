const EvaluationParticipantRepository = require('./EvaluationParticipantRepository');

class EvaluationRoundRepository {
  constructor(db) {
    this.db = db;
    this.participantRepository = new EvaluationParticipantRepository(db);
    this.statements = {
      getByTicketAndRound: db.prepare(`
        SELECT r.*, source.assessment_code AS source_assessment_code, source.round_no AS source_round_no
        FROM evaluation_rounds r
        LEFT JOIN evaluation_rounds source ON source.id = r.source_round_id
        WHERE r.ticket_id = ? AND r.round_no = ?
      `),
      listByTicket: db.prepare(`
        SELECT r.*, source.assessment_code AS source_assessment_code, source.round_no AS source_round_no
        FROM evaluation_rounds r
        LEFT JOIN evaluation_rounds source ON source.id = r.source_round_id
        WHERE r.ticket_id = ?
        ORDER BY r.round_no
      `),
      insert: db.prepare(`
        INSERT INTO evaluation_rounds (ticket_id, round_no, source_round_id, assessment_code, assessment_date, status)
        VALUES (@ticket_id, @round_no, @source_round_id, @assessment_code, @assessment_date, @status)
      `),
      markProcessingIfDraft: db.prepare('UPDATE evaluation_rounds SET status = ? WHERE id = ? AND status = ?'),
      complete: db.prepare(`
        UPDATE evaluation_rounds
        SET status='Hoàn thành', completed_at=datetime('now'), assessment_date=@assessment_date,
            total_score=@total_score,
            final_result=@final_result, classification=@classification,
            scoring_policy_version_id=@scoring_policy_version_id,
            scoring_result_snapshot_json=@scoring_result_snapshot_json,
            scoring_result_checksum=@scoring_result_checksum,
            locked_at=datetime('now'), locked_by=@locked_by,
            correction_locked=1
        WHERE id=@id
      `),
      setCorrectionLock: db.prepare(`
        UPDATE evaluation_rounds
        SET correction_locked = @locked
        WHERE ticket_id = @ticket_id
          AND round_no = @round_no
      `),
      activeCorrectionStats: db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
        FROM evaluation_nonconformities
        WHERE ticket_id = ?
          AND round_id = ?
          AND severity IN ('B', 'C', 'D')
          AND status != 'CANCELLED'
      `),
    };
  }

  getByTicketAndRound(ticketId, roundNo) {
    return this.statements.getByTicketAndRound.get(ticketId, roundNo);
  }

  listByTicket(ticketId) {
    return this.statements.listByTicket.all(ticketId);
  }

  insert(payload) {
    const info = this.statements.insert.run(payload);
    this.participantRepository.setRoundEvaluator(
      info.lastInsertRowid,
      payload.evaluator_id,
      payload.evaluator_id,
    );
    this.participantRepository.ensureRoundOwnerAttendee(info.lastInsertRowid, payload.evaluator_id);
    return info;
  }

  markProcessingIfDraft({ roundId, processingStatus, draftStatus }) {
    return this.statements.markProcessingIfDraft.run(processingStatus, roundId, draftStatus);
  }

  complete(payload) {
    return this.statements.complete.run(payload);
  }

  updateAttendees(roundId, attendees, actor = null) {
    this.participantRepository.setRoundAttendees(roundId, attendees, actor);
    this.participantRepository.ensureRoundOwnerAttendee(roundId, actor);
    return { changes: 1 };
  }

  setCorrectionLock({ ticketId, roundNo, locked }) {
    return this.statements.setCorrectionLock.run({
      ticket_id: ticketId,
      round_no: roundNo,
      locked: locked ? 1 : 0,
    });
  }

  activeCorrectionStats(ticketId, roundId) {
    return this.statements.activeCorrectionStats.get(ticketId, roundId);
  }
}

module.exports = EvaluationRoundRepository;
