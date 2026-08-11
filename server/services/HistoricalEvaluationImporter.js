'use strict';

const crypto = require('node:crypto');
const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');

const { HISTORICAL_KIND } = require('../domain/historicalEvaluation');
const HISTORICAL_STATUS = WORKFLOW_STATUSES.COMPLETED;

function text(value) {
  if (value == null) return '';
  return String(value).replace(/\u00a0/g, ' ').trim();
}

function nullableText(value) {
  return text(value) || null;
}

function normalizeSupplierCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value)).trim().toUpperCase();
  return text(value).toUpperCase();
}

function finiteScore(value) {
  if (value == null || text(value) === '') return null;
  const raw = typeof value === 'number' ? value : Number(text(value).replace('%', '').replace(',', '.'));
  if (!Number.isFinite(raw)) return null;
  const percentage = typeof value === 'string' && text(value).includes('%')
    ? raw
    : (Math.abs(raw) <= 1 ? raw * 100 : raw);
  return Math.round(percentage * 10000) / 10000;
}

function classifyHistoricalRound2(record) {
  const score1 = finiteScore(record?.scoreRound1);
  const score2 = finiteScore(record?.scoreAfterCorrection);
  const scoreChanged = score1 != null && score2 != null && Math.abs(score2 - score1) > 1e-9;
  return scoreChanged || !!nullableText(record?.adjustmentReason) || !!nullableText(record?.correctionDate);
}

function sourceKey(sourceId, sourceStt) {
  return crypto.createHash('sha256')
    .update(`QLCL_HISTORICAL_V1|${text(sourceId).toUpperCase()}|${text(sourceStt)}`)
    .digest('hex');
}

function ticketCodeFor(key, sourceStt) {
  const stt = String(Number(sourceStt) || text(sourceStt)).padStart(4, '0');
  return `HIST-${key.slice(0, 8).toUpperCase()}-${stt}`;
}

function timestampForDate(dateValue) {
  const value = nullableText(dateValue);
  return value ? `${value} 00:00:00` : null;
}

function uniqueNames(values) {
  return [...new Set((values || []).map(text).filter(Boolean))];
}

function mappingError(items) {
  const error = new Error('historical_supplier_mapping_failed');
  error.code = 'historical_supplier_mapping_failed';
  error.items = items;
  return error;
}

class HistoricalEvaluationImporter {
  constructor(db) {
    this.db = db;
    this.statements = {
      suppliersByCode: db.prepare(`
        SELECT id, supplier_code, supplier_name, tax_code, address, region, province,
               business_type, contact_name, contact_email, contact_phone
        FROM supplier_master
        WHERE UPPER(TRIM(supplier_code)) = UPPER(TRIM(?))
      `),
      existingBySourceKey: db.prepare(`
        SELECT id, ticket_code FROM evaluation_tickets WHERE historical_source_key = ?
      `),
      insertTicket: db.prepare(`
        INSERT INTO evaluation_tickets (
          ticket_code, supplier_id, supplier_code, supplier_name, tax_code, supplier_address,
          snapshot_evaluation_address, snapshot_linked_facility_name,
          snapshot_linked_facility_address, region, province, business_type,
          cmc_owner, cmc_head, contact_name, contact_email, contact_phone,
          mch2, mch3, snapshot_product_name, evaluation_type, template_id,
          facility_type, supplier_scale, evaluation_department, actual_evaluation_date,
          current_status, current_round_no, score_percent, result_label, result_reason,
          corrected_score_percent, corrected_result_label, correction_date,
          next_evaluation_date, final_conclusion, scoring_locked, completed_round,
          created_at, source_kind, historical_source_key, historical_source_file,
          historical_source_file_hash, historical_source_row_number,
          historical_source_stt, historical_source_payload_json
        ) VALUES (
          @ticket_code, @supplier_id, @supplier_code, @supplier_name, @tax_code, @supplier_address,
          @snapshot_evaluation_address, @snapshot_linked_facility_name,
          @snapshot_linked_facility_address, @region, @province, @business_type,
          @cmc_owner, @cmc_head, @contact_name, @contact_email, @contact_phone,
          @mch2, @mch3, @snapshot_product_name, @evaluation_type, NULL,
          NULL, NULL, @evaluation_department, @actual_evaluation_date,
          @current_status, @current_round_no, @score_percent, @result_label, @result_reason,
          @corrected_score_percent, @corrected_result_label, @correction_date,
          @next_evaluation_date, @final_conclusion, 1, @completed_round,
          @created_at, @source_kind, @historical_source_key, @historical_source_file,
          @historical_source_file_hash, @historical_source_row_number,
          @historical_source_stt, @historical_source_payload_json
        )
      `),
      insertRound: db.prepare(`
        INSERT INTO evaluation_rounds (
          ticket_id, round_no, source_round_id, assessment_code, assessment_date,
          status, started_at, completed_at, total_score, final_result,
          classification, locked_at, locked_by, correction_locked,
          scoring_policy_version_id, scoring_result_snapshot_json, scoring_result_checksum
        ) VALUES (
          @ticket_id, @round_no, @source_round_id, @assessment_code, @assessment_date,
          @status, @started_at, @completed_at, @total_score, @final_result,
          NULL, @locked_at, NULL, 1, NULL, NULL, NULL
        )
      `),
      insertNonconformity: db.prepare(`
        INSERT INTO evaluation_nonconformities (
          ticket_id, round_id, clause_code, category, due_date, severity, status,
          created_at, created_by, updated_by, evaluation_answer_id,
          nonconformity_content, remediation_content
        ) VALUES (
          @ticket_id, @round_id, NULL, @category, NULL, NULL, 'OPEN',
          @created_at, NULL, NULL, NULL, @nonconformity_content, NULL
        )
      `),
      insertParticipant: db.prepare(`
        INSERT INTO evaluation_participants (
          ticket_id, round_id, user_id, display_name, participant_role,
          opening_meeting, closing_meeting, active, assigned_at, assigned_by
        ) VALUES (
          @ticket_id, @round_id, NULL, @display_name, @participant_role,
          0, 0, 1, @assigned_at, NULL
        )
      `),
    };
  }

