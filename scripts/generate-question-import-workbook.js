'use strict';

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { CANONICAL_HEADERS } = require('../server/services/QuestionImportService');

const output = path.resolve(__dirname, '..', 'database', 'templates', 'question-template-import.xlsx');
const definitions = {
  template_code: 'Stable template code, for example BM04.',
  variant_code: 'Stable code for one facility/scale variant.',
  facility_type: 'Stable facility enum used by ticket assignment.',
  supplier_scale: 'LARGE, SMALL, or ALL.',
  category_code: 'Stable category code; display-label changes do not change this code.',
  category_name: 'Category display label.',
  question_code: 'Stable question identity within a facility/scale variant.',
  clause_code: 'Stable clause/reference identity.',
  question_text: 'Question display text.',
  allowed_scores: 'Slash-separated subset of A/B/C/D/NA; elimination uses A/D/NA.',
  order: 'Positive integer no greater than 10000.',
  active: '1 or 0.',
  critical: '1 or 0.',
  elimination: '1 or 0.',
  requires_evidence: '1 or 0; forced to 0 for elimination clauses.',
};

const workbook = XLSX.utils.book_new();
const readme = XLSX.utils.aoa_to_sheet([
  ['Question template import — canonical schema v1'],
  ['1. Add rows only to the Questions sheet; keep every header unchanged.'],
  ['2. Upload creates a preview and diff. It never changes a question version.'],
  ['3. Commit requires the preview confirmation token and only targets a Draft.'],
  ['4. Publishing remains a separate, gated RUN-14 action.'],
  ['5. Do not use formulas, hyperlinks, macros, embedded objects, or external links.'],
]);
readme['!cols'] = [{ wch: 110 }];
XLSX.utils.book_append_sheet(workbook, readme, 'README');

const dictionary = XLSX.utils.aoa_to_sheet([
  ['column', 'required', 'definition'],
  ...CANONICAL_HEADERS.map((column) => [column, 'YES', definitions[column]]),
]);
dictionary['!cols'] = [{ wch: 24 }, { wch: 10 }, { wch: 85 }];
XLSX.utils.book_append_sheet(workbook, dictionary, 'Data Dictionary');

const questions = XLSX.utils.aoa_to_sheet([CANONICAL_HEADERS]);
questions['!cols'] = CANONICAL_HEADERS.map((column) => ({ wch: Math.max(14, column.length + 2) }));
XLSX.utils.book_append_sheet(workbook, questions, 'Questions');

fs.mkdirSync(path.dirname(output), { recursive: true });
XLSX.writeFile(workbook, output, { bookType: 'xlsx', compression: true });
process.stdout.write(`${output}\n`);
