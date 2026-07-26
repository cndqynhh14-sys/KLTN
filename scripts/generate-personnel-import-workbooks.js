#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const {
  CANONICAL_PERSONNEL_HEADERS,
  PERSONNEL_IMPORT_SHEETS,
} = require('../server/services/personnelImportContract');

const GUIDE_ROWS = Object.freeze([
  Object.freeze(['Hợp đồng', 'Personnel import v1']),
  Object.freeze(['Quy trình', 'Upload chỉ tạo preview; validate trước; commit toàn bộ hoặc không commit.']),
  Object.freeze(['email', 'Bắt buộc, lowercase, duy nhất trong file.']),
  Object.freeze(['role_codes', 'Stable role_code, nhiều giá trị phân cách bằng dấu chấm phẩy (;).']),
  Object.freeze(['valid_from / valid_until', 'YYYY-MM-DD hoặc RFC3339 có timezone.']),
  Object.freeze(['scope', 'scope_type/scope_value/scope_effect phải đủ bộ; v1 không hỗ trợ CUSTOM.']),
  Object.freeze(['Phòng ban', 'Không persist trong v1; map IGNORE nếu file nguồn có cột này.']),
]);

const EXAMPLE_ROWS = Object.freeze([
  Object.freeze({
    email: 'person-001@example.test',
    display_name: 'Synthetic specialist',
    active: 'TRUE',
    role_codes: 'QLCL_SPECIALIST;AUDITOR',
    valid_from: '2026-08-01',
    valid_until: '2030-12-31',
    scope_type: 'MCH2',
    scope_value: '203',
    scope_effect: 'ALLOW',
  }),
  Object.freeze({
    email: 'person-002@example.test',
    display_name: 'Synthetic uploader',
    active: 'TRUE',
    role_codes: 'QLCL_SPECIALIST;DATA_UPLOADER',
    valid_from: '',
    valid_until: '',
    scope_type: 'REGION',
    scope_value: 'REGION_SOUTH',
    scope_effect: 'ALLOW',
  }),
]);

function buildPersonnelImportWorkbook({ example = false } = {}) {
  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Title: example ? 'QLCL personnel import example' : 'QLCL personnel import template',
    Subject: 'PROMPT-06 deterministic personnel import contract',
    Author: 'QLCL',
    CreatedDate: new Date('2026-01-01T00:00:00.000Z'),
    ModifiedDate: new Date('2026-01-01T00:00:00.000Z'),
  };
  const guide = XLSX.utils.aoa_to_sheet(GUIDE_ROWS.map((row) => [...row]));
  guide['!cols'] = [{ wch: 28 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(workbook, guide, PERSONNEL_IMPORT_SHEETS.guide);

  const rows = [CANONICAL_PERSONNEL_HEADERS, ...(example ? EXAMPLE_ROWS.map((item) => (
    CANONICAL_PERSONNEL_HEADERS.map((header) => item[header] ?? '')
  )) : [])];
  const personnel = XLSX.utils.aoa_to_sheet(rows);
  personnel['!cols'] = [
    { wch: 34 }, { wch: 28 }, { wch: 12 }, { wch: 44 }, { wch: 24 },
    { wch: 24 }, { wch: 18 }, { wch: 24 }, { wch: 18 },
  ];
  XLSX.utils.book_append_sheet(workbook, personnel, PERSONNEL_IMPORT_SHEETS.data);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

function writePersonnelImportWorkbooks(outputDir = path.resolve(__dirname, '..', 'database', 'templates')) {
  fs.mkdirSync(outputDir, { recursive: true });
  const templatePath = path.join(outputDir, 'personnel-import-template.xlsx');
  const examplePath = path.join(outputDir, 'personnel-import-example.xlsx');
  fs.writeFileSync(templatePath, buildPersonnelImportWorkbook({ example: false }));
  fs.writeFileSync(examplePath, buildPersonnelImportWorkbook({ example: true }));
  return { templatePath, examplePath };
}

if (require.main === module) {
  const result = writePersonnelImportWorkbooks();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  EXAMPLE_ROWS,
  buildPersonnelImportWorkbook,
  writePersonnelImportWorkbooks,
};
