'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'Template');
const EXPECTED_CELLS = Object.freeze([
  'P4', 'C8', 'C9', 'D12', 'D13', 'D14', 'D17', 'D18', 'D19', 'D20',
]);
const EXTERNAL_REFERENCE = /\[[0-9]+\][^!]+!/;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function findTemplate() {
  const candidates = fs.readdirSync(TEMPLATE_DIR)
    .filter((name) => name.toLowerCase().endsWith('.xlsx') && name.includes('NCC_2.xlsx'));
  if (candidates.length !== 1) throw new Error(`working_minutes_template_ambiguous:${candidates.length}`);
  return path.join(TEMPLATE_DIR, candidates[0]);
}

function references(workbook) {
  const result = [];
  for (const sheetName of workbook.SheetNames || []) {
    const worksheet = workbook.Sheets[sheetName];
    for (const [address, cell] of Object.entries(worksheet || {})) {
      if (address.startsWith('!') || !cell?.f || !EXTERNAL_REFERENCE.test(String(cell.f))) continue;
      result.push({ sheet_name: sheetName, cell: address, formula: String(cell.f) });
    }
  }
  return result;
}

function main() {
  const write = process.argv.includes('--write');
  const target = findTemplate();
  const beforeBuffer = fs.readFileSync(target);
  const workbook = XLSX.read(beforeBuffer, { type: 'buffer', cellFormula: true, cellStyles: true, cellDates: true });
  const before = references(workbook);
  if (!write) {
    process.stdout.write(`${JSON.stringify({ mode: 'CHECK', file: path.basename(target), sha256: sha256(beforeBuffer), references: before }, null, 2)}\n`);
    process.exitCode = before.length ? 1 : 0;
    return;
  }
  if (before.length === 0) {
    process.stdout.write(`${JSON.stringify({
      mode: 'WRITE',
      result: 'ALREADY_CLEAN',
      file: path.basename(target),
      sha256: sha256(beforeBuffer),
      removed: [],
      remaining_external_references: 0,
    }, null, 2)}\n`);
    return;
  }
  const actualCells = before.map((item) => item.cell).sort();
  const expectedCells = [...EXPECTED_CELLS].sort();
  if (JSON.stringify(actualCells) !== JSON.stringify(expectedCells)) {
    throw new Error(`unexpected_external_formula_inventory:${actualCells.join(',')}`);
  }
  for (const item of before) {
    const cell = workbook.Sheets[item.sheet_name][item.cell];
    delete cell.f;
    cell.v = cell.v == null ? '' : cell.v;
    cell.t = typeof cell.v === 'number' ? 'n' : 's';
    delete cell.w;
  }
  const temp = `${target}.run21.tmp.xlsx`;
  XLSX.writeFile(workbook, temp, { bookType: 'xlsx', cellStyles: true, compression: true });
  const afterBuffer = fs.readFileSync(temp);
  const afterWorkbook = XLSX.read(afterBuffer, { type: 'buffer', cellFormula: true, cellStyles: true });
  const after = references(afterWorkbook);
  if (after.length) {
    fs.rmSync(temp, { force: true });
    throw new Error(`external_formulas_remain:${after.map((item) => item.cell).join(',')}`);
  }
  fs.copyFileSync(temp, target);
  fs.rmSync(temp, { force: true });
  process.stdout.write(`${JSON.stringify({
    mode: 'WRITE',
    file: path.basename(target),
    before_sha256: sha256(beforeBuffer),
    after_sha256: sha256(afterBuffer),
    removed: before,
    remaining_external_references: after.length,
  }, null, 2)}\n`);
}

main();
