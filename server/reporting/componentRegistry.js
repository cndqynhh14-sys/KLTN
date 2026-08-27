'use strict';

const { migrateComponentTree } = require('./schemaMigrations');
const { checksum, reportError } = require('./reportUtils');

const COMPONENT_TYPES = Object.freeze([
  'header', 'metadata_grid', 'scope_summary', 'participants_table',
  'supplier_introduction', 'compliance_overview', 'nonconformity_table',
  'corrective_action_table', 'approval_history', 'signature_block',
  'text_block', 'page_break', 'spacer',
]);

const FIELD_COMPONENTS = new Set(['metadata_grid', 'scope_summary', 'signature_block']);
const TABLE_COMPONENTS = new Set([
  'participants_table', 'compliance_overview', 'nonconformity_table',
  'corrective_action_table', 'approval_history',
]);
const ALLOWED_BINDINGS = new Set([
  'doc4.related_information.report_no',
  'doc4.related_information.evaluation_date',
  'doc4.related_information.evaluators',
  'doc4.related_information.supplier_name',
  'doc4.related_information.supplier_code',
  'doc4.related_information.evaluation_address',
  'doc4.scope.product',
  'doc4.scope.business_type',
  'doc4.scope.evaluation_type',
  'doc4.scope.question_template_version_id',
  'doc4.participants.rows',
  'doc4.supplier_introduction.content',
  'doc4.compliance_summary',
  'doc4.nonconformity_summary',
  'doc4.result_summary.final_score_percent',
  'doc4.result_summary.final_result_label',
  'doc4.result_summary.final_conclusion',
  'doc4.signatures.evaluator',
  'doc4.signatures.supplier_representative',
  'doc4.signatures.approved_by',
  'corrective_action_rows',
  'approval_history_rows',
]);
const UNSAFE_TEXT = /<\s*\/?\s*(?:script|iframe|object|embed|style)\b|javascript\s*:|\bon[a-z]+\s*=/i;
const UNSAFE_KEY = /^(?:html|raw_html|unsafe_html|script|style|on[a-z]+)$/i;
const PAGE_ORIENTATIONS = new Set(['portrait', 'landscape']);
const OVERVIEW_LAYOUTS = new Set(['table', 'table_chart', 'chart_table']);
const OVERVIEW_CATEGORY_MODES = new Set(['all', 'summary']);
const FIELD_LAYOUTS = new Set(['grid', 'stacked']);
const SIGNATURE_DISPLAY_MODES = new Set(['values', 'manual_blank']);
const FIELD_FORMATS = new Set(['date_ddmmyyyy']);
const COLUMN_ALIGNS = new Set(['left', 'center', 'right']);
const REPORT_PROFILES = new Set(['wincommerce_supplier_assessment']);

function atPath(value, path) {
  return String(path || '').split('.').filter(Boolean).reduce((current, key) => (
    current == null ? undefined : current[key]
  ), value);
}

function assertSafe(value, path = 'definition') {
  if (typeof value === 'string' && UNSAFE_TEXT.test(value)) {
    throw reportError('unsafe_report_template', 400, { path });
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_KEY.test(key)) throw reportError('unsafe_report_template', 400, { path: `${path}.${key}` });
    assertSafe(child, `${path}.${key}`);
  }
}

function validateBinding(binding, path) {
  if (!ALLOWED_BINDINGS.has(String(binding || ''))) {
    throw reportError('report_binding_not_allowed', 400, { path, binding });
  }
}

function validateColumns(columns, path) {
  if (!Array.isArray(columns) || !columns.length) throw reportError('report_component_properties_invalid', 400, { path });
  columns.forEach((column, index) => {
    if (!column || typeof column !== 'object' || !String(column.label || '').trim()
      || !/^[a-z][a-z0-9_.]*$/i.test(String(column.key || ''))
      || Object.keys(column).some((key) => !['label', 'key', 'width', 'align', 'format'].includes(key))) {
      throw reportError('report_component_properties_invalid', 400, { path: `${path}.${index}` });
    }
    if (column.width != null && !/^\d+(?:\.\d+)?%$/.test(String(column.width))) {
      throw reportError('report_component_properties_invalid', 400, { path: `${path}.${index}.width` });
    }
    if (column.align != null && !COLUMN_ALIGNS.has(String(column.align))) {
      throw reportError('report_component_properties_invalid', 400, { path: `${path}.${index}.align` });
    }
    if (column.format != null && !FIELD_FORMATS.has(String(column.format))) {
      throw reportError('report_component_properties_invalid', 400, { path: `${path}.${index}.format` });
    }
  });
}