  plan(records, { sourceId, sourceFile, sourceFileHash }) {
    if (!text(sourceId)) throw Object.assign(new Error('historical_source_id_required'), { code: 'historical_source_id_required' });
    const seen = new Set();
    const mappingFailures = [];
    const planned = (records || []).map((record, index) => {
      const stt = Number(record.sourceStt);
      if (!Number.isInteger(stt) || stt <= 0) {
        mappingFailures.push({ sourceRowNumber: record.sourceRowNumber || index + 1, code: 'source_stt_invalid' });
        return null;
      }
      const key = sourceKey(sourceId, stt);
      if (seen.has(key)) {
        mappingFailures.push({ sourceRowNumber: record.sourceRowNumber || index + 1, sourceStt: stt, code: 'source_key_duplicate' });
        return null;
      }
      seen.add(key);
      const supplierCode = normalizeSupplierCode(record.supplierCode);
      const suppliers = this.statements.suppliersByCode.all(supplierCode);
      if (suppliers.length !== 1) {
        mappingFailures.push({
          sourceRowNumber: record.sourceRowNumber || index + 1,
          sourceStt: stt,
          supplierCode,
          matchCount: suppliers.length,
          code: suppliers.length ? 'supplier_mapping_ambiguous' : 'supplier_not_found',
        });
        return null;
      }
      const hasRound2 = classifyHistoricalRound2(record);
      return {
        record,
        supplier: suppliers[0],
        sourceKey: key,
        ticketCode: ticketCodeFor(key, stt),
        hasRound2,
        duplicate: !!this.statements.existingBySourceKey.get(key),
        sourceFile: text(sourceFile),
        sourceFileHash: text(sourceFileHash),
      };
    }).filter(Boolean);
    if (mappingFailures.length) throw mappingError(mappingFailures);
    return planned;
  }

