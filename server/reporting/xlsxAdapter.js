'use strict';

const XLSX = require('xlsx');

function semanticRows(semantic) {
  const rows = [];
  semantic.sections.forEach((section) => {
    if (section.type === 'page_break') {
      rows.push([], ['--- PAGE BREAK ---'], []);
      return;
    }
    if (section.type === 'spacer') {
      for (let index = 0; index < section.data; index += 1) rows.push([]);
      return;
    }
    if (section.type === 'header') {
      rows.push([section.data.title], [section.data.subtitle], []);
      return;
    }
    rows.push([section.title || section.type]);
    if (Array.isArray(section.warnings)) section.warnings.forEach((warning) => rows.push(['WARNING', warning]));
    if (section.chart?.enabled) rows.push(['chart_type', section.chart.type]);
    if (section.result) rows.push([section.result.title, section.result.grade, section.result.label]);
    if (section.elimination) rows.push([section.elimination.label, section.elimination.applied ? 'applied' : 'not applied']);
    if (section.legend?.items?.length) {
      rows.push([section.legend.label, ...section.legend.items.map((item) => `${item.code}: ${item.label}`)]);
    }
    if (Array.isArray(section.columns)) {
      rows.push(section.columns.map((column) => column.label), ...section.data);
    } else if (Array.isArray(section.data)) {
      rows.push(...section.data.map((field) => [field.label, field.value]));
    } else {
      rows.push([section.data]);
    }
    rows.push([]);
  });
  return rows;
}

function renderXlsx(semantic) {
  const workbook = XLSX.utils.book_new();
  const rows = semanticRows(semantic);
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 30 }, { wch: 42 }, { wch: 28 }, { wch: 28 }, { wch: 22 }, { wch: 18 }, { wch: 18 }];
  worksheet['!margins'] = { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
  worksheet['!pageSetup'] = { paperSize: 9, orientation: semantic.styles?.page_orientation || 'landscape', fitToWidth: 1, fitToHeight: 0 };
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');

  const mapping = XLSX.utils.aoa_to_sheet([
    ['definition_code', semantic.definition_code],
    ['component_schema_version', semantic.component_schema_version],
    ['semantic_checksum', semantic.checksum],
    [],
    ['order', 'component_id', 'component_type', 'title'],
    ...semantic.sections.map((section, index) => [index + 1, section.id, section.type, section.title]),
  ]);
  XLSX.utils.book_append_sheet(workbook, mapping, '_ComponentMap');
  workbook.Workbook = workbook.Workbook || {};
  workbook.Workbook.Sheets = workbook.Workbook.Sheets || [];
  workbook.Workbook.Sheets[1] = { Hidden: 1 };
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellDates: true });
}

module.exports = { renderXlsx, semanticRows };
