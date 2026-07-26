'use strict';

const { getDefinition } = require('./definitionCatalog');
const { validateComponentTree } = require('./componentRegistry');
const { checksum, reportError } = require('./reportUtils');

const PACKAGE_SCHEMA_VERSION = 1;
const PACKAGE_TYPE = 'QLCL_REPORT_DEFINITION';
const CONFLICT_STRATEGIES = Object.freeze(['CREATE_DRAFT', 'USE_TARGET_CODE']);

function createDefinitionPackage(version) {
  const definition = validateComponentTree(JSON.parse(version.definition_json));
  const digest = checksum(definition);
  return {
    manifest: {
      package_type: PACKAGE_TYPE,
      package_schema_version: PACKAGE_SCHEMA_VERSION,
      definition_code: version.definition_code,
      component_schema_version: Number(definition.schema_version),
      source_version_no: Number(version.version_no),
      source_status: version.status,
      checksum: digest,
    },
    definition,
    style: definition.styles || {},
  };
}

function validateDefinitionPackage(input, { targetDefinitionCode, conflictStrategy = 'CREATE_DRAFT' } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw reportError('report_definition_package_invalid');
  const allowedTopLevel = new Set(['manifest', 'definition', 'style']);
  if (Object.keys(input).some((key) => !allowedTopLevel.has(key))) throw reportError('report_definition_package_contains_data');
  const manifest = input.manifest;
  if (!manifest || manifest.package_type !== PACKAGE_TYPE
      || Number(manifest.package_schema_version) !== PACKAGE_SCHEMA_VERSION) {
    throw reportError('report_definition_package_invalid');
  }
  const sourceCode = String(manifest.definition_code || '').trim().toUpperCase();
  const targetCode = String(targetDefinitionCode || sourceCode).trim().toUpperCase();
  getDefinition(sourceCode);
  getDefinition(targetCode);
  const strategy = String(conflictStrategy || '').trim().toUpperCase();
  if (!CONFLICT_STRATEGIES.includes(strategy)) throw reportError('report_definition_package_conflict_strategy_invalid');
  if (sourceCode !== targetCode && strategy !== 'USE_TARGET_CODE') {
    throw reportError('report_definition_package_code_conflict', 409, { source_code: sourceCode, target_code: targetCode });
  }
  const candidate = {
    ...(input.definition || {}),
    styles: input.style && Object.keys(input.style).length ? input.style : input.definition?.styles,
  };
  const definition = validateComponentTree(candidate);
  const actualChecksum = checksum(definition);
  if (String(manifest.checksum || '') !== actualChecksum) {
    throw reportError('report_definition_package_checksum_mismatch', 409);
  }
  return { definition, sourceCode, targetCode, conflictStrategy: strategy, checksum: actualChecksum };
}

module.exports = {
  CONFLICT_STRATEGIES,
  PACKAGE_SCHEMA_VERSION,
  PACKAGE_TYPE,
  createDefinitionPackage,
  validateDefinitionPackage,
};