  importRecords({ records, sourceId, sourceFile, sourceFileHash, commit = false }) {
    const planned = this.plan(records, { sourceId, sourceFile, sourceFileHash });
    const importedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const result = {
      sourceRowCount: planned.length,
      ticketCount: planned.length,
      round1Count: planned.length,
      round2Count: planned.filter((item) => item.hasRound2).length,
      round1OnlyCount: planned.filter((item) => !item.hasRound2).length,
      missingScoreRound1Count: planned.filter((item) => finiteScore(item.record.scoreRound1) == null).length,
      round2MissingCorrectionDateCount: planned.filter((item) => item.hasRound2 && !nullableText(item.record.correctionDate)).length,
      mappedSupplierCount: planned.length,
      unmappedSupplierCount: 0,
      duplicateCount: planned.filter((item) => item.duplicate).length,
      insertedTickets: 0,
      insertedRounds: 0,
      insertedNonconformities: 0,
      insertedParticipants: 0,
    };
    if (!commit) return result;

    this.db.transaction(() => {
      planned.filter((item) => !item.duplicate).forEach((item) => {
        const { record, supplier } = item;
        const score1 = finiteScore(record.scoreRound1);
        const score2 = item.hasRound2 ? finiteScore(record.scoreAfterCorrection) : null;
        const actualDate = nullableText(record.actualEvaluationDate);
        const correctionDate = item.hasRound2 ? nullableText(record.correctionDate) : null;
        const createdAt = timestampForDate(actualDate) || importedAt;
        const payload = {
          ticket_code: item.ticketCode,
          supplier_id: supplier.id,
          supplier_code: supplier.supplier_code,
          supplier_name: nullableText(record.supplierName) || supplier.supplier_name,
          tax_code: supplier.tax_code || null,
          supplier_address: supplier.address || null,
          snapshot_evaluation_address: nullableText(record.supplierEvaluationAddress),
          snapshot_linked_facility_name: nullableText(record.linkedFacilityName),
          snapshot_linked_facility_address: nullableText(record.linkedFacilityAddress),
          region: nullableText(record.region) || supplier.region || null,
          province: nullableText(record.province) || supplier.province || null,
          business_type: nullableText(record.businessType) || supplier.business_type || null,
          cmc_owner: nullableText(record.cmcOwner),
          cmc_head: nullableText(record.cmcHead),
          contact_name: nullableText(record.contactName) || supplier.contact_name || null,
          contact_email: nullableText(record.contactEmail) || supplier.contact_email || null,
          contact_phone: nullableText(record.contactPhone) || supplier.contact_phone || null,
          mch2: nullableText(record.mch2),
          mch3: nullableText(record.mch3),
          snapshot_product_name: nullableText(record.productName),
          evaluation_type: nullableText(record.evaluationType) || 'Lịch sử',
          evaluation_department: nullableText(record.evaluationDepartment),
          actual_evaluation_date: actualDate,
          current_status: HISTORICAL_STATUS,
          current_round_no: item.hasRound2 ? 2 : 1,
          score_percent: score1,
          result_label: nullableText(record.conclusionRound1),
          result_reason: item.hasRound2 ? nullableText(record.adjustmentReason) : null,
          corrected_score_percent: score2,
          corrected_result_label: item.hasRound2 ? nullableText(record.conclusionAfterCorrection) : null,
          correction_date: correctionDate,
          next_evaluation_date: nullableText(record.nextEvaluationDate),
          final_conclusion: nullableText(record.finalConclusion),
          completed_round: item.hasRound2 ? 2 : 1,
          created_at: createdAt,
          source_kind: HISTORICAL_KIND,
          historical_source_key: item.sourceKey,
          historical_source_file: item.sourceFile || null,
          historical_source_file_hash: item.sourceFileHash || null,
          historical_source_row_number: Number(record.sourceRowNumber) || null,
          historical_source_stt: Number(record.sourceStt),
          historical_source_payload_json: JSON.stringify(record.sourcePayload || record),
        };
        const ticketId = Number(this.statements.insertTicket.run(payload).lastInsertRowid);
        result.insertedTickets += 1;

        const round1DateTime = timestampForDate(actualDate);
        const round1Id = Number(this.statements.insertRound.run({
          ticket_id: ticketId,
          round_no: 1,
          source_round_id: null,
          assessment_code: `${item.ticketCode}-R1`,
          assessment_date: actualDate,
          status: HISTORICAL_STATUS,
          started_at: round1DateTime,
          completed_at: round1DateTime,
          total_score: score1,
          final_result: nullableText(record.conclusionRound1),
          locked_at: round1DateTime,
        }).lastInsertRowid);
        result.insertedRounds += 1;

        if (item.hasRound2) {
          const round2DateTime = timestampForDate(correctionDate);
          this.statements.insertRound.run({
            ticket_id: ticketId,
            round_no: 2,
            source_round_id: round1Id,
            assessment_code: `${item.ticketCode}-R2`,
            assessment_date: correctionDate,
            status: HISTORICAL_STATUS,
            started_at: round2DateTime,
            completed_at: round2DateTime,
            total_score: score2,
            final_result: nullableText(record.conclusionAfterCorrection),
            locked_at: round2DateTime,
          });
          result.insertedRounds += 1;
        }

        (record.violations || []).forEach((violation) => {
          const content = nullableText(violation.content);
          if (!content) return;
          this.statements.insertNonconformity.run({
            ticket_id: ticketId,
            round_id: round1Id,
            category: nullableText(violation.group),
            created_at: round1DateTime || importedAt,
            nonconformity_content: content,
          });
          result.insertedNonconformities += 1;
        });

        const ticketParticipants = [
          ...uniqueNames(record.qaLeadNames).map((displayName) => ({ displayName, role: 'QA_LEAD' })),
          ...uniqueNames(record.qaSupportNames).map((displayName) => ({ displayName, role: 'QA_SUPPORT' })),
        ];
        ticketParticipants.forEach((participant) => {
          this.statements.insertParticipant.run({
            ticket_id: ticketId,
            round_id: null,
            display_name: participant.displayName,
            participant_role: participant.role,
            assigned_at: importedAt,
          });
          result.insertedParticipants += 1;
        });
        const evaluator = uniqueNames(record.qaLeadNames)[0];
        if (evaluator) {
          this.statements.insertParticipant.run({
            ticket_id: null,
            round_id: round1Id,
            display_name: evaluator,
            participant_role: 'EVALUATOR',
            assigned_at: importedAt,
          });
          result.insertedParticipants += 1;
        }
      });
    })();
    return result;
  }
}

module.exports = {
  HISTORICAL_KIND,
  HistoricalEvaluationImporter,
  classifyHistoricalRound2,
  finiteScore,
  normalizeSupplierCode,
  sourceKey,
};
