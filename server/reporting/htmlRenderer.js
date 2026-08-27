'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function columnMarkup(columns = []) {
  if (!columns.some((column) => column.width)) return '';
  return `<colgroup>${columns.map((column) => `<col${column.width ? ` style="width:${escapeHtml(column.width)}"` : ''}>`).join('')}</colgroup>`;
}

function renderTableElement(section, className = '') {
  const headers = (section.columns || []).map((column) => (
    `<th style="text-align:${escapeHtml(column.align || 'left')}" scope="col">${escapeHtml(column.label)}</th>`
  )).join('');
  const rows = (section.data || []).map((row) => `<tr>${row.map((cell, index) => (
    `<td style="text-align:${escapeHtml(section.columns?.[index]?.align || 'left')}">${escapeHtml(cell)}</td>`
  )).join('')}</tr>`).join('');
  const empty = rows || `<tr class="empty-row"><td colspan="${Math.max(1, section.columns?.length || 1)}"></td></tr>`;
  return `<table${className ? ` class="${escapeHtml(className)}"` : ''}>${columnMarkup(section.columns)}<thead><tr>${headers}</tr></thead><tbody>${empty}</tbody></table>`;
}

function renderTable(section) {
  const table = renderTableElement(section);
  const warnings = (section.warnings || []).map((warning) => `<p class="report-warning" role="status">${escapeHtml(warning)}</p>`).join('');
  const chart = section.chart?.enabled
    ? `<div class="compliance-chart" data-chart-type="${escapeHtml(section.chart.type)}" role="img" aria-label="${escapeHtml(section.title)}">${(section.chart.categories || []).map((category, index) => {
      const value = Number(section.chart.values?.[index]);
      const width = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
      return `<div class="chart-row"><span>${escapeHtml(category)}</span><i style="--value:${width}%"></i><b>${Number.isFinite(value) ? escapeHtml(value) + '%' : '—'}</b></div>`;
    }).join('')}</div>`
    : '';
  const legend = section.legend?.items?.length
    ? `<div class="compliance-legend"><b>${escapeHtml(section.legend.label)}</b><ul>${section.legend.items.map((item) => `<li><b>${escapeHtml(item.code)}</b> ${escapeHtml(item.label)}</li>`).join('')}</ul></div>`
    : '';
  const result = section.result
    ? `<p class="compliance-result"><strong>${escapeHtml(section.result.title)}</strong> <b>${escapeHtml(section.result.grade)}</b> ${escapeHtml(section.result.label)}</p>`
    : '';
  const elimination = section.elimination
    ? `<p class="compliance-elimination" data-applied="${section.elimination.applied ? 'true' : 'false'}">${escapeHtml(section.elimination.label)}: ${section.elimination.applied ? 'applied' : 'not applied'}</p>`
    : '';
  const layout = section.presentation?.layout || 'table_chart';
  const content = section.type !== 'compliance_overview'
    ? table
    : layout === 'chart_table'
      ? `${chart}${legend}${table}`
      : layout === 'table'
        ? `${table}${legend}`
        : `${table}${chart}${legend}`;
  return `<section data-component="${escapeHtml(section.type)}" data-component-id="${escapeHtml(section.id)}">
    <h2>${escapeHtml(section.title)}</h2>${warnings}${result}${elimination}${content}
  </section>`;
}

function renderSection(section) {
  if (section.type === 'header') {
    return `<header data-component="header" data-component-id="${escapeHtml(section.id)}"><h1>${escapeHtml(section.data.title)}</h1><p>${escapeHtml(section.data.subtitle)}</p></header>`;
  }
  if (['metadata_grid', 'scope_summary', 'signature_block'].includes(section.type)) {
    const cells = section.data.map((field) => `<div><dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd></div>`).join('');
    return `<section data-component="${escapeHtml(section.type)}" data-component-id="${escapeHtml(section.id)}"><h2>${escapeHtml(section.title)}</h2><dl class="grid">${cells}</dl></section>`;
  }
  if (['participants_table', 'compliance_overview', 'nonconformity_table', 'corrective_action_table', 'approval_history'].includes(section.type)) {
    return renderTable(section);
  }
  if (section.type === 'supplier_introduction' || section.type === 'text_block') {
    return `<section data-component="${escapeHtml(section.type)}" data-component-id="${escapeHtml(section.id)}"><h2>${escapeHtml(section.title)}</h2><div class="text">${escapeHtml(section.data)}</div></section>`;
  }
  if (section.type === 'page_break') return '<div class="page-break" data-component="page_break"></div>';
  if (section.type === 'spacer') return `<div class="spacer" data-component="spacer" style="--lines:${Number(section.data) || 1}"></div>`;
  return '';
}

