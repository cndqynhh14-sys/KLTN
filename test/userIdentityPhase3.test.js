'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const MODULES = [
  '../server/config/paths',
  '../server/db',
  '../server/middleware/auth',
];

function clearModules() {
  MODULES.forEach((modulePath) => { delete require.cache[require.resolve(modulePath)]; });
}

function cleanup(dbPath) {
  [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

test('identity cutover uses immutable user_id relationships and signs JWT sub with user_id', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-user-id-${process.pid}-${Date.now()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldSecret = process.env.JWT_SECRET;
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'phase-3-user-id-test-secret';
  clearModules();

  const { db, authorizationService } = require('../server/db');
  const { signToken } = require('../server/middleware/auth');
  const email = 'immutable-identity@example.invalid';
  try {
    upsertCanonicalUser(db, {
      email,
      roleCode: 'QLCL_SPECIALIST',
      displayName: 'Immutable identity fixture',
      createdBy: 'fixture',
    });
    db.prepare(`INSERT INTO user_scope_assignments
      (user_id, role_id, scope_type, scope_value, effect, source)
      SELECT ?, id, 'OWN', 'SELF', 'ALLOW', 'MANUAL' FROM roles WHERE role_code = 'QLCL_SPECIALIST'`
    ).run(db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(email));

    const stored = db.prepare('SELECT user_id, email FROM users WHERE email = ?').get(email);
    assert.match(stored.user_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const userIdColumn = db.prepare("PRAGMA table_info('users')").all().find((column) => column.name === 'user_id');
    assert.equal(userIdColumn.pk, 1);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").pluck().get(),
      /email\s+TEXT\s+NOT NULL\s+COLLATE NOCASE\s+UNIQUE/i);
    const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const userForeignKeys = tableNames.flatMap(({ name }) => db.prepare(`PRAGMA foreign_key_list('${name.replaceAll("'", "''")}')`).all()
      .filter((foreignKey) => foreignKey.table === 'users').map((foreignKey) => ({ table: name, ...foreignKey })));
    assert.ok(userForeignKeys.length > 0);
    assert.ok(userForeignKeys.every((foreignKey) => foreignKey.to === 'user_id'));
    const principalColumns = tableNames.flatMap(({ name }) => db.prepare(`PRAGMA table_info('${name.replaceAll("'", "''")}')`).all()
      .filter((column) => column.name.includes('principal')).map((column) => `${name}.${column.name}`));
    assert.deepEqual(principalColumns, []);
    assert.equal(authorizationService.identityForUser(email).userId, stored.user_id);
    assert.equal(authorizationService.identityForUser(stored.user_id).email, email);
    assert.equal(db.prepare('SELECT COUNT(*) FROM user_roles WHERE user_id = ?').pluck().get(stored.user_id), 1);
    assert.equal(db.prepare('SELECT COUNT(*) FROM user_scope_assignments WHERE user_id = ?').pluck().get(stored.user_id), 1);
    assert.equal(db.prepare("SELECT COUNT(*) FROM pragma_table_info('user_roles') WHERE name='principal_id'").pluck().get(), 0);
    assert.equal(db.prepare("SELECT COUNT(*) FROM pragma_table_info('auth_sessions') WHERE name='principal_id'").pluck().get(), 0);
    assert.throws(() => db.prepare('UPDATE users SET user_id = ? WHERE email = ?').run('changed', email), /user_id_immutable/);

    const token = signToken({ email }, 3600);
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'masan-rms', audience: process.env.JWT_AUDIENCE || 'qlcl-app',
    });
    assert.equal(decoded.sub, stored.user_id);
    assert.equal(Object.hasOwn(decoded, 'email'), false);
    const session = db.prepare('SELECT user_id, authz_version FROM auth_sessions WHERE session_id = ?')
      .get(decoded.sid);
    assert.equal(session.user_id, stored.user_id);
    assert.equal(authorizationService.resolveSession(decoded.sid, stored.user_id, decoded.av).userId, stored.user_id);
    assert.throws(() => authorizationService.resolveSession(decoded.sid, email, decoded.av), /invalid_session/);

    db.prepare('UPDATE users SET email=? WHERE user_id=?').run('identity-renamed@example.invalid', stored.user_id);
    assert.equal(db.prepare('SELECT user_id FROM user_roles LIMIT 1').pluck().get(), stored.user_id);
    assert.equal(authorizationService.resolveSession(decoded.sid, stored.user_id, decoded.av).userId, stored.user_id);
    assert.throws(() => db.prepare("INSERT INTO users (email) VALUES ('IDENTITY-RENAMED@example.invalid')").run(), /UNIQUE/);
    db.prepare("INSERT INTO users (email, display_name) VALUES ('generated-id@example.invalid', 'Generated identity')").run();
    assert.match(db.prepare("SELECT user_id FROM users WHERE email='generated-id@example.invalid'").pluck().get(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(db.prepare('SELECT 1 FROM pragma_table_info(\'users\') WHERE name IN (\'role\', \'is_admin\')').get(), undefined);
  } finally {
    db.close();
    clearModules();
    if (oldDbPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = oldDbPath;
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
    cleanup(dbPath);
  }
});
