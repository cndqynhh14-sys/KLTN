'use strict';

const path = require('node:path');

const repairArg = process.argv.find((value) => value.startsWith('--repair-id='));
const asOfArg = process.argv.find((value) => value.startsWith('--as-of='));
const databaseArg = process.argv.find((value) => value.startsWith('--db='));
const legacyRootArg = process.argv.find((value) => value.startsWith('--legacy-root='));
const artifactRootArg = process.argv.find((value) => value.startsWith('--artifact-root='));
const expectedChecksumArg = process.argv.find((value) => value.startsWith('--expected-checksum='));
const applyClassifications = process.argv.includes('--apply');

if (databaseArg) process.env.DB_PATH = path.resolve(databaseArg.slice('--db='.length));
if (artifactRootArg) process.env.REPORT_STORAGE_ROOT = path.resolve(artifactRootArg.slice('--artifact-root='.length));

const { db } = require('../server/db');
const { REPORT_EXPORT_DIR } = require('../server/config/paths');
const { LegacyReportArtifactReconciler } = require('../server/reporting/artifacts/LegacyReportArtifactReconciler');

const legacyRoot = legacyRootArg
  ? path.resolve(legacyRootArg.slice('--legacy-root='.length))
  : REPORT_EXPORT_DIR;
const reconciler = new LegacyReportArtifactReconciler({ db, legacyRoot });

try {
  if (repairArg && applyClassifications) {
    throw Object.assign(new Error('reconciliation_mode_conflict'), { code: 'reconciliation_mode_conflict' });
  }
  if (repairArg) {
    const exportId = Number(repairArg.split('=')[1]);
    if (!Number.isInteger(exportId) || exportId < 1) throw Object.assign(new Error('repair_id_invalid'), { code: 'repair_id_invalid' });
    const repaired = reconciler.repairLegacyExport(exportId, { actor: 'report-artifact-reconcile-cli' });
    process.stdout.write(`${JSON.stringify({
      mode: 'REPAIR_ONE',
      export_id: repaired.export_id,
      artifact_id: repaired.id,
      availability_status: repaired.availability_status,
    })}\n`);
  } else if (applyClassifications) {
    const expectedInventoryChecksum = expectedChecksumArg?.slice('--expected-checksum='.length) || '';
    const applied = reconciler.applyLegacyClassifications({ expectedInventoryChecksum });
    const stage4d = reconciler.stage4dReport();
    process.stdout.write(`${JSON.stringify({ applied, stage4d }, null, 2)}\n`);
    if (stage4d.status === 'FAILED') process.exitCode = 1;
  } else {
    const stage4d = reconciler.stage4dReport();
    const retention = reconciler.dryRunRetention({ asOf: asOfArg ? asOfArg.split('=')[1] : new Date() });
    process.stdout.write(`${JSON.stringify({ stage4d, retention }, null, 2)}\n`);
    if (stage4d.status === 'FAILED') process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.code || 'report_artifact_reconcile_failed' })}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