function validateFields(fields, path) {
  if (!Array.isArray(fields) || !fields.length) throw reportError('report_component_properties_invalid', 400, { path });
  fields.forEach((field, index) => {
    if (!field || typeof field !== 'object' || !String(field.label || '').trim()
      || Object.keys(field).some((key) => !['label', 'binding', 'format'].includes(key))) {
      throw reportError('report_component_properties_invalid', 400, { path: `${path}.${index}` });
    }
    validateBinding(field.binding, `${path}.${index}.binding`);
    if (field.format != null && !FIELD_FORMATS.has(String(field.format))) {
      throw reportError('report_component_properties_invalid', 400, { path: `${path}.${index}.format` });
    }
  });
}

function validateStyles(styles) {
  if (styles == null) return {};
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)
      || Object.keys(styles).some((key) => !['page_orientation', 'font_scale', 'accent_color', 'report_profile'].includes(key))) {
    throw reportError('report_template_styles_invalid', 400, { path: 'styles' });
  }
  const normalized = {};
  if (styles.page_orientation != null) {
    const orientation = String(styles.page_orientation);
    if (!PAGE_ORIENTATIONS.has(orientation)) throw reportError('report_template_styles_invalid', 400, { path: 'styles.page_orientation' });
    normalized.page_orientation = orientation;
  }
  if (styles.font_scale != null) {
    const scale = Number(styles.font_scale);
    if (!Number.isFinite(scale) || scale < 0.8 || scale > 1.3) throw reportError('report_template_styles_invalid', 400, { path: 'styles.font_scale' });
    normalized.font_scale = scale;
  }
  if (styles.accent_color != null) {
    const color = String(styles.accent_color).toLowerCase();
    if (!/^#[a-f0-9]{6}$/.test(color)) throw reportError('report_template_styles_invalid', 400, { path: 'styles.accent_color' });
    normalized.accent_color = color;
  }
  if (styles.report_profile != null) {
    const profile = String(styles.report_profile);
    if (!REPORT_PROFILES.has(profile)) throw reportError('report_template_styles_invalid', 400, { path: 'styles.report_profile' });
    normalized.report_profile = profile;
  }
  return normalized;
}

function validateOverviewPresentation(value, path) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !['layout', 'category_mode', 'show_chart', 'show_legend'].includes(key))) {
    throw reportError('report_component_properties_invalid', 400, { path });
  }
  const presentation = {};
  if (value.layout != null) {
    if (!OVERVIEW_LAYOUTS.has(String(value.layout))) throw reportError('report_component_properties_invalid', 400, { path });
    presentation.layout = String(value.layout);
  }
  if (value.category_mode != null) {
    if (!OVERVIEW_CATEGORY_MODES.has(String(value.category_mode))) throw reportError('report_component_properties_invalid', 400, { path });
    presentation.category_mode = String(value.category_mode);
  }
  for (const key of ['show_chart', 'show_legend']) {
    if (value[key] != null && typeof value[key] !== 'boolean') throw reportError('report_component_properties_invalid', 400, { path });
    if (value[key] != null) presentation[key] = value[key];
  }
  return presentation;
}

function validateComponentTree(input) {
  const tree = migrateComponentTree(input);
  assertSafe(tree);
  if (Object.keys(tree).some((key) => !['schema_version', 'components', 'styles'].includes(key))) {
    throw reportError('report_template_definition_invalid', 400, { path: 'definition' });
  }
  tree.styles = validateStyles(tree.styles);
  if (!Array.isArray(tree.components) || !tree.components.length) {
    throw reportError('report_components_required', 400, { path: 'components' });
  }
  const ids = new Set();
  tree.components.forEach((component, index) => {
    const path = `components.${index}`;
    if (!component || typeof component !== 'object' || !COMPONENT_TYPES.includes(component.type)) {
      throw reportError('report_component_unknown', 400, { path, type: component?.type });
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(component.id || '')) || ids.has(component.id)) {
      throw reportError('report_component_id_invalid', 400, { path });
    }
    ids.add(component.id);
    const allowedProperties = new Set(['id', 'type', 'title']);
    if (component.type === 'header') {
      allowedProperties.add('subtitle_binding');
      allowedProperties.add('meta_fields');
    }
    if (FIELD_COMPONENTS.has(component.type)) {
      allowedProperties.add('fields');
      allowedProperties.add('layout');
    }
    if (component.type === 'signature_block') {
      allowedProperties.add('display_mode');
      allowedProperties.add('show_title');
    }
    if (TABLE_COMPONENTS.has(component.type)) {
      allowedProperties.add('binding');
      allowedProperties.add('columns');
    }
    if (component.type === 'compliance_overview') allowedProperties.add('presentation');
    if (component.type === 'supplier_introduction') allowedProperties.add('binding');
    if (component.type === 'text_block') {
      allowedProperties.add('binding');
      allowedProperties.add('text');
    }
    if (component.type === 'spacer') allowedProperties.add('lines');
    if (Object.keys(component).some((key) => !allowedProperties.has(key))) {
      throw reportError('report_component_properties_invalid', 400, { path });
    }
    if (component.binding != null) validateBinding(component.binding, `${path}.binding`);
    if (component.subtitle_binding != null) validateBinding(component.subtitle_binding, `${path}.subtitle_binding`);
    if (component.meta_fields != null) validateFields(component.meta_fields, `${path}.meta_fields`);
    if (FIELD_COMPONENTS.has(component.type)) validateFields(component.fields, `${path}.fields`);
    if (component.layout != null && !FIELD_LAYOUTS.has(String(component.layout))) {
      throw reportError('report_component_properties_invalid', 400, { path: `${path}.layout` });
    }
    if (component.display_mode != null && !SIGNATURE_DISPLAY_MODES.has(String(component.display_mode))) {
      throw reportError('report_component_properties_invalid', 400, { path: `${path}.display_mode` });
    }
    if (component.show_title != null && typeof component.show_title !== 'boolean') {
      throw reportError('report_component_properties_invalid', 400, { path: `${path}.show_title` });
    }
    if (TABLE_COMPONENTS.has(component.type)) {
      validateBinding(component.binding, `${path}.binding`);
      validateColumns(component.columns, `${path}.columns`);
    }
    if (component.type === 'compliance_overview') {
      const presentation = validateOverviewPresentation(component.presentation, `${path}.presentation`);
      if (presentation) component.presentation = presentation;
    }
    if (component.type === 'header' && !String(component.title || '').trim()) {
      throw reportError('report_component_properties_invalid', 400, { path });
    }
    if (component.type === 'text_block' && component.text == null && component.binding == null) {
      throw reportError('report_component_properties_invalid', 400, { path });
    }
  });
  return tree;
}

