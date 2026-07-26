const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_DATA_DIR = path.join(APP_ROOT, 'database');
const MIGRATIONS_DIR = path.join(APP_ROOT, 'migrations');
const DEFAULT_SEED_PATH = path.join(SOURCE_DATA_DIR, 'seeds', 'defaults.sql');

// Runtime data keeps its historical default path for compatibility, while source
// migrations/defaults now live outside that directory.
const runtimeDataRoot = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(APP_ROOT, 'data');
const DATA_DIR = path.resolve(runtimeDataRoot);
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(DATA_DIR, 'qlcl.db'));
const ATTACHMENT_DIR = path.resolve(process.env.ATTACHMENT_DIR || path.join(DATA_DIR, 'evaluation-attachments'));
const REPORT_EXPORT_DIR = path.resolve(process.env.REPORT_EXPORT_DIR || path.join(DATA_DIR, 'report-exports'));

for (const dir of [
  DATA_DIR,
  path.dirname(DB_PATH),
  ATTACHMENT_DIR,
  REPORT_EXPORT_DIR,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  APP_ROOT,
  SOURCE_DATA_DIR,
  MIGRATIONS_DIR,
  DEFAULT_SEED_PATH,
  DATA_DIR,
  DB_PATH,
  ATTACHMENT_DIR,
  REPORT_EXPORT_DIR,
};
