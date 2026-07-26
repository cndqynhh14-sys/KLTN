'use strict';

const { artifactError, normalizeStorageKey } = require('./artifactSecurity');

class ObjectArtifactStorage {
  constructor({ client, bucket }) {
    if (!client || typeof client.putObject !== 'function' || typeof client.getObject !== 'function') {
      throw artifactError('report_object_adapter_unavailable', 503);
    }
    if (!bucket) throw artifactError('report_object_bucket_missing', 503);
    this.client = client;
    this.bucket = bucket;
    this.adapterName = 'OBJECT';
  }

  putAtomic({ storageKey, buffer, contentType }) {
    const key = normalizeStorageKey(storageKey);
    const result = this.client.putObject({
      bucket: this.bucket,
      key,
      body: buffer,
      contentType,
      ifNoneMatch: '*',
    });
    if (result && typeof result.then === 'function') throw artifactError('report_object_adapter_requires_worker', 503);
    return result;
  }

  get(storageKey) {
    const result = this.client.getObject({ bucket: this.bucket, key: normalizeStorageKey(storageKey) });
    if (result && typeof result.then === 'function') throw artifactError('report_object_adapter_requires_worker', 503);
    return Buffer.isBuffer(result) ? result : result?.body;
  }
}

module.exports = { ObjectArtifactStorage };
