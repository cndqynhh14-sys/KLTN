'use strict';

const { reportError } = require('./reportUtils');
const {
  LEGACY_ALIAS_APPROVAL,
  LEGACY_ALIAS_VERSION,
  LEGACY_DEFINITIONS,
  approvalEnabled,
  resolveReportAlias,
} = require('./reportAliasCatalog');

const COUNT_KEYS = Object.freeze(['mapped', 'skipped', 'conflict', 'missing', 'ambiguous']);

class LegacyReportTemplateMigration {
  constructor({ db, env = process.env }) {
    this.db = db;
    this.env = env;
  }

  legacyTemplates() {
    return this.db.prepare(`
      SELECT id, template_name, report_type, active, created_at, updated_at
      FROM report_templates
      WHERE report_type IN ('INTERNAL', 'NCC')
      ORDER BY report_type, id
    `).all();
  }

  syncReviewQueue() {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_legacy_migration_review'").get();
    if (!table) return { inserted: 0 };
    const insert = this.db.prepare(`
      INSERT INTO report_legacy_migration_review (
        legacy_template_id, legacy_source, mapping_version, reason_code,
        proposed_canonical_code, status
      ) VALUES (?, ?, ?, ?, ?, 'PENDING')
      ON CONFLICT(legacy_template_id) DO NOTHING
    `);
    let inserted = 0;
    this.db.transaction(() => {
      for (const template of this.legacyTemplates()) {
        const resolution = resolveReportAlias(template.report_type, { env: this.env });
        const proposed = LEGACY_DEFINITIONS[resolution.legacy_source]?.proposed_canonical_code || null;
        inserted += insert.run(
          template.id,
          resolution.legacy_source,
          LEGACY_ALIAS_VERSION,
          resolution.ambiguous ? 'legacy_mapping_round_ambiguous' : 'legacy_mapping_approval_pending',
          proposed
        ).changes;
      }
    })();
    return { inserted };
  }

  dryRun() {
    const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
    const items = this.legacyTemplates().map((template) => {
      const resolution = resolveReportAlias(template.report_type, { env: this.env });
      const link = this.db.prepare(`
        SELECT * FROM report_legacy_template_links WHERE legacy_template_id=?
      `).get(template.id);
      let status;
      let reason;
      let version = null;
      if (link) {
        if (resolution.canonical_code && link.canonical_definition_code !== resolution.canonical_code) {
          status = 'conflict';
          reason = 'legacy_mapping_conflict';
        } else {
          status = 'mapped';
          reason = 'legacy_mapping_already_linked';
          version = this.db.prepare('SELECT * FROM report_template_versions WHERE id=?').get(link.report_template_version_id) || null;
        }
      } else if (!resolution.canonical_code) {
        status = resolution.ambiguous ? 'ambiguous' : 'skipped';
        reason = resolution.deprecation?.reason || 'legacy_mapping_approval_pending';
      } else {
        version = this.db.prepare(`
          SELECT * FROM report_template_versions
          WHERE definition_code=? AND version_no=1 AND status IN ('PUBLISHED','RETIRED')
          ORDER BY CASE status WHEN 'PUBLISHED' THEN 0 ELSE 1 END, id LIMIT 1
        `).get(resolution.canonical_code) || null;
        if (!version) {
          status = 'missing';
          reason = 'canonical_published_v1_missing';
        } else {
          status = 'mapped';
          reason = 'legacy_mapping_ready';
        }
      }
      counts[status] += 1;
      return {
        legacy_template_id: template.id,
        legacy_source: resolution.legacy_source,
        canonical_code: resolution.canonical_code,
        report_template_version_id: version?.id || link?.report_template_version_id || null,
        mapping_version: LEGACY_ALIAS_VERSION,
        status: status.toUpperCase(),
        reason,
        planned: status === 'mapped' && !link,
      };
    });
    return {
      mode: 'DRY_RUN',
      mutated: false,
      approval_confirmed: approvalEnabled(this.env),
      required_acknowledgement: LEGACY_ALIAS_APPROVAL,
      mapping_version: LEGACY_ALIAS_VERSION,
      counts,
      review_queue_count: this.db.prepare("SELECT COUNT(*) AS n FROM report_legacy_migration_review WHERE status='PENDING'").get().n,
      items,
    };
  }

  applyApproved({ actor = null } = {}) {
    if (!approvalEnabled(this.env)) {
      throw reportError('report_legacy_mapping_pending', 409, {
        required_acknowledgement: LEGACY_ALIAS_APPROVAL,
      });
    }
    const report = this.dryRun();
    let inserted = 0;
    this.db.transaction(() => {
      for (const item of report.items.filter((entry) => entry.status === 'MAPPED' && entry.planned)) {
        inserted += this.db.prepare(`
          INSERT INTO report_legacy_template_links (
            legacy_template_id, legacy_source, canonical_definition_code,
            report_template_version_id, mapping_version, decision_reference, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(legacy_template_id) DO NOTHING
        `).run(
          item.legacy_template_id,
          item.legacy_source,
          item.canonical_code,
          item.report_template_version_id,
          LEGACY_ALIAS_VERSION,
          LEGACY_ALIAS_APPROVAL,
          actor || null
        ).changes;
        this.db.prepare(`
          UPDATE report_legacy_migration_review
          SET status='RESOLVED', resolved_at=datetime('now'), resolved_by=?,
              resolution_note='Linked to immutable Published v1; legacy history retained'
          WHERE legacy_template_id=? AND status='PENDING'
        `).run(actor || null, item.legacy_template_id);
      }
    })();
    return { ...this.dryRun(), mode: 'APPLY_APPROVED', mutated: inserted > 0, inserted };
  }

  reviewQueue() {
    return this.db.prepare(`
      SELECT r.*, t.template_name, t.report_type, t.active
      FROM report_legacy_migration_review r
      JOIN report_templates t ON t.id=r.legacy_template_id
      ORDER BY CASE r.status WHEN 'PENDING' THEN 0 ELSE 1 END, r.id
    `).all();
  }
}

module.exports = { COUNT_KEYS, LegacyReportTemplateMigration };
