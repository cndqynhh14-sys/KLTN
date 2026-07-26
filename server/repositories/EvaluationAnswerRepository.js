class EvaluationAnswerRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      listByRound: db.prepare(`
        SELECT a.*, q.question_code, q.version_item_id
        FROM evaluation_answers a
        JOIN evaluation_rounds er ON er.id = a.round_id
        JOIN pinned_evaluation_questions q ON q.ticket_id = er.ticket_id AND q.id = a.question_id
        WHERE a.round_id = ?
      `),
      upsertAnswer: db.prepare(`
        INSERT INTO evaluation_answers (round_id, question_id, score, comment, calculated_score, answered_by, updated_at)
        VALUES (@round_id, @question_id, @score, @comment, @calculated_score, @answered_by, datetime('now'))
        ON CONFLICT(round_id, question_id) DO UPDATE SET
          score=excluded.score,
          comment=excluded.comment,
          calculated_score=excluded.calculated_score,
          updated_at=datetime('now'),
          answered_by=excluded.answered_by
      `),
      insertBlankIfMissing: db.prepare(`
        INSERT INTO evaluation_answers (round_id, question_id, answered_by, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(round_id, question_id) DO NOTHING
      `),
      getByRoundAndQuestion: db.prepare('SELECT id FROM evaluation_answers WHERE round_id = ? AND question_id = ?'),
    };
  }

  listRowsByRound(roundId) {
    return this.statements.listByRound.all(roundId);
  }

  upsert(payload) {
    return this.statements.upsertAnswer.run(payload);
  }

  insertBlankIfMissing(roundId, questionId, userEmail) {
    return this.statements.insertBlankIfMissing.run(roundId, questionId, userEmail);
  }

  getByRoundAndQuestion(roundId, questionId) {
    return this.statements.getByRoundAndQuestion.get(roundId, questionId);
  }
}

module.exports = EvaluationAnswerRepository;
