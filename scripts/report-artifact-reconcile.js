'use strict';

const { db } = require('../server/db');
const { REPORT_EXPORT_DIR } = require('../server/config/paths');
const { LegacyReportArtifactReconciler } = require('../server/reporting/artifacts/LegacyReportArtifactReconciler');

const repairArg = process.argv.find((value) => value.startsWith('--repair-id='));
const asOfArg = process.argv.find((value) => value.startsWith('--as-of='));
const reconciler = new LegacyReportArtifactReconciler({ db, legacyRoot: REPORT_EXPORT_DIR });

try {
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
  } else {
    const legacy = reconciler.dryRunLegacyMapping();
    const retention = reconciler.dryRunRetention({ asOf: asOfArg ? asOfArg.split('=')[1] : new Date() });
    process.stdout.write(`${JSON.stringify({ legacy, retention }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.code || 'report_artifact_reconcile_failed' })}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
