'use strict';

const { reportError } = require('./reportUtils');

const CURRENT_COMPONENT_SCHEMA_VERSION = 1;

function migrateComponentTree(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw reportError('report_template_definition_invalid');
  }
  let tree = JSON.parse(JSON.stringify(input));
  if (tree.schema_version == null && Array.isArray(tree.blocks)) {
    tree = { schema_version: 1, components: tree.blocks };
  }
  if (Number(tree.schema_version) !== CURRENT_COMPONENT_SCHEMA_VERSION) {
    throw reportError('report_component_schema_unsupported', 409, {
      schema_version: tree.schema_version,
      current_schema_version: CURRENT_COMPONENT_SCHEMA_VERSION,
    });
  }
  return tree;
}

module.exports = { CURRENT_COMPONENT_SCHEMA_VERSION, migrateComponentTree };