function sectionHeading(section) {
  return section.title ? `<h2 class="report-section-heading">${escapeHtml(section.title)}</h2>` : '';
}

function renderWinCommerceHeader(section) {
  const meta = section.data.meta || [];
  return `<header class="wc-report-header" data-component="header" data-component-id="${escapeHtml(section.id)}">
    <div class="wc-heading-row">
      <div class="wc-brand" aria-label="WinCommerce"><span class="wc-win">Win</span><span class="wc-commerce">Commerce</span></div>
      <h1>${escapeHtml(section.data.title)}</h1>
      <div aria-hidden="true"></div>
    </div>
    <dl class="wc-top-meta">${meta.map((field, index) => `<div class="${index === meta.length - 1 ? 'right' : ''}"><dt>${escapeHtml(field.label)}:</dt><dd>${escapeHtml(field.value)}</dd></div>`).join('')}</dl>
  </header>`;
}

function renderWinCommerceFields(section) {
  if (section.type === 'signature_block' && section.display_mode === 'manual_blank') {
    return `<section class="wc-signatures" data-component="signature_block" data-component-id="${escapeHtml(section.id)}">${section.data.map((field) => `<div><strong>${escapeHtml(field.label)}</strong></div>`).join('')}</section>`;
  }
  const fields = section.data.map((field) => `<div><dt>${escapeHtml(field.label)}</dt><dd><span>:</span>${escapeHtml(field.value)}</dd></div>`).join('');
  return `<section class="wc-section wc-field-section" data-component="${escapeHtml(section.type)}" data-component-id="${escapeHtml(section.id)}">${section.show_title === false ? '' : sectionHeading(section)}<dl class="wc-field-list">${fields}</dl></section>`;
}

function renderWinCommerceTable(section) {
  return `<section class="wc-section wc-table-section" data-component="${escapeHtml(section.type)}" data-component-id="${escapeHtml(section.id)}">${sectionHeading(section)}${renderTableElement(section, `wc-table wc-${section.type}`)}</section>`;
}

function renderWinCommerceFinalTable(section, signatures) {
  const columns = section.columns || [];
  const headers = columns.map((column) => (
    `<th style="text-align:${escapeHtml(column.align || 'left')}" scope="col">${escapeHtml(column.label)}</th>`
  )).join('');
  const rows = section.data || [];
  const renderRows = (items) => items.map((row) => `<tr>${row.map((cell, index) => (
    `<td style="text-align:${escapeHtml(columns[index]?.align || 'left')}">${escapeHtml(cell)}</td>`
  )).join('')}</tr>`).join('');
  const leadingRows = renderRows(rows.slice(0, -1));
  const finalRows = rows.length
    ? renderRows(rows.slice(-1))
    : `<tr class="empty-row"><td colspan="${Math.max(1, columns.length)}"></td></tr>`;
  return `<section class="wc-section wc-table-section wc-report-tail" data-component="${escapeHtml(section.type)}" data-component-id="${escapeHtml(section.id)}">
    ${sectionHeading(section)}
    <table class="wc-table wc-${escapeHtml(section.type)}">${columnMarkup(columns)}<thead><tr>${headers}</tr></thead>
      ${leadingRows ? `<tbody>${leadingRows}</tbody>` : ''}
      <tbody class="wc-table-signature-tail">${finalRows}<tr class="wc-signature-row"><td colspan="${Math.max(1, columns.length)}">${renderWinCommerceFields(signatures)}</td></tr></tbody>
    </table>
  </section>`;
}

