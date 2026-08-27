'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const CorrectiveRequirementRepository = require('../server/repositories/CorrectiveRequirementRepository');
const {
  displayCorrectiveRequirementName,
  normalizeCorrectiveRequirementName,
} = require('../server/domain/correctiveRequirements');

function createRepository() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE corrective_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return { db, repository: new CorrectiveRequirementRepository(db) };
}

test('corrective requirement normalization is whitespace, case and Unicode safe', () => {
  const decomposed = 'Bổ sung hồ sơ';
  assert.equal(displayCorrectiveRequirementName('  Bổ   sung\t hồ sơ  '), 'Bổ sung hồ sơ');
  assert.equal(normalizeCorrectiveRequirementName('BỔ SUNG HỒ SƠ'), 'bổ sung hồ sơ');
  assert.equal(normalizeCorrectiveRequirementName(decomposed), 'bổ sung hồ sơ');
});

test('repository returns the canonical row for normalized duplicate creation', () => {
  const { db, repository } = createRepository();
  try {
    const first = repository.createOrGet('  Cập nhật   quy trình vệ sinh ');
    const duplicate = repository.createOrGet('CẬP NHẬT QUY TRÌNH VỆ SINH');
    assert.equal(first.created, true);
    assert.equal(first.item.name, 'Cập nhật quy trình vệ sinh');
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.item.id, first.item.id);
    assert.equal(repository.listActive().length, 1);
    assert.throws(() => db.prepare(`INSERT INTO corrective_requirements (name, normalized_name)
      VALUES ('Khác', ?)`).run(first.item.normalized_name), /UNIQUE/);
  } finally {
    db.close();
  }
});
