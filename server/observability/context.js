const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

const requestStorage = new AsyncLocalStorage();

function runWithContext(context, callback) {
  return requestStorage.run(context, callback);
}

function getContext() {
  return requestStorage.getStore() || {};
}

function updateContext(values) {
  const context = requestStorage.getStore();
  if (context && values && typeof values === 'object') Object.assign(context, values);
  return context;
}

function actorContext(user) {
  if (!user) return null;
  const stableIdentity = String(user.id || user.email || user.sub || 'unknown').trim().toLowerCase();
  return {
    id_hash: crypto.createHash('sha256').update(stableIdentity).digest('hex').slice(0, 16),
    role: user.primaryRoleCode || user.roleCodes?.[0] || null,
    is_admin: Array.isArray(user.roleCodes) && user.roleCodes.includes('SYS_ADMIN'),
  };
}

function setActor(user) {
  const actor = actorContext(user);
  updateContext({ actor });
  return actor;
}

module.exports = {
  actorContext,
  getContext,
  requestStorage,
  runWithContext,
  setActor,
  updateContext,
};
