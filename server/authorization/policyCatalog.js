'use strict';

const { PERMISSIONS } = require('./permissionCatalog');
const {
  NAVIGATION_VERSION,
  NAVIGATION_MANIFEST,
} = require('../../public/js/navigation-manifest');
const { ACTION_VERSION } = require('../../public/js/action-registry');

const POLICY_VERSION = 2;

const APPROVAL_PERMISSION_BY_LEVEL = Object.freeze({
  LEAD: PERMISSIONS.EVALUATION_APPROVE_LEAD,
  TBP: PERMISSIONS.EVALUATION_APPROVE_TBP,
  GDK: PERMISSIONS.EVALUATION_APPROVE_GDK,
});

const navigationPermissions = (id) => {
  const item = NAVIGATION_MANIFEST.find((candidate) => candidate.id === id);
  return item ? [...item.permissions] : [];
};

// Compatibility export for policy consumers. Values are derived from the RUN-11
// manifest so route labels, ordering and permission requirements have one source.
const NAVIGATION_CAPABILITIES = Object.freeze({
  overview: navigationPermissions('overview')[0],
  evaluations: navigationPermissions('evaluations')[0],
  evaluation_create: navigationPermissions('evaluation-new')[0],
  scoring: navigationPermissions('scoring')[0],
  approvals: Object.freeze(navigationPermissions('approvals')),
  suppliers: navigationPermissions('suppliers')[0],
  admin: navigationPermissions('admin-users')[0],
});

module.exports = {
  POLICY_VERSION,
  NAVIGATION_VERSION,
  ACTION_VERSION,
  APPROVAL_PERMISSION_BY_LEVEL,
  NAVIGATION_CAPABILITIES,
};
