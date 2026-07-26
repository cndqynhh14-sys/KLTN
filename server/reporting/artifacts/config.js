'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { artifactError } = require('./artifactSecurity');
const { LocalArtifactStorage } = require('./LocalArtifactStorage');
const { ObjectArtifactStorage } = require('./ObjectArtifactStorage');

const PRODUCTION_ENABLE_ACK = 'REPORT-001-APPROVED';
const LOCAL_VOLUME_ACK = 'REPORT-001:APPROVED_PERSISTENT_VOLUME';
const WORKER_ACK = 'REPORT-001:WORKER_DEPLOYED';

function durableExportsEnabled(env = process.env) {
  return env.NODE_ENV === 'production'
    ? env.REPORT_DURABLE_EXPORTS_ENABLED === PRODUCTION_ENABLE_ACK
    : env.REPORT_DURABLE_EXPORTS_ENABLED !== '0';
}

function reportArtifactReadiness(env = process.env, options = {}) {
  if (!durableExportsEnabled(env)) {
    return { status: 'disabled', code: 'report_artifact_storage_disabled', mode: 'off' };
  }
  const production = env.NODE_ENV === 'production';
  const mode = String(env.REPORT_STORAGE_MODE || (production ? 'off' : 'local')).toLowerCase();
  if (!['local', 'object'].includes(mode)) {
    return { status: 'degraded', code: 'report_storage_mode_invalid', mode };
  }
  if (mode === 'local') {
    if (production && env.REPORT_LOCAL_VOLUME_APPROVAL !== LOCAL_VOLUME_ACK) {
      return { status: 'degraded', code: 'report_local_volume_not_approved', mode };
    }
    if (production && (!env.REPORT_STORAGE_ROOT || !path.isAbsolute(env.REPORT_STORAGE_ROOT))) {
      return { status: 'degraded', code: 'report_storage_root_invalid', mode };
    }
  }
  if (mode === 'object') {
    if (env.REPORT_OBJECT_STORAGE_ENABLED !== '1') {
      return { status: 'degraded', code: 'report_object_storage_disabled', mode };
    }
    if (!env.REPORT_OBJECT_STORAGE_BUCKET) {
      return { status: 'degraded', code: 'report_object_bucket_missing', mode };
    }
    if (!options.objectClient) {
      return { status: 'degraded', code: 'report_object_adapter_unavailable', mode };
    }
  }
  const executionMode = String(env.REPORT_EXPORT_EXECUTION_MODE || (production ? 'worker' : 'inline')).toLowerCase();
  if (!['inline', 'worker'].includes(executionMode)) {
    return { status: 'degraded', code: 'report_execution_mode_invalid', mode, execution_mode: executionMode };
  }
  if (production && executionMode !== 'worker') {
    return { status: 'degraded', code: 'report_worker_required', mode, execution_mode: executionMode };
  }
  if (production && env.REPORT_EXPORT_WORKER_ENABLED !== WORKER_ACK) {
    return { status: 'degraded', code: 'report_worker_not_deployed', mode, execution_mode: executionMode };
  }
  return { status: 'ready', code: 'report_artifact_storage_ready', mode, execution_mode: executionMode };
}

function defaultStorageRoot(db, env = process.env) {
  if (env.REPORT_STORAGE_ROOT) return path.resolve(env.REPORT_STORAGE_ROOT);
  const dbName = db?.name;
  if (dbName && dbName !== ':memory:') return path.resolve(`${dbName}.report-artifacts`);
  return path.resolve(process.cwd(), 'data', 'report-artifacts');
}

function createArtifactStorage({ db, env = process.env, objectClient = null } = {}) {
  const readiness = reportArtifactReadiness(env, { objectClient });
  if (readiness.status !== 'ready') throw artifactError(readiness.code, 503);
  if (readiness.mode === 'local') return new LocalArtifactStorage({ root: defaultStorageRoot(db, env) });
  return new ObjectArtifactStorage({ client: objectClient, bucket: env.REPORT_OBJECT_STORAGE_BUCKET });
}

function reportArtifactRuntimeReadiness({ db, env = process.env, objectClient = null } = {}) {
  const configured = reportArtifactReadiness(env, { objectClient });
  if (configured.status !== 'ready') return configured;
  try {
    const storage = createArtifactStorage({ db, env, objectClient });
    if (storage.adapterName === 'LOCAL') fs.accessSync(storage.root, fs.constants.R_OK | fs.constants.W_OK);
    return configured;
  } catch (error) {
    return {
      status: 'degraded',
      code: error.code || 'report_storage_unavailable',
      mode: configured.mode,
      execution_mode: configured.execution_mode,
    };
  }
}

module.exports = {
  LOCAL_VOLUME_ACK,
  PRODUCTION_ENABLE_ACK,
  WORKER_ACK,
  createArtifactStorage,
  defaultStorageRoot,
  durableExportsEnabled,
  reportArtifactReadiness,
  reportArtifactRuntimeReadiness,
};
