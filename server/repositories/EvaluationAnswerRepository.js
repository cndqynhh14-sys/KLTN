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
        INSERT INTO evaluation_answers (
          round_id, question_id, question_item_id, score, comment,
          calculated_score, answered_by, updated_at
        )
        VALUES (
          @round_id, @question_id, @question_item_id, @score, @comment,
          @calculated_score, @answered_by, datetime('now')
        )
        ON CONFLICT(round_id, question_id) DO UPDATE SET
          question_item_id=COALESCE(excluded.question_item_id, evaluation_answers.question_item_id),
          score=excluded.score,
          comment=excluded.comment,
          calculated_score=excluded.calculated_score,
          updated_at=datetime('now'),
          answered_by=excluded.answered_by
      `),
      insertBlankIfMissing: db.prepare(`
        INSERT INTO evaluation_answers (round_id, question_id, question_item_id, answered_by, updated_at)
        VALUES (@round_id, @question_id, @question_item_id, @answered_by, datetime('now'))
        ON CONFLICT(round_id, question_id) DO NOTHING
      `),
      resolveQuestionItem: db.prepare(`
        SELECT q.version_item_id AS id
        FROM evaluation_rounds r
        JOIN pinned_evaluation_questions q ON q.ticket_id = r.ticket_id
        WHERE r.id = ? AND q.id = ? AND q.version_item_id IS NOT NULL
      `),
      getByRoundAndQuestion: db.prepare('SELECT id FROM evaluation_answers WHERE round_id = ? AND question_id = ?'),
    };
  }

  listRowsByRound(roundId) {
    return this.statements.listByRound.all(roundId);
  }

  upsert(payload) {
    const item = this.statements.resolveQuestionItem.get(payload.round_id, payload.question_id);
    return this.statements.upsertAnswer.run({ ...payload, question_item_id: item?.id || null });
  }

  insertBlankIfMissing(roundId, questionId, userEmail) {
    const item = this.statements.resolveQuestionItem.get(roundId, questionId);
    return this.statements.insertBlankIfMissing.run({
      round_id: roundId,
      question_id: questionId,
      question_item_id: item?.id || null,
      answered_by: userEmail,
    });
  }

  getByRoundAndQuestion(roundId, questionId) {
    return this.statements.getByRoundAndQuestion.get(roundId, questionId);
  }
}

module.exports = EvaluationAnswerRepository;
