'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const deployScript = fs.readFileSync(path.resolve(__dirname, '..', 'deploy', 'deploy.sh'), 'utf8');

test('VM deploy commit gate covers versioned migration and seed sources', () => {
  const deployedPaths = deployScript.match(/DEPLOYED_PATHS="([^"]+)"/);
  assert.ok(deployedPaths, 'DEPLOYED_PATHS must be declared');
  const paths = new Set(deployedPaths[1].split(/\s+/));
  assert.equal(paths.has('migrations'), true);
  assert.equal(paths.has('database'), true);
});

test('VM deploy gates its scripts and runs verified backup migration preflight before restart', () => {
  const deployedPaths = deployScript.match(/DEPLOYED_PATHS="([^"]+)"/);
  assert.ok(deployedPaths, 'DEPLOYED_PATHS must be declared');
  const paths = new Set(deployedPaths[1].split(/\s+/));
  assert.equal(paths.has('scripts'), true);
  assert.match(deployScript, /node scripts\/preflight-deploy-migration\.js/);
  assert.ok(
    deployScript.indexOf('node scripts/preflight-deploy-migration.js') < deployScript.indexOf('systemctl restart qlcl'),
    'verified backup and migration preflight must finish before the live service restarts'
  );
});

test('VM rsync excludes the entire runtime data directory from delete synchronization', () => {
  const rsyncOptions = deployScript.match(/RSYNC_OPTS=\(([\s\S]*?)\)/);
  assert.ok(rsyncOptions, 'RSYNC_OPTS must be declared');
  assert.match(rsyncOptions[1], /(?:^|\s)--delete(?:\s|$)/);
  const excludes = [...rsyncOptions[1].matchAll(/--exclude\s+(?:'([^']+)'|"([^"]+)"|(\S+))/g)]
    .map((match) => match[1] || match[2] || match[3]);
  assert.equal(excludes.includes('data/'), true);
  assert.doesNotMatch(deployScript, /--delete-excluded/);
});
