'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const LEDGER_TABLE = 'schema_migrations';
const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;
const NON_TRANSACTIONAL_SQL = /\bVACUUM\b|\bATTACH\s+DATABASE\b|\bDETACH\s+DATABASE\b|PRAGMA\s+(?:journal_mode|foreign_keys)\b/i;

class MigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    this.details = details;
  }
}

function checksumSql(sql) {
  const canonicalSql = String(sql).replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(canonicalSql, 'utf8').digest('hex');
}

function loadMigrations(migrationsDir) {
  const migrations = fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => {
      const match = entry.name.match(MIGRATION_FILE_PATTERN);
      if (!match) {
        throw new MigrationError('MIGRATION_INVALID_FILENAME', `Invalid migration filename: ${entry.name}`);
      }
      const sql = fs.readFileSync(path.join(migrationsDir, entry.name), 'utf8');
      return {
        id: match[1],
        name: match[2],
        fileName: entry.name,
        filePath: path.join(migrationsDir, entry.name),
        sql,
        checksum: checksumSql(sql),
        transactional: !NON_TRANSACTIONAL_SQL.test(sql),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const duplicateIds = migrations
    .filter((migration, index) => index > 0 && migration.id === migrations[index - 1].id)
    .map((migration) => migration.id);
  if (duplicateIds.length) {
    throw new MigrationError('MIGRATION_DUPLICATE_ID', `Duplicate migration IDs: ${[...new Set(duplicateIds)].join(', ')}`);
  }
  for (let index = 1; index < migrations.length; index += 1) {
    if (Number(migrations[index].id) <= Number(migrations[index - 1].id)) {
      throw new MigrationError('MIGRATION_ORDER_INVALID', 'Migration IDs must increase strictly.');
    }
  }
  return migrations;
}

function tableExists(db, tableName) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function ensureLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      migration_id TEXT PRIMARY KEY,
      migration_name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      app_version TEXT NOT NULL,
      execution_mode TEXT NOT NULL CHECK (execution_mode IN (
        'applied', 'applied-nontransactional', 'adopted', 'forward-repair'
      ))
    )
  `);
}

function readApplied(db) {
  if (!tableExists(db, LEDGER_TABLE)) return [];
  return db.prepare(`
    SELECT migration_id, migration_name, checksum, applied_at,
           duration_ms, app_version, execution_mode
    FROM ${LEDGER_TABLE}
    ORDER BY migration_id
  `).all();
}

function assertAppliedIntegrity(migrations, appliedRows) {
  const migrationById = new Map(migrations.map((migration) => [migration.id, migration]));
  for (const row of appliedRows) {
    const migration = migrationById.get(row.migration_id);
    if (!migration) {
      throw new MigrationError(
        'MIGRATION_FILE_MISSING',
        `Applied migration ${row.migration_id} has no source file.`,
        { migrationId: row.migration_id }
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(
        'MIGRATION_CHECKSUM_MISMATCH',
        `Applied migration ${row.migration_id} was modified.`,
        { migrationId: row.migration_id, expected: row.checksum, actual: migration.checksum }
      );
    }
  }
}

function hasApplicationObjects(db) {
  return !!db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name != ?
    LIMIT 1
  `).get(LEDGER_TABLE);
}

function schemaShape(db) {
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ?
    ORDER BY name
  `).all(LEDGER_TABLE).map((row) => row.name);
  const indexes = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
  const columns = Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => row.name),
  ]));
  return { tables, indexes, columns };
}

function verifyMigrationSchema(db, migration) {
  const expectedDb = new Database(':memory:');
  try {
    expectedDb.pragma('foreign_keys = ON');
    expectedDb.exec(migration.sql);
    const expected = schemaShape(expectedDb);
    const actual = schemaShape(db);
    const actualTables = new Set(actual.tables);
    const actualIndexes = new Set(actual.indexes);
    const missingTables = expected.tables.filter((table) => !actualTables.has(table));
    const missingIndexes = expected.indexes.filter((index) => !actualIndexes.has(index));
    const missingColumns = [];
    for (const table of expected.tables) {
      if (!actualTables.has(table)) continue;
      const present = new Set(actual.columns[table] || []);
      for (const column of expected.columns[table]) {
        if (!present.has(column)) missingColumns.push(`${table}.${column}`);
      }
    }
    return {
      ok: missingTables.length === 0 && missingIndexes.length === 0 && missingColumns.length === 0,
      missingTables,
      missingIndexes,
      missingColumns,
    };
  } finally {
    expectedDb.close();
  }
}

function verificationSummary(verification) {
  const parts = [];
  if (verification.missingTables?.length) parts.push(`tables=${verification.missingTables.join(',')}`);
  if (verification.missingIndexes?.length) parts.push(`indexes=${verification.missingIndexes.join(',')}`);
  if (verification.missingColumns?.length) parts.push(`columns=${verification.missingColumns.join(',')}`);
  return parts.length ? ` Missing ${parts.join('; ')}.` : '';
}

function assertForeignKeys(db, migrationId) {
  const violations = db.pragma('foreign_key_check');
  if (violations.length) {
    throw new MigrationError(
      'MIGRATION_FOREIGN_KEY_VIOLATION',
      `Foreign-key reconciliation failed after migration ${migrationId}.`,
      { migrationId, violationCount: violations.length }
    );
  }
}

function insertLedgerRow(db, migration, metadata) {
  db.prepare(`
    INSERT INTO ${LEDGER_TABLE} (
      migration_id, migration_name, checksum, applied_at,
      duration_ms, app_version, execution_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    migration.id,
    migration.name,
    migration.checksum,
    metadata.appliedAt,
    metadata.durationMs,
    metadata.appVersion,
    metadata.executionMode
  );
}

