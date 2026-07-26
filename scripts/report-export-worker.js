'use strict';

const logger = require('../server/logger');
const { db } = require('../server/db');
const { reportArtifactReadiness } = require('../server/reporting/artifacts/config');
const { ReportExportJobService } = require('../server/reporting/artifacts/ReportExportJobService');

const once = process.argv.includes('--once');
const intervalArg = process.argv.find((value) => value.startsWith('--interval-ms='));
const intervalMs = Math.min(60000, Math.max(250, Number(intervalArg?.split('=')[1] || 2000)));
const readiness = reportArtifactReadiness(process.env);

if (readiness.status !== 'ready') {
  logger.error('report.worker.not_ready', { code: readiness.code, mode: readiness.mode });
  process.exitCode = 1;
} else if (readiness.execution_mode !== 'worker' && process.env.NODE_ENV === 'production') {
  logger.error('report.worker.execution_mode_invalid', { execution_mode: readiness.execution_mode });
  process.exitCode = 1;
} else {
  const service = new ReportExportJobService({ db, executionMode: 'worker' });
  let stopped = false;
  process.once('SIGTERM', () => { stopped = true; });
  process.once('SIGINT', () => { stopped = true; });

  const run = () => {
    if (stopped) {
      db.close();
      return;
    }
    try {
      const result = service.processNext();
      if (result) logger.info('report.worker.job_processed', { job_id: result.job_id, status: result.status || 'COMPLETED' });
    } catch (error) {
      logger.error('report.worker.job_failed', { error_code: error.code || 'report_export_failed' });
    }
    if (once) {
      db.close();
      return;
    }
    setTimeout(run, intervalMs);
  };
  run();
}
