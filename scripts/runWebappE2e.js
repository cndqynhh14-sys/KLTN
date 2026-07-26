const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const result = spawnSync(process.execPath, ['--test', path.join('test', 'webappLocal.test.js')], {
  cwd: root,
  env: {
    ...process.env,
    RUN_WEBAPP_E2E: '1',
  },
  stdio: 'inherit',
});

process.exit(result.status == null ? 1 : result.status);
