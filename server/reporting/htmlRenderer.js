'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTable(section) {
  const headers = (section.columns || []).map((column) => `<th>${escapeHtml(column.label)}</th>`).join('');
  const rows = (section.data || []).map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
  const table = `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
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

function renderHtml({ semantic, title = 'Report' }) {
  const body = semantic.sections.map(renderSection).join('\n');
  const orientation = semantic.styles?.page_orientation === 'landscape' ? 'landscape' : 'portrait';
  const fontScale = Number(semantic.styles?.font_scale || 1);
  const accent = /^#[a-f0-9]{6}$/i.test(String(semantic.styles?.accent_color || '')) ? semantic.styles.accent_color : '#111827';
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
@page{size:A4 ${orientation};margin:14mm}*{box-sizing:border-box}body{--report-accent:${accent};font-family:Arial,"Segoe UI",sans-serif;font-size:${fontScale}em;color:#111827;margin:0;line-height:1.45}main{max-width:1050px;margin:0 auto;padding:24px}header{text-align:center;border-bottom:2px solid var(--report-accent);margin-bottom:20px}h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:20px 0 8px;color:var(--report-accent)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:#d1d5db;border:1px solid #d1d5db}.grid>div{background:#fff;padding:7px}.grid dt{font-weight:700}.grid dd{margin:2px 0 0;white-space:pre-wrap}table{width:100%;border-collapse:collapse}th,td{border:1px solid #9ca3af;padding:6px;text-align:left;vertical-align:top}th{background:#f3f4f6}.text{white-space:pre-wrap;border:1px solid #d1d5db;padding:10px;min-height:44px}.page-break{break-before:page}.spacer{height:calc(var(--lines) * 1.45em)}@media(max-width:640px){main{padding:12px}.grid{grid-template-columns:1fr}table{font-size:12px}}@media print{main{max-width:none;padding:0}}
.report-warning{color:#92400e;background:#fffbeb;border:1px solid #f59e0b;padding:6px}.chart-row{display:grid;grid-template-columns:minmax(120px,1fr) 2fr 56px;gap:8px;align-items:center;margin:4px 0}.chart-row i{display:block;height:10px;background:linear-gradient(90deg,#2563eb var(--value),#e5e7eb var(--value))}.chart-row b{text-align:right;font-size:12px}
</style></head><body><main data-report-definition="${escapeHtml(semantic.definition_code)}" data-semantic-checksum="${escapeHtml(semantic.checksum)}" data-page-orientation="${orientation}">${body}</main></body></html>`;
}

module.exports = { escapeHtml, renderHtml };
