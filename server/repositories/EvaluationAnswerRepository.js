class EvaluationAnswerRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      listByRound: db.prepare(`
        SELECT a.*, a.question_item_id AS question_id,
          qi.question_code AS question_code,
          a.question_item_id AS resolved_question_item_id
        FROM evaluation_answers a
        JOIN question_items qi ON qi.id = a.question_item_id
        WHERE a.round_id = ?
      `),
      upsertAnswer: db.prepare(`
        INSERT INTO evaluation_answers (
          round_id, question_item_id, score, comment,
          calculated_score, answered_by, updated_at
        )
        VALUES (
          @round_id, @question_item_id, @score, @comment,
          @calculated_score, @answered_by, datetime('now')
        )
        ON CONFLICT(round_id, question_item_id) DO UPDATE SET
          score=excluded.score,
          comment=excluded.comment,
          calculated_score=excluded.calculated_score,
          updated_at=datetime('now'),
          answered_by=excluded.answered_by
      `),
      insertBlankIfMissing: db.prepare(`
        INSERT INTO evaluation_answers (round_id, question_item_id, answered_by, updated_at)
        VALUES (@round_id, @question_item_id, @answered_by, datetime('now'))
        ON CONFLICT(round_id, question_item_id) DO NOTHING
      `),
      resolveQuestionItem: db.prepare(`
        SELECT q.id
        FROM evaluation_rounds r
        JOIN pinned_evaluation_questions q ON q.ticket_id = r.ticket_id
        WHERE r.id = ? AND q.id = ?
      `),
      getByRoundAndQuestion: db.prepare('SELECT id FROM evaluation_answers WHERE round_id = ? AND question_item_id = ?'),
    };
  }

  listRowsByRound(roundId) {
    return this.statements.listByRound.all(roundId);
  }

  upsert(payload) {
    const inputId = payload.question_item_id || payload.question_id;
    const item = this.statements.resolveQuestionItem.get(payload.round_id, inputId);
    if (!item) throw Object.assign(new Error('question_not_in_ticket'), { code: 'question_not_in_ticket' });
    return this.statements.upsertAnswer.run({ ...payload, question_item_id: item.id });
  }

  insertBlankIfMissing(roundId, questionId, userEmail) {
    const item = this.statements.resolveQuestionItem.get(roundId, questionId);
    return this.statements.insertBlankIfMissing.run({
      round_id: roundId,
      question_item_id: item?.id,
      answered_by: userEmail,
    });
  }

  getByRoundAndQuestion(roundId, questionId) {
    return this.statements.getByRoundAndQuestion.get(roundId, questionId);
  }
}

module.exports = EvaluationAnswerRepository;
