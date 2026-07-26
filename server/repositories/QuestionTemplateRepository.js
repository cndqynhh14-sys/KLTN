const { categoryCodeForLabel } = require('../scoring/scoringPolicyEngine');

class QuestionTemplateRepository {
  constructor(db) {
    this.db = db;
    this.questionListStatementCache = new Map();
    this.statements = {
      listActiveTemplates: db.prepare(`
        SELECT *
        FROM question_templates
        WHERE active = 1
        ORDER BY active DESC, template_code
      `),
      listAllTemplates: db.prepare(`
        SELECT *
        FROM question_templates
        ORDER BY active DESC, template_code
      `),
      getTemplateById: db.prepare('SELECT * FROM question_templates WHERE id = ?'),
      insertTemplate: db.prepare(`
        INSERT INTO question_templates (template_code, template_name, description, active)
        VALUES (@template_code, @template_name, @description, @active)
      `),
      updateTemplate: db.prepare(`
        UPDATE question_templates
        SET template_code=@template_code, template_name=@template_name, description=@description,
            active=@active, updated_at=datetime('now')
        WHERE id=@id
      `),
      listImportedVariants: db.prepare(`
        SELECT
          t.id AS template_id,
          t.template_code,
          t.template_name,
          q.facility_type,
          q.supplier_scale,
          COUNT(*) AS criterion_count,
          SUM(CASE WHEN q.is_elimination_clause = 1 THEN 1 ELSE 0 END) AS elimination_count,
          SUM(CASE WHEN q.is_critical_clause = 1 THEN 1 ELSE 0 END) AS critical_count,
          MIN(q.order_index) AS first_order_index,
          MAX(q.order_index) AS last_order_index
        FROM evaluation_questions q
        JOIN question_templates t ON t.id = q.template_id
        WHERE q.active = 1 AND t.active = 1
        GROUP BY t.id, t.template_code, t.template_name, q.facility_type, q.supplier_scale
        ORDER BY t.template_code, q.facility_type, q.supplier_scale
      `),
      getQuestionByTemplate: db.prepare('SELECT * FROM evaluation_questions WHERE id = ? AND template_id = ?'),
      insertQuestion: db.prepare(`
        INSERT INTO evaluation_questions (
          template_id, facility_type, supplier_scale, question_code, question_text, category,
          category_code, category_label_snapshot,
          is_elimination_clause, is_critical_clause, requires_attachment, allowed_scores,
          weight, order_index, active
        )
        VALUES (
          @template_id, @facility_type, @supplier_scale, @question_code, @question_text, @category,
          @category_code, @category_label_snapshot,
          @is_elimination_clause, @is_critical_clause, @requires_attachment, @allowed_scores,
          @weight, @order_index, @active
        )
      `),
      updateQuestion: db.prepare(`
        UPDATE evaluation_questions
        SET facility_type=@facility_type, supplier_scale=@supplier_scale, question_code=@question_code,
            question_text=@question_text, category=@category,
            category_code=@category_code, category_label_snapshot=@category_label_snapshot,
            is_elimination_clause=@is_elimination_clause, is_critical_clause=@is_critical_clause,
            requires_attachment=@requires_attachment, allowed_scores=@allowed_scores,
            weight=@weight, order_index=@order_index, active=@active, updated_at=datetime('now')
        WHERE id=@id AND template_id=@template_id
      `),
      getQuestionDetail: db.prepare(`
        SELECT q.*, t.template_code
        FROM evaluation_questions q
        JOIN question_templates t ON t.id = q.template_id
        WHERE q.id = ?
      `),
      deactivateQuestion: db.prepare(`
        UPDATE evaluation_questions SET active = 0, updated_at = datetime('now')
        WHERE id = ? AND template_id = ?
      `),
    };
  }

  listTemplates(includeInactive) {
    return (includeInactive ? this.statements.listAllTemplates : this.statements.listActiveTemplates).all();
  }

  getTemplateById(id) {
    return this.statements.getTemplateById.get(id);
  }

  insertTemplate(payload) {
    return this.statements.insertTemplate.run(payload);
  }

  updateTemplate(payload) {
    return this.statements.updateTemplate.run(payload);
  }

  listImportedVariants() {
    return this.statements.listImportedVariants.all();
  }

  listQuestions({ templateId, includeInactive, facilityType, supplierScale }) {
    const where = ['q.template_id = @template_id'];
    const params = { template_id: templateId };
    if (!includeInactive) where.push('q.active = 1');
    if (facilityType) {
      where.push('q.facility_type = @facility_type');
      params.facility_type = facilityType;
    }
    if (supplierScale) {
      where.push('q.supplier_scale = @supplier_scale');
      params.supplier_scale = supplierScale;
    }

    const cacheKey = where.join('|');
    let statement = this.questionListStatementCache.get(cacheKey);
    if (!statement) {
      statement = this.db.prepare(`
        SELECT q.*, t.template_code
        FROM evaluation_questions q
        JOIN question_templates t ON t.id = q.template_id
        WHERE ${where.join(' AND ')}
        ORDER BY q.active DESC, q.facility_type, q.supplier_scale, q.order_index, q.question_code
      `);
      this.questionListStatementCache.set(cacheKey, statement);
    }
    return statement.all(params);
  }

  getQuestionByTemplate(questionId, templateId) {
    return this.statements.getQuestionByTemplate.get(questionId, templateId);
  }

  insertQuestion(payload) {
    return this.statements.insertQuestion.run(this.withCategoryIdentity(payload));
  }

  updateQuestion(payload) {
    return this.statements.updateQuestion.run(this.withCategoryIdentity(payload));
  }

  withCategoryIdentity(payload) {
    return {
      ...payload,
      category_code: payload.category_code || categoryCodeForLabel(payload.category),
      category_label_snapshot: payload.category_label_snapshot || payload.category,
    };
  }

  getQuestionDetail(questionId) {
    return this.statements.getQuestionDetail.get(questionId);
  }

  deactivateQuestion(questionId, templateId) {
    return this.statements.deactivateQuestion.run(questionId, templateId);
  }
}

module.exports = QuestionTemplateRepository;