function renderWinCommerceSection(section) {
  if (section.type === 'header') return renderWinCommerceHeader(section);
  if (['metadata_grid', 'scope_summary', 'signature_block'].includes(section.type)) return renderWinCommerceFields(section);
  if (['participants_table', 'compliance_overview', 'nonconformity_table', 'corrective_action_table', 'approval_history'].includes(section.type)) {
    return renderWinCommerceTable(section);
  }
  if (section.type === 'supplier_introduction' || section.type === 'text_block') {
    return `<section class="wc-section wc-text-section" data-component="${escapeHtml(section.type)}" data-component-id="${escapeHtml(section.id)}">${sectionHeading(section)}<div class="wc-text">${escapeHtml(section.data)}</div></section>`;
  }
  if (section.type === 'page_break') return '<div class="page-break" data-component="page_break"></div>';
  if (section.type === 'spacer') return `<div class="spacer" data-component="spacer" style="--lines:${Number(section.data) || 1}"></div>`;
  return '';
}

const BASE_CSS = `
@page{size:A4 var(--page-orientation);margin:14mm}*{box-sizing:border-box}body{--report-accent:var(--accent);font-family:Arial,"Segoe UI",sans-serif;font-size:var(--font-scale);color:#111827;margin:0;line-height:1.45}main{max-width:1050px;margin:0 auto;padding:24px}header{text-align:center;border-bottom:2px solid var(--report-accent);margin-bottom:20px}h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:20px 0 8px;color:var(--report-accent)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:#d1d5db;border:1px solid #d1d5db}.grid>div{background:#fff;padding:7px}.grid dt{font-weight:700}.grid dd{margin:2px 0 0;white-space:pre-wrap}table{width:100%;border-collapse:collapse}th,td{border:1px solid #9ca3af;padding:6px;text-align:left;vertical-align:top}th{background:#f3f4f6}.text{white-space:pre-wrap;border:1px solid #d1d5db;padding:10px;min-height:44px}.page-break{break-before:page}.spacer{height:calc(var(--lines) * 1.45em)}@media(max-width:640px){main{padding:12px}.grid{grid-template-columns:1fr}table{font-size:12px}}@media print{main{max-width:none;padding:0}}
.report-warning{color:#92400e;background:#fffbeb;border:1px solid #f59e0b;padding:6px}.chart-row{display:grid;grid-template-columns:minmax(120px,1fr) 2fr 56px;gap:8px;align-items:center;margin:4px 0}.chart-row i{display:block;height:10px;background:linear-gradient(90deg,#2563eb var(--value),#e5e7eb var(--value))}.chart-row b{text-align:right;font-size:12px}`;

