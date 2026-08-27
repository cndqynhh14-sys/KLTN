const {
  normalizeCorrectiveRequirementName,
  validateCorrectiveRequirementName,
} = require('../domain/correctiveRequirements');

class CorrectiveRequirementRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      listActive: db.prepare(`
        SELECT id, name, normalized_name, is_active, created_at, updated_at
        FROM corrective_requirements
        WHERE is_active = 1
        ORDER BY name COLLATE NOCASE, id
      `),
      getActiveById: db.prepare(`
        SELECT id, name, normalized_name, is_active, created_at, updated_at
        FROM corrective_requirements
        WHERE id = ? AND is_active = 1
      `),
      getByNormalizedName: db.prepare(`
        SELECT id, name, normalized_name, is_active, created_at, updated_at
        FROM corrective_requirements
        WHERE normalized_name = ?
      `),
      insert: db.prepare(`
        INSERT INTO corrective_requirements (name, normalized_name)
        VALUES (?, ?)
      `),
    };
  }

  listActive() {
    return this.statements.listActive.all();
  }

  getActiveById(id) {
    return this.statements.getActiveById.get(id) || null;
  }

  findByName(name) {
    const normalizedName = normalizeCorrectiveRequirementName(name);
    return normalizedName ? (this.statements.getByNormalizedName.get(normalizedName) || null) : null;
  }

  createOrGet(value) {
    const validated = validateCorrectiveRequirementName(value);
    if (!validated.ok) {
      throw Object.assign(new Error(validated.code), { status: 400, code: validated.code });
    }
    const existing = this.statements.getByNormalizedName.get(validated.normalizedName);
    if (existing) return { item: existing, created: false };
    try {
      const result = this.statements.insert.run(validated.name, validated.normalizedName);
      return { item: this.getActiveById(Number(result.lastInsertRowid)), created: true };
    } catch (error) {
      if (!String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) throw error;
      const concurrent = this.statements.getByNormalizedName.get(validated.normalizedName);
      if (!concurrent) throw error;
      return { item: concurrent, created: false };
    }
  }
}

module.exports = CorrectiveRequirementRepository;
