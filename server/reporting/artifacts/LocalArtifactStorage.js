'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { artifactError, checksumBuffer, normalizeStorageKey } = require('./artifactSecurity');

class LocalArtifactStorage {
  constructor({ root }) {
    if (!root || !path.isAbsolute(root)) throw artifactError('report_storage_root_invalid');
    this.root = path.resolve(root);
    this.adapterName = 'LOCAL';
    fs.mkdirSync(this.root, { recursive: true });
  }

  resolve(storageKey) {
    const key = normalizeStorageKey(storageKey);
    const target = path.resolve(this.root, ...key.split('/'));
    if (!target.startsWith(`${this.root}${path.sep}`)) throw artifactError('report_storage_key_invalid', 400);
    return { key, target };
  }

  putAtomic({ storageKey, buffer }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw artifactError('report_artifact_empty', 422);
    const { key, target } = this.resolve(storageKey);
    const sha256 = checksumBuffer(buffer);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target);
      if (checksumBuffer(existing) !== sha256) throw artifactError('report_storage_key_conflict', 409);
      return { storage_key: key, sha256, size_bytes: existing.length };
    }
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, buffer);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, target);
      try {
        const directory = fs.openSync(path.dirname(target), 'r');
        fs.fsyncSync(directory);
        fs.closeSync(directory);
      } catch (_) {
        // Directory fsync is not available on every supported Windows filesystem.
      }
    } catch (error) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch (_) { /* noop */ }
      }
      try { fs.rmSync(temporary, { force: true }); } catch (_) { /* noop */ }
      if (error.code && String(error.code).startsWith('report_')) throw error;
      throw artifactError('report_storage_write_failed', 503, error.message);
    }
    return { storage_key: key, sha256, size_bytes: buffer.length };
  }

  get(storageKey) {
    const { target } = this.resolve(storageKey);
    try {
      return fs.readFileSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw artifactError('report_artifact_missing', 410);
      throw artifactError('report_storage_read_failed', 503, error.message);
    }
  }

  exists(storageKey) {
    const { target } = this.resolve(storageKey);
    return fs.existsSync(target);
  }
}

module.exports = { LocalArtifactStorage };