const WINCOMMERCE_CSS = `
@page{size:A4 portrait;margin:11mm 13mm 13mm}html,body{width:100%;min-height:100%}body{font-family:Arial,"Segoe UI",sans-serif;font-size:13.5px;line-height:1.35;color:#111;margin:0;background:#fff}main.wc-report{max-width:none;margin:0;padding:0}.wc-report-header{margin:0 0 22px;border:0;text-align:initial}.wc-heading-row{display:grid;grid-template-columns:180px minmax(0,1fr) 180px;align-items:center;min-height:72px}.wc-heading-row h1{margin:0;font-size:24px;line-height:1.16;text-align:center;font-weight:800;color:#111;text-transform:uppercase}.wc-brand{display:flex;align-items:baseline;white-space:nowrap;letter-spacing:-1px}.wc-win{font-size:29px;line-height:1;font-weight:850;color:#ed1c24}.wc-commerce{font-size:23px;line-height:1;font-weight:700;color:#c79033}.wc-top-meta{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:14px 0 0;padding:0 0 14px;border-bottom:1px solid #111}.wc-top-meta>div{display:flex;align-items:flex-end;gap:8px;min-width:0}.wc-top-meta>div.right{justify-content:flex-end}.wc-top-meta dt{font-weight:700;white-space:nowrap}.wc-top-meta dd{min-width:150px;margin:0;padding:0 4px 2px;border-bottom:1px dotted #111;text-align:center;white-space:nowrap}.wc-section{margin:0 0 18px}.report-section-heading{margin:0 0 8px;color:#111;font-size:16px;line-height:1.25;font-weight:750;break-after:avoid-page;page-break-after:avoid}.wc-field-list{display:grid;gap:7px;margin:0}.wc-field-list>div{display:grid;grid-template-columns:210px minmax(0,1fr);align-items:baseline}.wc-field-list dt{font-weight:700}.wc-field-list dd{display:grid;grid-template-columns:14px minmax(0,1fr);gap:0;margin:0;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.wc-text{white-space:pre-wrap;overflow-wrap:anywhere}.wc-table{width:100%;border-collapse:collapse;table-layout:fixed}.wc-table thead{display:table-header-group}.wc-table tfoot{display:table-footer-group}.wc-table tr{break-inside:avoid-page;page-break-inside:avoid}.wc-table th,.wc-table td{border:1px solid #555;padding:7px 8px;vertical-align:top;overflow-wrap:anywhere}.wc-table th{background:#fff;color:#111;font-weight:750;vertical-align:middle}.wc-table .empty-row td{height:42px}.wc-participants_table th,.wc-participants_table td{vertical-align:middle}.wc-participants_table td:not(:first-child){text-align:center}.wc-compliance_overview th:not(:first-child),.wc-compliance_overview td:not(:first-child){text-align:center}.wc-table-signature-tail{break-inside:avoid-page;page-break-inside:avoid}.wc-signature-row>td{border:0;padding:12px 0 0}.wc-signatures{display:grid;grid-template-columns:1fr 1fr;min-height:112px;margin-top:4px;text-align:center;break-before:avoid-page;page-break-before:avoid;break-inside:avoid-page;page-break-inside:avoid}.wc-signatures>div{padding:2px 14px}.wc-signatures strong{display:block;font-size:15px}.page-break{break-before:page}.spacer{height:calc(var(--lines) * 1.35em)}p,li,.wc-text{orphans:3;widows:3}@media print{body{font-size:13px}.wc-heading-row{grid-template-columns:165px minmax(0,1fr) 165px}.wc-heading-row h1{font-size:23px}.wc-section{margin-bottom:16px}.report-section-heading{break-after:avoid-page;page-break-after:avoid}.wc-table thead{display:table-header-group}.wc-table tr{break-inside:avoid-page;page-break-inside:avoid}.wc-table-signature-tail{break-inside:avoid-page;page-break-inside:avoid}.wc-signatures{break-before:avoid-page;page-break-before:avoid;break-inside:avoid-page;page-break-inside:avoid}}`;

function renderWinCommerceBody(sections) {
  const signatureIndex = sections.findIndex((section) => section.type === 'signature_block');
  const hasTailTable = signatureIndex > 0 && sections[signatureIndex - 1]?.type === 'nonconformity_table';
  if (!hasTailTable) return sections.map(renderWinCommerceSection).join('\n');
  const beforeTail = sections.slice(0, signatureIndex - 1).map(renderWinCommerceSection).join('\n');
  const tail = renderWinCommerceFinalTable(sections[signatureIndex - 1], sections[signatureIndex]);
  const afterTail = sections.slice(signatureIndex + 1).map(renderWinCommerceSection).join('\n');
  return `${beforeTail}\n${tail}\n${afterTail}`;
}

function renderHtml({ semantic, title = 'Report' }) {
  const orientation = semantic.styles?.page_orientation === 'landscape' ? 'landscape' : 'portrait';
  const fontScale = Number(semantic.styles?.font_scale || 1);
  const accent = /^#[a-f0-9]{6}$/i.test(String(semantic.styles?.accent_color || '')) ? semantic.styles.accent_color : '#111827';
  const profile = semantic.styles?.report_profile || '';
  const winCommerce = profile === 'wincommerce_supplier_assessment';
  const body = winCommerce
    ? renderWinCommerceBody(semantic.sections)
    : semantic.sections.map(renderSection).join('\n');
  const css = winCommerce ? WINCOMMERCE_CSS : BASE_CSS;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>:root{--page-orientation:${orientation};--font-scale:${fontScale}em;--accent:${accent};--report-accent:${accent}}${css}</style></head><body><main class="${winCommerce ? 'wc-report' : ''}" data-report-definition="${escapeHtml(semantic.definition_code)}" data-semantic-checksum="${escapeHtml(semantic.checksum)}" data-page-orientation="${orientation}" data-report-profile="${escapeHtml(profile)}">${body}</main></body></html>`;
}

module.exports = { escapeHtml, renderHtml };
