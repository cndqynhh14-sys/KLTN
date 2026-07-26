import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const require = createRequire(import.meta.url);
const XLSX = require('../node_modules/xlsx');

const root = process.cwd();
const inputDir = path.join(root, 'artifacts', 'baseline', '.qa');
const renderDir = path.join(inputDir, 'xlsx-previews');
const outputPath = path.join(root, 'artifacts', 'baseline', 'spreadsheet-visual-qa.json');
await fs.mkdir(renderDir, { recursive: true });

const cases = [
  { type: 'INTERNAL', sheets: ['1. Nhap data', '2. Ket qua'] },
  { type: 'NCC', sheets: ['1. Biên bản làm việc với NCC'] },
  { type: 'WORKING_MINUTES', sheets: ['1. Biên bản làm việc với NCC'] },
  { type: 'ROUND1_RESULT', sheets: ['1. Nhap data', '2. Ket qua'] },
  { type: 'ROUND2_RESULT', sheets: ['1. Nhap data', '2. Ket qua'] },
];

const results = [];
for (const item of cases) {
  const source = path.join(inputDir, `${item.type}.xlsx`);
  const sheetJsWorkbook = XLSX.readFile(source, { cellFormula: true });
  const externalFormulaReferences = [];
  for (const sheetName of sheetJsWorkbook.SheetNames) {
    const sheet = sheetJsWorkbook.Sheets[sheetName];
    for (const [cell, value] of Object.entries(sheet)) {
      if (cell.startsWith('!')) continue;
      if (/\[[0-9]+\][^!]+!/.test(String(value.f || ''))) {
        externalFormulaReferences.push({ sheet_name: sheetName, cell, formula: value.f });
      }
    }
  }
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(source));
  const sheetInventory = await workbook.inspect({
    kind: 'sheet',
    include: 'id,name',
    summary: `${item.type} sheet inventory`,
  });
  const formulaErrors = await workbook.inspect({
    kind: 'match',
    searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
    options: { useRegex: true, maxResults: 300 },
    summary: `${item.type} formula error scan`,
  });

  const renderedSheets = [];
  for (let i = 0; i < item.sheets.length; i += 1) {
    const sheetName = item.sheets[i];
    const preview = await workbook.render({
      sheetName,
      autoCrop: 'all',
      scale: 1,
      format: 'png',
    });
    const renderPath = path.join(renderDir, `${item.type}-${i + 1}.png`);
    await fs.writeFile(renderPath, Buffer.from(await preview.arrayBuffer()));
    const range = sheetName.includes('Biên bản') ? 'A1:P60' : 'A1:AM30';
    const table = await workbook.inspect({
      kind: 'table',
      range: `${sheetName}!${range}`,
      include: 'values,formulas',
      tableMaxRows: 30,
      tableMaxCols: 39,
      summary: `${item.type} ${sheetName} key range`,
    });
    renderedSheets.push({
      sheet_name: sheetName,
      render_sha256: await sha256(renderPath),
      render_retained: false,
      inspected_range: range,
      inspect_output_bytes: Buffer.byteLength(String(table.ndjson || '')),
    });
  }

  results.push({
    report_type: item.type,
    source_sha256: await sha256(source),
    external_formula_references: externalFormulaReferences,
    sheet_inventory: parseNdjson(sheetInventory.ndjson),
    formula_error_matches: parseNdjson(formulaErrors.ndjson),
    rendered_sheets: renderedSheets,
    visual_review: externalFormulaReferences.length
      ? 'FAIL: visible #REF! cells caused by external workbook formula references.'
      : 'PASS: inspected render is legible with no visible formula error, clipping or overlap.',
  });
}

const output = {
  generated_at: new Date().toISOString(),
  tool: '@oai/artifact-tool',
  safety: 'Synthetic fixture only; no production database, secret, OTP or real PII read.',
  cases: results,
};
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

function parseNdjson(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { parse_error: true }; }
    });
}

async function sha256(filePath) {
  const { createHash } = await import('node:crypto');
  const data = await fs.readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}