function migrationStatus(db, { migrationsDir }) {
  const migrations = loadMigrations(migrationsDir);
  const appliedRows = readApplied(db);
  assertAppliedIntegrity(migrations, appliedRows);
  const appliedById = new Map(appliedRows.map((row) => [row.migration_id, row]));
  return migrations.map((migration) => {
    const row = appliedById.get(migration.id);
    return {
      id: migration.id,
      name: migration.name,
      checksum: migration.checksum,
      transactional: migration.transactional,
      state: row ? 'applied' : 'pending',
      applied_at: row?.applied_at || null,
      duration_ms: row?.duration_ms ?? null,
      app_version: row?.app_version || null,
      execution_mode: row?.execution_mode || null,
    };
  });
}

function migrateDatabase(db, options) {
  const {
    migrationsDir,
    appVersion,
    baselineId = '0001',
    forwardRepair,
    verifyBaseline = verifyMigrationSchema,
    allowedNonTransactionalIds = [],
    now = () => new Date(),
    clock = () => Date.now(),
  } = options;
  if (!migrationsDir || !appVersion) {
    throw new MigrationError('MIGRATION_CONFIG_INVALID', 'migrationsDir and appVersion are required.');
  }

  const migrations = loadMigrations(migrationsDir);
  ensureLedger(db);
  const appliedRows = readApplied(db);
  assertAppliedIntegrity(migrations, appliedRows);
  const appliedIds = new Set(appliedRows.map((row) => row.migration_id));
  const results = [];

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      results.push({ id: migration.id, state: 'already-applied' });
      continue;
    }

    const startedAt = clock();
    const metadata = (executionMode) => ({
      appliedAt: now().toISOString(),
      durationMs: Math.max(0, clock() - startedAt),
      appVersion,
      executionMode,
    });

    if (migration.id === baselineId && hasApplicationObjects(db)) {
      if (db.inTransaction) {
        throw new MigrationError(
          'MIGRATION_TRANSACTION_ACTIVE',
          'Baseline reconciliation must start outside an existing transaction so it can fail atomically.'
        );
      }
      const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true });
      let executionMode;
      if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
      try {
        executionMode = db.transaction(() => {
          let verification = verifyBaseline(db, migration);
          let mode = 'adopted';
          if (!verification.ok) {
            if (typeof forwardRepair !== 'function') {
              throw new MigrationError(
                'MIGRATION_BASELINE_INCOMPATIBLE',
                `Existing database does not match the baseline and no forward-repair adapter was provided.${verificationSummary(verification)}`,
                verification
              );
            }
            forwardRepair({ db, migration, verification });
            verification = verifyBaseline(db, migration);
            if (!verification.ok) {
              throw new MigrationError(
                'MIGRATION_FORWARD_REPAIR_INCOMPLETE',
                `Compatibility forward-repair did not reconcile the baseline schema.${verificationSummary(verification)}`,
                verification
              );
            }
            mode = 'forward-repair';
          }
          assertForeignKeys(db, migration.id);
          insertLedgerRow(db, migration, metadata(mode));
          return mode;
        })();
      } finally {
        db.pragma(`foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
      }
      appliedIds.add(migration.id);
      results.push({ id: migration.id, state: 'applied', executionMode });
      continue;
    }

    const apply = () => {
      db.exec(migration.sql);
      assertForeignKeys(db, migration.id);
      insertLedgerRow(db, migration, metadata(migration.transactional ? 'applied' : 'applied-nontransactional'));
    };

    try {
      if (migration.transactional) {
        db.transaction(apply)();
      } else if (allowedNonTransactionalIds.includes(migration.id)) {
        apply();
      } else {
        throw new MigrationError(
          'MIGRATION_NON_TRANSACTIONAL_NOT_APPROVED',
          `Migration ${migration.id} contains SQL that SQLite cannot safely wrap; explicit approval is required.`,
          { migrationId: migration.id }
        );
      }
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError(
        'MIGRATION_APPLY_FAILED',
        `Migration ${migration.id} failed: ${error.message}`,
        { migrationId: migration.id }
      );
    }
    appliedIds.add(migration.id);
    results.push({ id: migration.id, state: 'applied', executionMode: migration.transactional ? 'applied' : 'applied-nontransactional' });
  }

  return { results, status: migrationStatus(db, { migrationsDir }) };
}

module.exports = {
  LEDGER_TABLE,
  MigrationError,
  checksumSql,
  loadMigrations,
  migrationStatus,
  migrateDatabase,
  verifyMigrationSchema,
};