function normalizeCell(value) {
  if (value === true) return '✓';
  if (value === false || value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatCell(value, format) {
  if (format !== 'date_ddmmyyyy' || value == null || value === '') return normalizeCell(value);
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : normalizeCell(value);
}

function buildSemanticModel(input, context) {
  const tree = validateComponentTree(input);
  const sections = tree.components.map((component) => {
    const section = { id: component.id, type: component.type, title: String(component.title || '') };
    if (component.type === 'header') {
      section.data = {
        title: component.title,
        subtitle: normalizeCell(component.subtitle_binding ? atPath(context, component.subtitle_binding) : ''),
        meta: (component.meta_fields || []).map((field) => ({
          label: field.label,
          value: formatCell(atPath(context, field.binding), field.format),
        })),
      };
    } else if (FIELD_COMPONENTS.has(component.type)) {
      section.layout = component.layout || 'grid';
      section.display_mode = component.display_mode || 'values';
      section.show_title = component.show_title !== false;
      section.data = component.fields.map((field) => ({
        label: field.label,
        value: formatCell(atPath(context, field.binding), field.format),
      }));
    } else if (TABLE_COMPONENTS.has(component.type)) {
      const policyOverview = component.type === 'compliance_overview' ? context.compliance_overview : null;
      const rows = policyOverview
        ? [...policyOverview.rows, ...(policyOverview.totals ? [policyOverview.totals] : [])]
        : atPath(context, component.binding);
      if (!Array.isArray(rows)) throw reportError('report_binding_value_invalid', 422, { binding: component.binding });
      const columns = policyOverview ? policyOverview.columns : component.columns;
      if (policyOverview) section.title = policyOverview.title;
      section.columns = columns.map((column) => ({
        label: column.label,
        key: column.key,
        width: column.width || null,
        align: column.align || 'left',
      }));
      section.data = rows.map((row) => columns.map((column) => formatCell(atPath(row, column.key), column.format)));
      if (policyOverview) {
        const presentation = component.presentation || {};
        section.presentation = {
          layout: presentation.layout || 'table_chart',
          category_mode: presentation.category_mode || 'all',
        };
        section.chart = presentation.show_chart === false || section.presentation.layout === 'table'
          ? { ...policyOverview.chart, enabled: false }
          : policyOverview.chart;
        section.legend = presentation.show_legend === false ? null : policyOverview.legend;
        section.elimination = policyOverview.elimination;
        section.result = policyOverview.result;
        section.warnings = policyOverview.warnings;
        section.totals = policyOverview.totals;
      }
    } else if (component.type === 'supplier_introduction' || component.type === 'text_block') {
      section.data = normalizeCell(component.binding ? atPath(context, component.binding) : component.text);
    } else if (component.type === 'spacer') {
      section.data = Math.max(1, Math.min(12, Number(component.lines || 1)));
    } else {
      section.data = null;
    }
    return section;
  });
  return {
    component_schema_version: tree.schema_version,
    definition_code: context.definition_code,
    styles: tree.styles || {},
    sections,
    checksum: checksum({ definition_code: context.definition_code, styles: tree.styles || {}, sections }),
  };
}

module.exports = {
  ALLOWED_BINDINGS,
  COMPONENT_TYPES,
  buildSemanticModel,
  validateComponentTree,
};
