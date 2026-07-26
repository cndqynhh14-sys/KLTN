'use strict';

const { MCH2_VALUES } = require('./merchandising');

function identifierPart(value) {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

const MCH2_ID_BY_NAME = new Map(MCH2_VALUES.map((name) => [name, `MCH2_${identifierPart(name)}`]));

function stableMch2Id(displayName) {
  return MCH2_ID_BY_NAME.get(String(displayName || '').trim()) || null;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function stableMch2Sql(columnSql) {
  const column = String(columnSql || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(column)) {
    throw new TypeError('mch2_scope_column_invalid');
  }
  const cases = [...MCH2_ID_BY_NAME.entries()]
    .map(([name, id]) => `WHEN ${sqlLiteral(name)} THEN ${sqlLiteral(id)}`)
    .join(' ');
  return `(CASE TRIM(COALESCE(${column}, '')) ${cases} ELSE NULL END)`;
}

module.exports = { stableMch2Id, stableMch2Sql };
