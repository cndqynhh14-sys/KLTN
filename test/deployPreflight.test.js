'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { CORE_TABLES, createLegacyFixture, snapshotCounts } = require('../fixtures/migrations/legacyFixtureBuilder');
const { runDeployPreflight } = require('../scripts/preflight-deploy-migration');

const expectedMigrationIds = fs.readdirSync(path.resolve(__dirname, '..', 'migrations'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => name.slice(0, 4));

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('deploy preflight preserves a verified backup and migrates only a disposable copy', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-deploy-preflight-'));
  const sourcePath = path.join(directory, 'source.db');
  const backupDir = path.join(directory, 'backups');
  const before = createLegacyFixture(sourcePath).counts;
  const sourceHash = fileHash(sourcePath);
  try {
    const result = await runDeployPreflight({ dbPath: sourcePath, backupDir });
    assert.equal(result.verified, true);
    assert.equal(result.integrity_check, true);
    assert.equal(result.foreign_key_check, true);
    assert.deepEqual(result.migration_ids, expectedMigrationIds);
    assert.equal(fs.existsSync(result.backup_path), true);
    assert.equal(fileHash(sourcePath), sourceHash);
    assert.equal(fs.readdirSync(backupDir).some((name) => name.startsWith('.preflight-')), false);

    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    const backup = new Database(result.backup_path, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(snapshotCounts(source, CORE_TABLES), before);
      assert.deepEqual(snapshotCounts(backup, CORE_TABLES), before);
      assert.equal(source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(), undefined);
      assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(), undefined);
    } finally {
      source.close();
      backup.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
