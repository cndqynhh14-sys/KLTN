'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEPRECATED_COLUMNS = [
  'production_address', 'evaluation_address', 'linked_facility_code', 'linked_facility_name',
  'linked_facility_address', 'linked_facility_type', 'mch2', 'mch3', 'product_group',
  'product_name', 'cmc_owner', 'cmc_head', 'business_license_file',
  'attp_certificate_type', 'attp_certificate_file',
];
const EXPECTED_COLUMNS = [
  'id', 'supplier_code', 'supplier_name', 'tax_code', 'address', 'region', 'province',
  'business_type', 'status', 'contact_name', 'contact_email', 'contact_phone', 'source_type',
  'import_batch_id', 'created_at', 'created_by', 'updated_at', 'updated_by',
];

test('RUN-32 migration physically narrows supplier_master and keeps ticket snapshots', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run32-${process.pid}-${Date.now()}.db`);
  const oldDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve('../server/config/paths')];
  delete require.cache[require.resolve('../server/db')];
  const { db } = require('../server/db');
  try {
    const supplierColumns = db.prepare('PRAGMA table_info(supplier_master)').all().map((row) => row.name);
    assert.deepEqual(supplierColumns, EXPECTED_COLUMNS);
    DEPRECATED_COLUMNS.forEach((column) => assert.equal(supplierColumns.includes(column), false, column));

    const ticketColumns = db.prepare('PRAGMA table_info(evaluation_tickets)').all().map((row) => row.name);
    DEPRECATED_COLUMNS.forEach((column) => {
      const ticketColumn = {
        evaluation_address: 'snapshot_evaluation_address',
        linked_facility_name: 'snapshot_linked_facility_name',
        linked_facility_address: 'snapshot_linked_facility_address',
        product_name: 'snapshot_product_name',
      }[column] || column;
      assert.equal(ticketColumns.includes(ticketColumn), true, `evaluation_tickets.${ticketColumn}`);
    });

    db.prepare(`INSERT INTO supplier_master
      (supplier_code, supplier_name, status, source_type) VALUES ('NCC-CASE', 'Case One', 'ACTIVE', 'MANUAL')`).run();
    assert.throws(() => db.prepare(`INSERT INTO supplier_master
      (supplier_code, supplier_name, status, source_type) VALUES (' ncc-case ', 'Case Two', 'ACTIVE', 'MANUAL')`).run(),
    /UNIQUE constraint failed/);
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    delete require.cache[require.resolve('../server/config/paths')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

test('RUN-32 supplier UI exposes only the approved 11 business fields', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const modal = html.match(/<div id="supplier-modal"[\s\S]*?<div id="supplier-import-modal"/)?.[0] || '';
  const approvedIds = [
    'supplier-code', 'supplier-name', 'supplier-tax-code', 'supplier-address', 'supplier-region',
    'supplier-province', 'supplier-business-type', 'supplier-status', 'supplier-contact-name',
    'supplier-contact-email', 'supplier-contact-phone',
  ];
  approvedIds.forEach((id) => assert.match(modal, new RegExp(`id="${id}"`), id));
  assert.equal((modal.match(/id="supplier-[^"]+"/g) || []).filter((item) => approvedIds.some((id) => item === `id="${id}"`)).length, 11);
  DEPRECATED_COLUMNS.map((column) => `supplier-${column.replaceAll('_', '-')}`)
    .forEach((id) => assert.doesNotMatch(modal, new RegExp(`id="${id}"`), id));

  assert.doesNotMatch(html, /id="supplier-filter-mch[23]"/);
  assert.match(html, /supplier-master-table/);
  assert.match(html, /<th>Địa chỉ<\/th>/);
  assert.match(html, /<th>Loại hình kinh doanh<\/th>/);
  assert.doesNotMatch(html.match(/<section id="view-suppliers"[\s\S]*?<section id="view-admin"/)?.[0] || '', /<th>MCH[23]<\/th>|<th>Sản phẩm<\/th>/);
  assert.match(html, /#view-suppliers \.table-scroll \{ overflow-x: hidden; \}/);
  assert.match(app, /attrs: \{ title: row\.address \|\| '' \}/);
});

test('supplier master desktop columns keep every header readable without horizontal scrolling', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const expectedWidths = {
    index: 5,
    code: 9,
    name: 15,
    tax: 10,
    address: 16,
    region: 7,
    province: 9,
    business: 14,
    status: 8,
    actions: 7,
  };
  for (const [column, width] of Object.entries(expectedWidths)) {
    assert.match(html, new RegExp(`supplier-col-${column} \\{ width: ${width}%; \\}`));
  }
  assert.equal(Object.values(expectedWidths).reduce((total, width) => total + width, 0), 100);
  assert.match(html, /\.supplier-master-table th \{ padding-inline: 8px; letter-spacing: \.08em; font-size: 9px; \}/);
  for (const header of ['STT', 'Khu vực', 'Loại hình kinh doanh', 'Trạng thái', 'Thao tác']) {
    assert.match(html, new RegExp(`>\\s*${header}\\s*<`));
  }
});

test('RUN-32 runtime supplier SQL and report SQL no longer reference dropped master columns', () => {
  const supplierRuntime = [
    'server/routes/suppliers.js', 'server/repositories/SupplierRepository.js',
    'server/services/supplierImporter.js', 'server/domain/supplierHistory.js',
  ].map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  DEPRECATED_COLUMNS.forEach((column) => assert.doesNotMatch(supplierRuntime, new RegExp(`\\b${column}\\b`), column));

  const summaryExport = fs.readFileSync(path.join(ROOT, 'server/services/evaluationSummaryExport.js'), 'utf8');
  DEPRECATED_COLUMNS.forEach((column) => assert.doesNotMatch(summaryExport, new RegExp(`sm\\.${column}\\b`), `sm.${column}`));

  const ticketService = fs.readFileSync(path.join(ROOT, 'server/services/EvaluationTicketService.js'), 'utf8');
  ['production_address', 'evaluation_address', 'linked_facility_code', 'linked_facility_name',
    'linked_facility_address', 'linked_facility_type'].forEach((column) => {
    assert.doesNotMatch(ticketService, new RegExp(`supplier\\.${column}\\b`), `supplier.${column}`);
  });
});
