const express = require('express');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const multer = require('multer');
const { db, policyService, approvalAssignmentService } = require('../db');
const { ATTACHMENT_DIR, REPORT_EXPORT_DIR } = require('../config/paths');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, requireApproval, policyErrorResponse } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { resourceContext: baseResourceContext } = require('../services/PolicyService');
const { finalConclusionFromScore } = require('../domain/evaluationRules');
const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');
const { assertValidDateField, isValidISODate } = require('../domain/dateValidation');
const { calendarDateInTimeZone, defaultCorrectionDueDate: calculateDefaultCorrectionDueDate } = require('../domain/correctiveActionDueDate');
const { sendEmail, buildWorkflowEmail } = require('../services/email');
const { exportReportHtml, exportReportPdf, exportReportXlsx, reportDefinitionFor } = require('../services/reporting');
const { exportCanonicalReport, isCanonicalDefinition } = require('../reporting/canonicalReportExports');
const { resolveReportAlias } = require('../reporting/reportAliasCatalog');
const { businessErrorPayload } = require('../reporting/reportBusinessErrors');
const { getContext } = require('../observability/context');
const { QuestionVersionService } = require('../services/QuestionVersionService');
const { exportEvaluationSummaryXlsx } = require('../services/evaluationSummaryExport');
const {
  collectUserValuesFromRecords,
  displayNameForValue,
  displayNamesForValues,
  parseUserValues,
  userDisplayNameMap,
  withUserDisplayNames,
} = require('../services/userDisplayNames');
const logger = require('../logger');
const EvaluationTicketRepository = require('../repositories/EvaluationTicketRepository');
const EvaluationRoundRepository = require('../repositories/EvaluationRoundRepository');
const EvaluationAnswerRepository = require('../repositories/EvaluationAnswerRepository');
const EvaluationParticipantRepository = require('../repositories/EvaluationParticipantRepository');
const AttachmentRepository = require('../repositories/AttachmentRepository');
const CorrectiveActionRepository = require('../repositories/CorrectiveActionRepository');
const ApprovalTaskRepository = require('../repositories/ApprovalTaskRepository');
const WorkflowHistoryRepository = require('../repositories/WorkflowHistoryRepository');
const NotificationRepository = require('../repositories/NotificationRepository');
const EvaluationAttachmentService = require('../services/EvaluationAttachmentService');
const EvaluationTicketService = require('../services/EvaluationTicketService');
const EvaluationScoringService = require('../services/EvaluationScoringService');
const EvaluationWorkflowService = require('../services/EvaluationWorkflowService');
const { NotificationService } = require('../services/NotificationService');
const ScoringPolicyRepository = require('../scoring/ScoringPolicyRepository');
const { classifyWithPolicy } = require('../scoring/scoringPolicyEngine');
const mock = require('../mock/evaluations');

const router = express.Router();
const questionVersionService = new QuestionVersionService(db);
const ticketRepository = new EvaluationTicketRepository(db);
const roundRepository = new EvaluationRoundRepository(db);
const answerRepository = new EvaluationAnswerRepository(db);
const participantRepository = new EvaluationParticipantRepository(db);
const attachmentRepository = new AttachmentRepository(db);
const correctiveActionRepository = new CorrectiveActionRepository(db);
const approvalTaskRepository = new ApprovalTaskRepository(db);
const workflowHistoryRepository = new WorkflowHistoryRepository(db);
const notificationService = new NotificationService({
  notificationRepository: new NotificationRepository(db),
  policyService,
  warningDays: process.env.NOTIFICATION_DEADLINE_WARNING_DAYS,
});
const scoringPolicyRepository = new ScoringPolicyRepository(db);
let evaluationTicketService;
let evaluationScoringService;
let evaluationWorkflowService;
let evaluationAttachmentService;
const canEditEvaluation = requirePermission(PERMISSIONS.EVALUATION_SCORE);
const canCreateEvaluation = requirePermission(PERMISSIONS.EVALUATION_CREATE);
const canDeleteEvaluation = requirePermission(PERMISSIONS.EVALUATION_DELETE_DRAFT);
const canExportEvaluation = requirePermission(PERMISSIONS.REPORT_EXPORT);
const DRAFT_STATUS = WORKFLOW_STATUSES.DRAFT;
const PROCESSING_STATUS = WORKFLOW_STATUSES.IN_PROGRESS;
const WAITING_CORRECTION_STATUS = WORKFLOW_STATUSES.WAITING_CORRECTION;
const WAITING_LEAD_STATUS = WORKFLOW_STATUSES.WAITING_LEAD;
const ROUND_2_STATUS = WORKFLOW_STATUSES.ROUND_2;
const COMPLETED_STATUS = WORKFLOW_STATUSES.COMPLETED;
const EXTENDED_STATUS = WORKFLOW_STATUSES.EXTENDED;
const APPROVAL_STAGE_BY_WAITING_STATUS = new Map([
  [WORKFLOW_STATUSES.WAITING_LEAD, 'LEAD'],
  [WORKFLOW_STATUSES.WAITING_TBP, 'TBP'],
  [WORKFLOW_STATUSES.WAITING_GDK, 'GDK'],
]);

function resourceContext(row = {}) {
  const context = baseResourceContext(row);
  const ownerId = row.assigned_specialist_id || row.created_by || null;
  return { ...context, ownerId, assignedUserId: ownerId };
}
fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png']);
const ALLOWED_ATTACHMENT_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
]);
const CORRECTIVE_REQUIREMENT_OPTIONS = new Set(['Bổ sung hồ sơ', 'Gửi hình ảnh khắc phục']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ATTACHMENT_DIR),
    filename: (req, file, cb) => {
      const safe = String(file.originalname || 'attachment').replace(/[^\w.\-]+/g, '_');
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}-${safe}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ok = ALLOWED_ATTACHMENT_EXTENSIONS.has(ext) && (!file.mimetype || file.mimetype === 'application/octet-stream' || ALLOWED_ATTACHMENT_MIME.has(file.mimetype));
    cb(ok ? null : Object.assign(new Error('file_type_not_allowed'), { code: 'file_type_not_allowed' }), ok);
  },
});

router.use(requireAuth, requirePermission(PERMISSIONS.EVALUATION_READ));

function removeLocalFile(filePath) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  const allowedRoots = [
    ATTACHMENT_DIR,
    REPORT_EXPORT_DIR,
  ];
  if (!allowedRoots.some((root) => resolved.startsWith(root + path.sep))) return;
  try {
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  } catch (e) {
    logger.warn('[evaluation-delete] file cleanup failed:', e.message);
  }
}

function cleanupUploadedFiles(files) {
  Object.values(files || {}).flat().forEach((file) => removeLocalFile(file.path));
}

function legalFileUpload(req, res, next) {
  upload.fields([
    { name: 'business_license_file', maxCount: 1 },
    { name: 'attp_certificate_file', maxCount: 1 },
  ])(req, res, (err) => {
    if (!err) return next();
    cleanupUploadedFiles(req.files);
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : err.code || 'file_upload_failed' });
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function approvalStageForPatchTransition(ticket, nextStatus) {
  if (!ticket || !nextStatus || nextStatus === ticket.current_status) return null;
  return APPROVAL_STAGE_BY_WAITING_STATUS.get(ticket.current_status) || null;
}

function getTicketRowByCode(code) {
  return ticketRepository.getByCode(code);
}

function latestCompletedScore(row) {
  if (!row) return null;
  const completedRound = row.completed_round || 0;
  const value = completedRound >= 2 && row.corrected_score_percent != null
    ? row.corrected_score_percent
    : (completedRound >= 1 ? row.score_percent : null);
  return value == null ? null : Number(value);
}

function round2NotPassed(row) {
  const score = row?.corrected_score_percent != null ? Number(row.corrected_score_percent) : Number(row?.score_percent);
  return (row?.completed_round || 0) >= 2 && Number.isFinite(score) && !scorePassedForTicket(row, score);
}

function scorePassedForTicket(ticket, score) {
  try {
    const scoringPolicy = scoringPolicyRepository.policyForTicket(ticket);
    return classifyWithPolicy(scoringPolicy.definition, score, false).passed;
  } catch {
    return finalConclusionFromScore(score) === 'Đạt';
  }
}

function finalConclusionForTicket(ticket, score) {
  try {
    const scoringPolicy = scoringPolicyRepository.policyForTicket(ticket);
    const config = scoringPolicy.definition.final_conclusion;
    return Number(score) >= Number(config.pass_min) ? config.pass_label : config.fail_label;
  } catch {
    return finalConclusionFromScore(score);
  }
}

function specialistCanCloseCompletedScoring(ticket) {
  if (!ticket) return false;
  if (pendingApprovalTask(ticket.id)) return false;
  if ([COMPLETED_STATUS, WORKFLOW_STATUSES.CANCELLED].includes(ticket.current_status)) return false;
  if (!ticket.scoring_locked || (ticket.completed_round || 0) < 1) return false;
  const score = latestCompletedScore(ticket);
  return Number.isFinite(Number(score)) && scorePassedForTicket(ticket, Number(score));
}

function specialistCanSubmitLead(ticket) {
  if (!ticket || !ticket.scoring_locked) return false;
  if (pendingApprovalTask(ticket.id)) return false;
  if (!isProcessingStatus(ticket.current_status)
    && ![WAITING_CORRECTION_STATUS, ROUND_2_STATUS, EXTENDED_STATUS].includes(ticket.current_status)) return false;
  const roundNo = Number(ticket.current_round_no || ticket.completed_round || 1);
  if (roundNo !== 2 && missingRequiredNonconformityActions(ticket.id).length) return false;
  return !!evaluationWorkflowService?.leadSubmissionEligibility(ticket).eligible;
}

function ticketUserValues(row) {
  if (!row) return [];
  const participants = row.id
    ? participantRepository.resolveTicketParticipants(row.id).participants
    : [];
  const assignee = row.assigned_specialist_id
    || participants.find((participant) => participant.participant_role === 'OWNER')?.user_id
    || row.created_by;
  return [
    ...participants.map((participant) => participant.user_id),
    row.assigned_specialist_id,
    assignee,
    row.created_by,
    row.updated_by,
    row.deleted_by,
  ];
}

function displayNamesForTicketRows(rows, extraValues = []) {
  return userDisplayNameMap(db, [
    ...(rows || []).flatMap(ticketUserValues),
    ...extraValues,
  ]);
}

function mapTicketForResponse(row, user) {
  const mapped = mapTicket(row, displayNamesForTicketRows([row]));
  return user && mapped ? {
    ...mapped,
    ...evaluationActionEnvelope(row, user),
    evaluation_workspace_visible: evaluationTicketService.isWorkspaceVisible(row, user),
  } : mapped;
}

function mapTicketsForResponse(rows, user) {
  const displayNames = displayNamesForTicketRows(rows);
  return (rows || []).map((row) => {
    const mapped = mapTicket(row, displayNames);
    return user ? {
      ...mapped,
      ...evaluationActionEnvelope(row, user),
      evaluation_workspace_visible: evaluationTicketService.isWorkspaceVisible(row, user),
    } : mapped;
  });
}

function evaluationActionEnvelope(row, user) {
  const envelope = policyService.actionEnvelope('EVALUATION', row, user);
  const allowed = new Set(envelope.allowed_actions || []);
  const disabled = { ...(envelope.disabled_reasons || {}) };
  const scoreDecision = policyService.decision(user, PERMISSIONS.EVALUATION_SCORE, {
    context: resourceContext(row),
  });
  const expose = (action, actionAllowed, reason) => {
    if (scoreDecision.allowed && actionAllowed) {
      allowed.add(action);
      delete disabled[action];
      return;
    }
    allowed.delete(action);
    disabled[action] = scoreDecision.allowed ? reason : scoreDecision.reason;
  };
  const round2 = round2Gate(row);
  expose('end', specialistCanCloseCompletedScoring(row), 'end_evaluation_not_allowed');
  expose('round2_start', round2.eligible, round2.reason || 'round_2_not_allowed');
  expose('submit_lead', specialistCanSubmitLead(row), 'lead_submission_not_eligible');
  if (!evaluationTicketService.isWorkspaceVisible(row, user)) {
    allowed.delete('export');
    disabled.export = 'forbidden_scope';
  }
  return { allowed_actions: [...allowed], disabled_reasons: disabled };
}

function withEvaluationActionEnvelope(payload, user) {
  if (!payload?.ticket) return payload;
  const identifier = payload.ticket.ticket_code || payload.ticket.code || payload.ticket.id;
  const row = identifier ? getTicketByIdentifier(identifier) : null;
  return row ? { ...payload, ticket: mapTicketForResponse(row, user) } : payload;
}

function enrichWorkflowHistoryRows(rows, displayNames = null) {
  const names = displayNames || userDisplayNameMap(db, collectUserValuesFromRecords(rows, ['actor_user_id']));
  return (rows || []).map((row) => withUserDisplayNames(row, ['actor_user_id'], names));
}

function enrichAssessmentRows(rows, ticket, displayNames = null) {
  const names = displayNames || userDisplayNameMap(db, [
    ...ticketUserValues(ticket),
    ...collectUserValuesFromRecords(rows, ['evaluator_id', 'locked_by']),
  ]);
  return (rows || []).map((row) => withUserDisplayNames(row, ['evaluator_id', 'locked_by'], names));
}

function enrichApprovalTasks(rows, displayNames = null) {
  const names = displayNames || userDisplayNameMap(db, collectUserValuesFromRecords(rows, ['acted_by']));
  return (rows || []).map((task) => withUserDisplayNames({
    ...task,
    payload: task.payload || parseTaskPayload(task),
  }, ['acted_by'], names));
}

function enrichCorrectionExtensionRows(rows, displayNames = null) {
  const names = displayNames || userDisplayNameMap(db, collectUserValuesFromRecords(rows, ['created_by']));
  return (rows || []).map((row) => withUserDisplayNames(row, ['created_by'], names));
}

function enrichAttachmentRows(rows, displayNames = null) {
  const names = displayNames || userDisplayNameMap(db, collectUserValuesFromRecords(rows, ['uploaded_by']));
  return (rows || []).map((row) => withUserDisplayNames(row, ['uploaded_by'], names));
}

function mapTicket(row, displayNames = new Map()) {
  if (!row) return null;
  const participantResolution = participantRepository.resolveTicketParticipants(row.id);
  if (participantResolution.mismatch) {
    logger.warn('evaluation.canonical_read_mismatch', {
      resource_type: 'ticket_participant',
      ticket_id: row.id,
      mismatch_count: participantResolution.mismatch_count,
      fallback_count: participantResolution.fallback_count,
    });
  }
  const participants = participantResolution.participants;
  const forRole = (role) => participants.filter((participant) => participant.participant_role === role);
  const identity = (participant) => participant?.user_id || participant?.display_name || '';
  const evaluator = forRole('EVALUATOR')[0];
  const qaLead = forRole('QA_LEAD')[0];
  const owner = forRole('OWNER')[0];
  const qaSupport = forRole('QA_SUPPORT');
  const pendingTask = pendingApprovalTask(row.id);
  const round2 = round2Gate(row);
  const reassessmentDueDate = reassessmentDueDateForTicket(row);
  const completedRound = row.completed_round || 0;
  const finalScore = latestCompletedScore(row);
  const finalGrade = completedRound >= 2 && row.corrected_grade_code ? row.corrected_grade_code : row.grade_code;
  const finalResultLabel = completedRound >= 2 && row.corrected_result_label ? row.corrected_result_label : row.result_label;
  const finalConclusion = row.final_conclusion || (finalScore == null ? '' : finalConclusionForTicket(row, finalScore));
  const qaSupportIds = qaSupport.map(identity).filter(Boolean);
  const assignee = identity(owner) || identity(evaluator) || row.created_by;
  return {
    id: row.id,
    ticket_code: row.ticket_code,
    supplier_id: row.supplier_id,
    supplier: {
      id: row.supplier_id,
      code: row.supplier_code,
      name: row.supplier_name,
      tax_code: row.tax_code,
      address: row.supplier_address,
      production_address: row.production_address,
      evaluation_address: row.evaluation_address,
      linked_facility_code: row.linked_facility_code,
      linked_facility_name: row.linked_facility_name,
      linked_facility_address: row.linked_facility_address,
      linked_facility_type: row.linked_facility_type,
      region: row.region,
      province: row.province,
      business_type: row.business_type,
      cmc_owner: row.cmc_owner,
      cmc_head: row.cmc_head,
      business_license_file: row.business_license_file,
      attp_certificate_type: row.attp_certificate_type,
      attp_certificate_file: row.attp_certificate_file,
      contact_name: row.contact_name,
      contact_email: row.contact_email,
      contact_phone: row.contact_phone,
    },
    evaluation_type: row.evaluation_type,
    merchandising: { mch2: row.mch2, mch3: row.mch3 },
    product_group: row.product_group,
    product_name: row.product_name,
    template_code: row.template_code,
    template_id: row.template_id,
    question_template_version_id: row.question_template_version_id,
    question_template_version_no: row.question_template_version_no,
    question_template_version_status: row.question_template_version_status,
    question_template_version_checksum: row.question_template_version_checksum,
    facility_type: row.facility_type,
    supplier_scale: row.supplier_scale,
    evaluation_method: row.evaluation_method,
    participants,
    participant_source: participantResolution.source,
    participant_mismatch: participantResolution.mismatch,
    evaluator_name: identity(evaluator),
    evaluator_display_name: evaluator?.display_name || displayNameForValue(identity(evaluator), displayNames),
    qa_lead_id: identity(qaLead),
    qa_lead_display_name: qaLead?.display_name || displayNameForValue(identity(qaLead), displayNames),
    qa_support_ids: JSON.stringify(qaSupportIds),
    qa_support_display_names: qaSupport.map((participant) => participant.display_name),
    evaluation_department: row.evaluation_department,
    dates: {
      created: String(row.created_at || '').slice(0, 10),
      planned: row.planned_date,
      actual: row.actual_evaluation_date,
      correction: row.correction_date,
      next_evaluation: row.next_evaluation_date,
      reassessment_due: reassessmentDueDate,
    },
    reassessment_due_date: reassessmentDueDate,
    assignee_name: assignee,
    assignee_display_name: displayNameForValue(assignee, displayNames),
    current_status: row.current_status,
    workflow_status: row.current_status,
    round_1_score_percent: row.score_percent,
    round_1_grade_code: row.grade_code,
    round_1_result_label: row.result_label,
    score_percent: row.score_percent,
    grade_code: row.grade_code,
    result_label: row.result_label,
    display_score_percent: finalScore,
    display_grade_code: finalGrade,
    display_result_label: finalResultLabel,
    result_reason: row.result_reason,
    corrected_score_percent: row.corrected_score_percent,
    corrected_grade_code: row.corrected_grade_code,
    corrected_result_label: row.corrected_result_label,
    final_conclusion: finalConclusion,
    specialist_proposal: row.specialist_proposal,
    supplier_introduction: row.supplier_introduction || '',
    scoring_locked: !!row.scoring_locked,
    scoring_policy_version_id: row.scoring_policy_version_id || null,
    snapshot_locked_at: row.snapshot_locked_at || null,
    completed_round: row.completed_round || row.current_round_no || 1,
    current_round_no: row.current_round_no,
    is_deleted: !!row.is_deleted,
    deleted_at: row.deleted_at,
    deleted_by: row.deleted_by,
    deleted_by_display_name: displayNameForValue(row.deleted_by, displayNames),
    deleted_reason: row.deleted_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    created_by_display_name: displayNameForValue(row.created_by, displayNames),
    updated_by: row.updated_by,
    updated_by_display_name: displayNameForValue(row.updated_by, displayNames),
    pending_approval: pendingTask ? withUserDisplayNames({ ...pendingTask, payload: parseTaskPayload(pendingTask) }, ['acted_by'], displayNames) : null,
    round_2_exists: round2.exists,
    round_2_eligible: round2.eligible,
    round_2_block_reason: round2.reason,
  };
}

function mapQuestion(row) {
  return {
    question_item_id: row.version_item_id || row.question_item_id || null,
    legacy_question_id: String(row.id),
    question_id: String(row.id),
    db_id: row.id,
    template_id: row.template_id,
    template_code: row.template_code,
    question_template_version_id: row.question_template_version_id,
    question_template_version_no: row.version_no || row.question_template_version_no,
    question_template_version_checksum: row.version_checksum || row.question_template_version_checksum,
    version_item_id: row.version_item_id || null,
    facility_type: row.facility_type,
    supplier_scale: row.supplier_scale,
    question_code: row.question_code,
    section_name: row.category,
    category_code: row.category_code || null,
    category_label_snapshot: row.category_label_snapshot || row.category,
    text: row.question_text,
    clause_type: row.is_elimination_clause ? 'exclusion' : 'normal',
    is_critical: !!row.is_critical_clause,
    requires_attachment: !!row.requires_attachment,
    allowed_scores: row.allowed_scores,
    order_index: row.order_index,
    active: !!row.active,
  };
}

function activeQuestions() {
  return db.prepare(`
    SELECT q.*, t.template_code
    FROM evaluation_questions q
    JOIN question_templates t ON t.id = q.template_id
    WHERE q.active = 1 AND t.active = 1
    ORDER BY t.template_code, q.facility_type, q.supplier_scale, q.order_index, q.question_code
  `).all().map(mapQuestion);
}

function questionsForTicket(ticket) {
  return questionVersionService.questionsForTicket(ticket).map(mapQuestion);
}

function getTicketByIdentifier(identifier) {
  return ticketRepository.getByIdOrCode(identifier);
}

function visibleTicketOrResponse(req, res, identifier) {
  const ticket = getTicketByIdentifier(identifier);
  if (!ticket) {
    res.status(404).json({ error: 'ticket_not_found' });
    return null;
  }
  try { evaluationTicketService.assertDetailVisible(ticket, req.user); }
  catch (error) { policyErrorResponse(res, error, req); return null; }
  return ticket;
}

function responsibleTicketOrResponse(req, res, identifier) {
  const ticket = getTicketByIdentifier(identifier);
  if (!ticket) {
    res.status(404).json({ error: 'ticket_not_found' });
    return null;
  }
  try { evaluationTicketService.assertVisible(ticket, req.user); }
  catch (error) { policyErrorResponse(res, error, req); return null; }
  return ticket;
}

function getRound(ticketId, roundNo) {
  return roundRepository.getByTicketAndRound(ticketId, roundNo);
}

function assessmentCode(ticket, roundNo) {
  return `${ticket.ticket_code}-R${roundNo}`;
}

function mapAssessmentRound(ticket, round) {
  const participantResolution = participantRepository.resolveRoundParticipants(round.id);
  const evaluator = participantResolution.participants
    .find((participant) => participant.participant_role === 'EVALUATOR');
  return {
    id: round.id,
    assessment_code: round.assessment_code || assessmentCode(ticket, round.round_no),
    label: `Assessment #${String(round.round_no).padStart(3, '0')}`,
    round_no: round.round_no,
    status: round.status,
    assessment_date: round.assessment_date || String(round.completed_at || round.started_at || '').slice(0, 10),
    participants: participantResolution.participants,
    participant_source: participantResolution.source,
    participant_mismatch: participantResolution.mismatch,
    evaluator_id: evaluator?.user_id || evaluator?.display_name || round.locked_by || '',
    total_score: round.total_score,
    final_result: round.final_result,
    classification: round.classification,
    final_conclusion: round.total_score == null ? '' : finalConclusionFromScore(round.total_score),
    started_at: round.started_at,
    completed_at: round.completed_at,
    locked_at: round.locked_at,
    locked_by: round.locked_by,
    readonly: !!round.locked_at,
  };
}

function assessmentRoundsForTicket(ticket) {
  return enrichAssessmentRows(evaluationScoringService.assessmentRoundsForTicket(ticket), ticket);
}

function round2Gate(ticket) {
  return evaluationScoringService.round2Gate(ticket);
}

function logWorkflow(ticketId, user, action, fromStatus, toStatus, comment) {
  return workflowHistoryRepository.insert({ ticketId, user, action, fromStatus, toStatus, comment });
}

function pendingApprovalTask(ticketId) {
  return approvalTaskRepository.findPendingByTicket(ticketId);
}

function parseTaskPayload(task) {
  try { return JSON.parse(task.comment || '{}'); } catch { return { comment: task.comment || '' }; }
}

function createTbpTask(ticket, user, action, payload, nextStatus) {
  return evaluationWorkflowService.createTbpTask(ticket, user, action, payload, nextStatus);
}

function notifyEmails(recipients, email) {
  const targets = Array.from(new Set((recipients || []).filter(Boolean)));
  targets.forEach((to) => {
    sendEmail({ to, subject: email.subject, htmlContent: email.htmlContent }).catch((e) =>
      logger.error('[workflow-email]', e.message)
    );
  });
}

function notifySpecialist(ticket, title, comment) {
  notifyEmails([ticket.assigned_specialist_id || ticket.created_by], buildWorkflowEmail({
    title,
    ticketCode: ticket.ticket_code,
    supplierName: ticket.supplier_name,
    status: ticket.current_status,
    comment,
  }));
}

function notifyFinalResult(ticket, comment) {
  const cmc = String(process.env.CMC_EMAILS || process.env.CMC_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  notifyEmails([ticket.contact_email, ...cmc], buildWorkflowEmail({
    title: 'Kết quả đánh giá NCC',
    ticketCode: ticket.ticket_code,
    supplierName: ticket.supplier_name,
    status: ticket.current_status,
    comment,
  }));
}

function roundNoFromBody(body) {
  const roundNo = parseInt(body?.round_no || body?.roundNo || body?.assessment_round || '0', 10);
  return [1, 2].includes(roundNo) ? roundNo : null;
}

function reportRequestFromBody(body) {
  const roundNo = roundNoFromBody(body);
  const alias = resolveReportAlias(body?.report_type || body?.reportType || 'ROUND1_RESULT', { roundNo });
  return {
    alias,
    roundNo,
    reportType: alias.canonical_code || alias.legacy_source || 'ROUND1_RESULT',
  };
}

function withReportIdentity(exported, alias) {
  return {
    ...exported,
    canonical_code: exported.canonical_code || exported.definition_code || alias.canonical_code || null,
    legacy_source: exported.legacy_source || alias.legacy_source || null,
    legacy_alias_version: exported.legacy_alias_version || (alias.legacy_source ? alias.mapping_version : null),
    deprecation: alias.deprecation || null,
  };
}

function defaultReportTemplate(reportType) {
  const definition = reportDefinitionFor(reportType);
  const candidates = [definition.code, ...(definition.templateFallbackTypes || [])];
  const placeholders = candidates.map(() => '?').join(', ');
  return db.prepare(`
    SELECT * FROM report_templates
    WHERE report_type IN (${placeholders}) AND active=1
    ORDER BY CASE report_type ${candidates.map((type, index) => `WHEN '${type}' THEN ${index}`).join(' ')} ELSE 99 END,
             updated_at DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(...candidates);
}

function exportResponse(exported) {
  return {
    id: exported.id,
    round_id: exported.round_id || null,
    round_no: exported.round_no || null,
    report_type: exported.report_type,
    canonical_code: exported.canonical_code || null,
    legacy_source: exported.legacy_source || null,
    legacy_alias_version: exported.legacy_alias_version || null,
    deprecation: exported.deprecation || null,
    definition_code: exported.definition_code || null,
    report_template_version_id: exported.report_template_version_id || null,
    context_checksum: exported.context_checksum || null,
    component_checksum: exported.component_checksum || null,
    scoring_compatibility_marker: exported.scoring_compatibility_marker || null,
    file_format: exported.file_format,
    file_name: exported.file_name,
    file_path: exported.file_path,
    storage_key: exported.storage_key,
  };
}

function exportCanonicalForRequest(req, options, alias = null) {
  const context = getContext();
  return exportCanonicalReport(db, {
    ...options,
    idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotency_key || null,
    requestId: context.request_id || null,
    correlationId: context.correlation_id || null,
    legacySource: alias?.legacy_source || null,
    legacyAliasVersion: alias?.legacy_source ? alias.mapping_version : null,
  });
}

function sendExportArtifact(res, exported) {
  if (exported.canonical_code || exported.definition_code) {
    res.setHeader('X-Report-Canonical-Code', exported.canonical_code || exported.definition_code);
  }
  if (exported.legacy_source) {
    res.setHeader('X-Report-Legacy-Source', exported.legacy_source);
    res.setHeader('X-Report-Legacy-Alias-Version', exported.legacy_alias_version || 'UNVERSIONED');
    res.setHeader('Deprecation', 'true');
  }
  if (exported.pending) {
    res.setHeader('Retry-After', String(exported.retry_after || 3));
    return res.status(202).json({
      job_id: exported.job_id,
      status: exported.status,
      definition_code: exported.definition_code,
      file_format: exported.file_format,
      retry_after: exported.retry_after || 3,
      status_url: `/qlcl/api/report-exports/jobs/${exported.job_id}`,
    });
  }
  res.setHeader('Content-Type', exported.content_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', exported.content_disposition);
  res.setHeader('Content-Length', String(exported.buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (exported.id != null) res.setHeader('X-Export-Id', String(exported.id));
  Readable.from([exported.buffer]).pipe(res);
}

function createApprovalTask(ticket, level, assignedRole, user, action, payload, nextStatus) {
  return evaluationWorkflowService.createApprovalTask(ticket, level, assignedRole, user, action, payload, nextStatus);
}

function closeApprovalTask(task, decision, user, comment) {
  return evaluationWorkflowService.closeApprovalTask(task, decision, user, comment);
}

function requirePendingLevel(ticketId, level) {
  return approvalTaskRepository.findPendingLevel(ticketId, level);
}

function correctiveActionsForTicket(ticketId) {
  return correctiveActionRepository.listByTicket(ticketId);
}

function correctionExtensionsForTicket(ticketId) {
  const rows = db.prepare(`
    SELECT *
    FROM correction_extensions
    WHERE ticket_id = ?
    ORDER BY extension_no ASC, created_at ASC, id ASC
  `).all(ticketId);
  return enrichCorrectionExtensionRows(rows);
}

function currentCorrectionDueDate(ticketId) {
  const row = db.prepare(`
    SELECT due_date
    FROM evaluation_nonconformities
    WHERE ticket_id = ?
      AND NULLIF(TRIM(COALESCE(due_date, '')), '') IS NOT NULL
      AND severity IN ('B', 'C', 'D')
      AND status != 'CANCELLED'
    ORDER BY date(due_date) DESC, updated_at DESC, id DESC
    LIMIT 1
  `).get(ticketId);
  return row?.due_date || null;
}

function reassessmentDueDateForTicket(row) {
  if (!row || row.current_status !== WAITING_CORRECTION_STATUS) return null;
  return currentCorrectionDueDate(row.id);
}

function nonconformitiesForTicket(ticketId) {
  return correctiveActionRepository.listNonconformitiesByTicket(ticketId);
}

function isProcessingStatus(status) {
  return [PROCESSING_STATUS, 'Đang xử lý', 'Dang xu ly'].includes(String(status || '').trim());
}

function roundForNonconformity(row) {
  if (!row?.round_id) return null;
  return db.prepare('SELECT id, round_no, correction_locked FROM evaluation_rounds WHERE id = ?').get(row.round_id);
}

function defaultCorrectionDueDate(ticket, round) {
  return calculateDefaultCorrectionDueDate({
    ticket,
    round,
    fallbackDate: calendarDateInTimeZone(new Date(), process.env.APP_TIMEZONE || 'Asia/Ho_Chi_Minh'),
  });
}

function correctionFieldsEditable(ticket, nonconformity = null) {
  if (!ticket || !isProcessingStatus(ticket.current_status)) return false;
  const round = roundForNonconformity(nonconformity);
  return !round || !round.correction_locked;
}

function correctionLockedPayload(ticket, nonconformity = null) {
  const round = roundForNonconformity(nonconformity);
  return {
    error: 'correction_fields_locked',
    current_status: ticket?.current_status || null,
    assessment_id: round?.id || nonconformity?.round_id || null,
    round_no: round?.round_no || null,
  };
}

function categorySummaryForTicket(ticketId) {
  return db.prepare(`
    SELECT
      er.round_no,
      q.category,
      COUNT(*) AS total,
      SUM(CASE WHEN a.score = 'A' THEN 1 ELSE 0 END) AS a_count,
      SUM(CASE WHEN a.score = 'B' THEN 1 ELSE 0 END) AS b_count,
      SUM(CASE WHEN a.score = 'C' THEN 1 ELSE 0 END) AS c_count,
      SUM(CASE WHEN a.score = 'D' THEN 1 ELSE 0 END) AS d_count,
      SUM(CASE WHEN a.score = 'NA' THEN 1 ELSE 0 END) AS na_count,
      AVG(a.calculated_score) AS average_score
    FROM evaluation_answers a
    JOIN evaluation_rounds er ON er.id = a.round_id
    JOIN pinned_evaluation_questions q ON q.ticket_id = er.ticket_id AND q.id = a.question_id
    WHERE er.ticket_id = ?
      AND er.round_no = (
        SELECT MAX(round_no)
        FROM evaluation_rounds
        WHERE ticket_id = ?
          AND completed_at IS NOT NULL
      )
    GROUP BY er.round_no, q.category
    ORDER BY q.category
  `).all(ticketId, ticketId);
}

function attachmentsForTicket(ticketId) {
  const rows = evaluationAttachmentService.listForTicket(ticketId)
    .map((row) => ({
      ...mapAttachment(row),
      kind: legalAttachmentKind(row.storage_key),
      round_no: row.round_no,
      question_code: row.question_code,
      category: row.category,
    }));
  return enrichAttachmentRows(rows);
}

function rejectionHistoryForTicket(ticketId) {
  return enrichWorkflowHistoryRows(workflowHistoryRepository.rejectionHistory(ticketId));
}

function syncRoundNonconformities(ticket, round, questions, answers, userEmail) {
  const byQuestionId = new Map(questions.map((q) => [String(q.db_id), q]));
  const existingRows = db.prepare(`
    SELECT * FROM evaluation_nonconformities
    WHERE ticket_id = ? AND round_id = ?
  `).all(ticket.id, round.id);
  const existingByQuestion = new Map(existingRows.map((row) => [String(row.question_id), row]));
  const activeQuestionIds = new Set();
  const insert = db.prepare(`
    INSERT INTO evaluation_nonconformities (
      ticket_id, round_id, question_id, clause_code, category,
      due_date, severity, status, created_by, updated_by,
      evaluation_answer_id, nonconformity_content, remediation_content
    )
    VALUES (
      @ticket_id, @round_id, @question_id, @clause_code, @category,
      @due_date, @severity, @status, @created_by, @updated_by,
      @evaluation_answer_id, @nonconformity_content, @remediation_content
    )
  `);
  const update = db.prepare(`
    UPDATE evaluation_nonconformities
    SET clause_code=@clause_code,
        category=@category,
        nonconformity_content=@nonconformity_content,
        evaluation_answer_id=COALESCE(evaluation_answer_id, @evaluation_answer_id),
        remediation_content=COALESCE(remediation_content, @remediation_content),
        severity=@severity,
        due_date=COALESCE(due_date, @due_date),
        updated_at=datetime('now'),
        updated_by=@updated_by
    WHERE id=@id
  `);
  const defaultDueDate = Number(round?.round_no) === 1 ? defaultCorrectionDueDate(ticket, round) : null;

  Object.entries(answers || {}).forEach(([questionId, answer]) => {
    if (!['B', 'C', 'D'].includes(answer.score)) return;
    const question = byQuestionId.get(String(questionId));
    if (!question) return;
    activeQuestionIds.add(String(questionId));
    const existing = existingByQuestion.get(String(questionId));
    const payload = {
      id: existing?.id,
      ticket_id: ticket.id,
      round_id: round.id,
      question_id: parseInt(questionId, 10),
      clause_code: question.question_code,
      category: question.section_name,
      nonconformity_content: String(answer.comment || answer.note || question.text || '').trim(),
      evaluation_answer_id: answer.answer_id || null,
      remediation_content: existing?.remediation_content || null,
      due_date: existing?.due_date || defaultDueDate,
      severity: answer.score,
      status: existing?.status || 'OPEN',
      created_by: existing?.created_by || userEmail,
      updated_by: userEmail,
    };
    if (existing) update.run(payload);
    else insert.run(payload);
  });

  existingRows.forEach((row) => {
    if (!activeQuestionIds.has(String(row.question_id))) {
      db.prepare('DELETE FROM evaluation_nonconformities WHERE id = ?').run(row.id);
    }
  });
}

function missingRequiredNonconformityActions(ticketId, roundId = null) {
  const sql = `
    SELECT id, clause_code, category, severity, remediation_content AS remediation, due_date
    FROM evaluation_nonconformities
    WHERE ticket_id = ?
      AND severity IN ('B', 'C', 'D')
      AND (NULLIF(TRIM(COALESCE(remediation_content, '')), '') IS NULL OR NULLIF(TRIM(COALESCE(due_date, '')), '') IS NULL)
      ${roundId ? 'AND round_id = ?' : ''}
    ORDER BY category, clause_code, id
  `;
  return roundId ? db.prepare(sql).all(ticketId, roundId) : db.prepare(sql).all(ticketId);
}

function workflowHistoryForTicket(ticketId) {
  return enrichWorkflowHistoryRows(workflowHistoryRepository.listByTicket(ticketId));
}

function approvalTasksForTicket(ticketId) {
  return enrichApprovalTasks(approvalTaskRepository.listByTicket(ticketId));
}

function ticketRequiresCorrection(ticket) {
  const roundNo = ticket.completed_round || ticket.current_round_no || 1;
  if (roundNo >= 2) return false;
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM evaluation_nonconformities nc
    JOIN evaluation_rounds er ON er.id = nc.round_id
    WHERE nc.ticket_id = ?
      AND er.round_no = ?
      AND nc.severity IN ('B', 'C', 'D')
      AND nc.status != 'CANCELLED'
  `).get(ticket.id, roundNo);
  return (row?.count || 0) > 0;
}

function ensureRound(ticket, roundNo, user) {
  return evaluationScoringService.ensureRound(ticket, roundNo, user);
}



function mapAttachment(row) {
  return {
    id: row.id,
    answer_id: row.answer_id,
    ticket_id: row.ticket_id,
    file_name: row.file_name,
    file_path: row.file_path,
    storage_key: row.storage_key,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at,
    download_url: `/qlcl/api/evaluations/attachments/${row.id}/download`,
  };
}

function legalAttachmentKind(storageKey) {
  const key = String(storageKey || '');
  if (key.startsWith('LEGAL:business_license:')) return 'business_license';
  if (key.startsWith('LEGAL:attp_certificate:')) return 'attp_certificate';
  return null;
}

function attachLegalFiles(ticketId, files, userEmail) {
  return evaluationAttachmentService.attachLegalFiles(ticketId, files, userEmail);
}

function answersForRound(roundId) {
  return evaluationScoringService.answersForRound(roundId);
}

function readonlyInheritedAnswers(ticketId, roundNo) {
  return evaluationScoringService.readonlyInheritedAnswers(ticketId, roundNo);
}

function applyRoundReadonly(ticket, roundNo, answers) {
  return evaluationScoringService.applyRoundReadonly(ticket, roundNo, answers);
}

function validateRoundReadonlyChanges(ticket, roundNo, incomingAnswers) {
  return evaluationScoringService.validateRoundReadonlyChanges(ticket, roundNo, incomingAnswers);
}

function seedRound2AnswersFromRound1(ticket, round, userEmail) {
  return evaluationScoringService.seedRound2AnswersFromRound1(ticket, round, userEmail);
}

function upsertRoundAnswers(round, answers, userEmail) {
  return evaluationScoringService.upsertRoundAnswers(round, answers, userEmail);
}

function roundPayload(ticket, round) {
  return evaluationScoringService.roundPayload(ticket, round);
}

evaluationWorkflowService = new EvaluationWorkflowService({
  db,
  ticketRepository,
  approvalTaskRepository,
  workflowHistoryRepository,
  missingRequiredNonconformityActions,
  ticketRequiresCorrection,
  sendEmail,
  buildWorkflowEmail,
  policyService,
  approvalAssignmentService,
  notificationService,
});

evaluationAttachmentService = new EvaluationAttachmentService({
  db,
  attachmentRepository,
  answerRepository,
  removeLocalFile,
  mapAttachment,
});

evaluationScoringService = new EvaluationScoringService({
  db,
  ticketRepository,
  roundRepository,
  answerRepository,
  participantRepository,
  attachmentRepository,
  logWorkflow,
  mapTicket: mapTicketForResponse,
  mapAttachment,
  questionsForTicket,
  nonconformitiesForTicket,
  syncRoundNonconformities,
  missingRequiredNonconformityActions,
  pendingApprovalTask,
  policyService,
  statuses: {
    DRAFT_STATUS,
    PROCESSING_STATUS,
    WAITING_CORRECTION_STATUS,
    ROUND_2_STATUS,
    COMPLETED_STATUS,
  },
});

evaluationTicketService = new EvaluationTicketService({
  db,
  ticketRepository,
  roundRepository,
  logWorkflow,
  attachLegalFiles,
  policyService,
  detailProviders: {
    attachmentsForTicket,
    correctiveActionsForTicket,
    correctionExtensionsForTicket,
    nonconformitiesForTicket,
    categorySummaryForTicket,
    assessmentRoundsForTicket,
    approvalTasksForTicket,
    workflowHistoryForTicket,
    rejectionHistoryForTicket,
  },
});

router.get('/bootstrap', (req, res) => {
  const rows = evaluationTicketService.listBootstrap(req.user);
  res.json({
    tickets: mapTicketsForResponse(rows, req.user),
    questions: activeQuestions(),
    answers: clone(mock.answers),
  });
});

router.get('/', (req, res) => {
  try {
    const result = evaluationTicketService.listTickets(req.query, req.user);
    res.json({
      tickets: mapTicketsForResponse(result.rows, req.user),
      total: result.total,
      page: result.page,
      page_size: result.pageSize,
      total_pages: result.totalPages,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'ticket_list_failed' });
  }
});

router.get('/previous-defaults', (req, res) => {
  try {
    const item = evaluationTicketService.getPreviousEvaluationDefaults({
      supplierId: req.query.supplier_id,
      evaluationType: req.query.evaluation_type,
      user: req.user,
    });
    res.json({ item });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'evaluation_previous_defaults_failed' });
  }
});

router.post('/export-summary', canExportEvaluation, (req, res) => {
  try {
    const body = req.body || {};
    const exported = exportEvaluationSummaryXlsx(db, {
      filters: {
        ...(body.filters || {}),
        sort: body.sort || {},
      },
      scope: evaluationTicketService.workspaceScopeForUser(req.user, 't'),
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', exported.content_disposition);
    res.setHeader('X-Export-Row-Count', String(exported.row_count));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    logger.info('[evaluation-summary-export]', {
      exported_by: req.user.email,
      report_type: 'EVALUATION_SUMMARY_XLSX',
      row_count: exported.row_count,
      filters: {
        date_type: body.filters?.dateType || null,
        type: body.filters?.type || null,
        status: body.filters?.status || null,
        mch2: body.filters?.mch2 || null,
        mch3: body.filters?.mch3 || null,
        from: body.filters?.from || null,
        to: body.filters?.to || null,
        reassessment: body.filters?.reassessment || null,
        has_query: Boolean(body.filters?.q),
      },
    });
    Readable.from([exported.buffer]).pipe(res);
  } catch (e) {
    if ((e.status || 500) >= 500) logger.error('[evaluation-summary-export]', e.message);
    res.status(e.status || 500).json({ error: e.code || 'evaluation_summary_export_failed' });
  }
});

router.get('/:ticketId/history', (req, res) => {
  const ticket = visibleTicketOrResponse(req, res, req.params.ticketId);
  if (!ticket) return;
  res.json({ history: workflowHistoryForTicket(ticket.id) });
});

router.get('/:ticketId/assessments', (req, res) => {
  const ticket = visibleTicketOrResponse(req, res, req.params.ticketId);
  if (!ticket) return;
  res.json({ assessments: assessmentRoundsForTicket(ticket) });
});

router.get('/attachments/:attachmentId/download', (req, res) => {
  const attachment = evaluationAttachmentService.getDownloadAttachment(parseInt(req.params.attachmentId, 10));
  if (!attachment) return res.status(404).json({ error: 'attachment_not_found' });
  const ticket = attachment.ticket_id ? ticketRepository.getById(attachment.ticket_id) : null;
  try { evaluationTicketService.assertDetailVisible(ticket, req.user); }
  catch (error) { return policyErrorResponse(res, error, req); }
  if (!attachment.file_path || !fs.existsSync(attachment.file_path)) return res.status(404).json({ error: 'file_not_found' });
  res.download(attachment.file_path, attachment.file_name || path.basename(attachment.file_path));
});

router.get('/:code', (req, res) => {
  let detail;
  try {
    detail = evaluationTicketService.getTicketDetail(req.params.code, req.user);
    if (!detail) return res.status(404).json({ error: 'ticket_not_found' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.code || 'ticket_detail_failed' });
  }
  res.json({
    ticket: mapTicketForResponse(detail.row, req.user),
    corrective_actions: detail.corrective_actions,
    correction_extensions: detail.correction_extensions,
    nonconformities: detail.nonconformities,
    category_summary: detail.category_summary,
    attachments: detail.attachments,
    assessments: detail.assessments,
    legal_attachments: detail.legal_attachments,
    approval_tasks: detail.approval_tasks,
    workflow_history: detail.workflow_history,
    rejection_history: detail.rejection_history,
  });
});

router.post('/:ticketId/reports/:templateId/export-pdf', canExportEvaluation, (req, res) => {
  const ticket = responsibleTicketOrResponse(req, res, req.params.ticketId);
  if (!ticket) return;
  const template = db.prepare('SELECT * FROM report_templates WHERE id = ? AND active = 1').get(parseInt(req.params.templateId, 10));
  if (!template) return res.status(404).json({ error: 'template_not_found' });
  try {
    const roundNo = roundNoFromBody(req.body);
    const alias = resolveReportAlias(template.report_type, { roundNo });
    const reportType = alias.canonical_code || alias.legacy_source;
    const exported = withReportIdentity(isCanonicalDefinition(reportType)
      ? exportCanonicalForRequest(req, { ticket, definitionCode: reportType, format: 'PDF', exportedBy: req.user.email, roundNo }, alias)
      : exportReportPdf(db, { ticket, template, reportType, exportedBy: req.user.email, roundNo }), alias);
    logWorkflow(ticket.id, req.user, 'REPORT_EXPORT', ticket.current_status, ticket.current_status, JSON.stringify({
      report_template_id: template.id,
      report_type: template.report_type,
      export_id: exported.id,
      round_no: roundNo || exported.round_no || null,
    }));
    sendExportArtifact(res, exported);
  } catch (e) {
    logger.error('[report-export]', e.message);
    res.status(e.status || 500).json(businessErrorPayload(e?.code ? e : 'report_export_failed'));
  }
});

router.post('/:ticketId/reports/export-pdf', canExportEvaluation, (req, res) => {
  const ticket = responsibleTicketOrResponse(req, res, req.params.ticketId);
  if (!ticket) return;
  const request = reportRequestFromBody(req.body);
  const reportType = request.reportType;
  const template = isCanonicalDefinition(reportType) ? null : defaultReportTemplate(reportType);
  if (!isCanonicalDefinition(reportType) && !template) {
    return res.status(404).json(businessErrorPayload('template_not_found'));
  }
  try {
    const exported = withReportIdentity(isCanonicalDefinition(reportType)
      ? exportCanonicalForRequest(req, { ticket, definitionCode: reportType, format: 'PDF', exportedBy: req.user.email, roundNo: request.roundNo }, request.alias)
      : exportReportPdf(db, { ticket, template, reportType, exportedBy: req.user.email, roundNo: request.roundNo }), request.alias);
    logWorkflow(ticket.id, req.user, 'REPORT_EXPORT_PDF', ticket.current_status, ticket.current_status, JSON.stringify(exportResponse(exported)));
    sendExportArtifact(res, exported);
  } catch (e) {
    logger.error('[report-export-pdf]', e.message);
    res.status(e.status || 500).json(businessErrorPayload(e?.code ? e : 'report_export_failed'));
  }
});

router.post('/:ticketId/reports/export-excel', canExportEvaluation, (req, res) => {
  const ticket = responsibleTicketOrResponse(req, res, req.params.ticketId);
  if (!ticket) return;
  const request = reportRequestFromBody(req.body);
  const reportType = request.reportType;
  const template = isCanonicalDefinition(reportType) ? null : defaultReportTemplate(reportType);
  try {
    const exported = withReportIdentity(isCanonicalDefinition(reportType)
      ? exportCanonicalForRequest(req, { ticket, definitionCode: reportType, format: 'XLSX', exportedBy: req.user.email, roundNo: request.roundNo }, request.alias)
      : exportReportXlsx(db, { ticket, template, reportType, exportedBy: req.user.email, roundNo: request.roundNo }), request.alias);
    logWorkflow(ticket.id, req.user, 'REPORT_EXPORT_XLSX', ticket.current_status, ticket.current_status, JSON.stringify(exportResponse(exported)));
    sendExportArtifact(res, exported);
  } catch (e) {
    logger.error('[report-export-xlsx]', e.message);
    res.status(e.status || 500).json(businessErrorPayload(e?.code ? e : 'report_export_failed'));
  }
});

router.post('/:ticketId/reports/export-print', canExportEvaluation, (req, res) => {
  const ticket = responsibleTicketOrResponse(req, res, req.params.ticketId);
  if (!ticket) return;
  const request = reportRequestFromBody(req.body);
  const reportType = request.reportType;
  const template = isCanonicalDefinition(reportType) ? null : defaultReportTemplate(reportType);
  try {
    const exported = withReportIdentity(isCanonicalDefinition(reportType)
      ? exportCanonicalForRequest(req, { ticket, definitionCode: reportType, format: 'HTML', exportedBy: req.user.email, roundNo: request.roundNo }, request.alias)
      : exportReportHtml(db, { ticket, template, reportType, exportedBy: req.user.email, roundNo: request.roundNo }), request.alias);
    logWorkflow(ticket.id, req.user, 'REPORT_EXPORT_HTML', ticket.current_status, ticket.current_status, JSON.stringify(exportResponse(exported)));
    sendExportArtifact(res, exported);
  } catch (e) {
    logger.error('[report-export-html]', e.message);
    res.status(e.status || 500).json(businessErrorPayload(e?.code ? e : 'report_export_failed'));
  }
});

router.put('/:ticketId/nonconformities/:nonconformityId', canEditEvaluation, (req, res) => {
  const ticket = visibleTicketOrResponse(req, res, req.params.ticketId);
  if (!ticket) return;
  const id = parseInt(req.params.nonconformityId, 10);
  const existing = correctiveActionRepository.getNonconformityForTicket(id, ticket.id);
  if (!existing) return res.status(404).json({ error: 'nonconformity_not_found' });
  if (!correctionFieldsEditable(ticket, existing)) {
    return res.status(423).json(correctionLockedPayload(ticket, existing));
  }
  const body = req.body || {};
  const status = String(body.status || existing.status || 'OPEN').trim();
  if (!['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }
  const dueDate = Object.prototype.hasOwnProperty.call(body, 'due_date') ? String(body.due_date || '').trim() : existing.due_date;
  if (dueDate && !isValidISODate(dueDate)) return res.status(400).json({ error: 'due_date_invalid' });
  const remediation = Object.prototype.hasOwnProperty.call(body, 'remediation')
    ? String(body.remediation || '').trim()
    : existing.remediation_content;
  if (remediation && !CORRECTIVE_REQUIREMENT_OPTIONS.has(remediation)) return res.status(400).json({ error: 'invalid_remediation' });
  correctiveActionRepository.updateNonconformityProposal({
    id,
    ticket_id: ticket.id,
    remediation: remediation || null,
    due_date: dueDate || null,
    status,
    updated_by: req.user.email,
  });
  logWorkflow(ticket.id, req.user, 'NONCONFORMITY_UPDATE', ticket.current_status, ticket.current_status, `NC#${id}`);
  res.json({
    item: nonconformitiesForTicket(ticket.id).find((item) => item.id === id),
    ticket: mapTicketForResponse(getTicketRowByCode(ticket.ticket_code), req.user),
  });
});

router.post('/:ticketId/extensions', canEditEvaluation, (req, res) => {
  const ticket = visibleTicketOrResponse(req, res, req.params.ticketId);
  if (!ticket) return;
  if (!round2NotPassed(ticket)) {
    return res.status(400).json({ error: 'round_2_not_passed_required' });
  }
  const reason = String(req.body?.reason || '').trim();
  const newDueDate = String(req.body?.new_due_date || req.body?.proposed_due_date || '').trim();
  if (!reason) return res.status(400).json({ error: 'extension_reason_required' });
  if (!newDueDate) return res.status(400).json({ error: 'extension_due_date_required' });
  if (!isValidISODate(newDueDate)) return res.status(400).json({ error: 'extension_due_date_invalid' });
  const created = db.transaction(() => {
    const oldDueDate = currentCorrectionDueDate(ticket.id);
    const nextNo = (db.prepare('SELECT COALESCE(MAX(extension_no), 0) + 1 AS n FROM correction_extensions WHERE ticket_id = ?').get(ticket.id).n) || 1;
    const info = db.prepare(`
      INSERT INTO correction_extensions (ticket_id, extension_no, old_due_date, new_due_date, reason, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ticket.id, nextNo, oldDueDate, newDueDate, reason, req.user.email);
    db.prepare(`
      UPDATE evaluation_nonconformities
      SET due_date = @new_due_date,
          status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
          updated_at = datetime('now'),
          updated_by = @actor
      WHERE ticket_id = @ticket_id
        AND severity IN ('B', 'C', 'D')
        AND status IN ('OPEN', 'IN_PROGRESS')
    `).run({ ticket_id: ticket.id, new_due_date: newDueDate, actor: req.user.email });
    db.prepare("UPDATE evaluation_tickets SET current_status=?, updated_at=datetime('now'), updated_by=? WHERE id=?")
      .run(EXTENDED_STATUS, req.user.email, ticket.id);
    logWorkflow(ticket.id, req.user, 'CORRECTION_EXTENSION', ticket.current_status, EXTENDED_STATUS, JSON.stringify({
      extension_no: nextNo,
      old_due_date: oldDueDate,
      new_due_date: newDueDate,
      reason,
    }));
    return db.prepare('SELECT * FROM correction_extensions WHERE id = ?').get(info.lastInsertRowid);
  })();
  const updated = getTicketRowByCode(ticket.ticket_code);
  res.status(201).json({
    item: created,
    ticket: mapTicketForResponse(updated, req.user),
    correction_extensions: correctionExtensionsForTicket(ticket.id),
    nonconformities: nonconformitiesForTicket(ticket.id),
    workflow_history: workflowHistoryForTicket(ticket.id),
  });
});

router.post('/:ticketId/proposals', canEditEvaluation, (req, res) => {
  const ticket = visibleTicketOrResponse(req, res, req.params.ticketId);
  if (!ticket) return;
  const body = req.body || {};
  const type = String(body.type || '').trim();
  if (!['EXTENSION', 'SUSPENSION'].includes(type)) return res.status(400).json({ error: 'invalid_proposal_type' });
  if (!round2NotPassed(ticket)) {
    return res.status(400).json({ error: 'round_2_not_passed_required' });
  }
  if (pendingApprovalTask(ticket.id)) return res.status(409).json({ error: 'pending_approval_exists' });
  if (!String(body.reason || '').trim() || !String(body.comment || '').trim()) return res.status(400).json({ error: 'reason_and_comment_required' });
  if (type === 'EXTENSION' && !String(body.proposed_due_date || '').trim()) return res.status(400).json({ error: 'proposed_due_date_required' });
  if (type === 'SUSPENSION' && !String(body.business_impact || '').trim()) return res.status(400).json({ error: 'business_impact_required' });
  createTbpTask(ticket, req.user, type, {
    reason: String(body.reason).trim(),
    proposed_due_date: String(body.proposed_due_date || '').trim() || null,
    business_impact: String(body.business_impact || '').trim() || null,
    comment: String(body.comment).trim(),
  }, WORKFLOW_STATUSES.WAITING_TBP);
  res.status(201).json({ ticket: mapTicketForResponse(getTicketRowByCode(ticket.ticket_code), req.user), approval_tasks: approvalTasksForTicket(ticket.id) });
});

router.post('/:ticketId/cancel-request', canEditEvaluation, (req, res) => {
  try {
    const result = evaluationWorkflowService.cancelRequest({ ticketId: req.params.ticketId, body: req.body, user: req.user });
    res.status(201).json({ ticket: mapTicketForResponse(result.ticket, req.user), approval_tasks: enrichApprovalTasks(result.approval_tasks) });
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'cancel_request_failed' });
  }
});

router.post('/:ticketId/submit-to-lead', canEditEvaluation, (req, res) => {
  try {
    const result = evaluationWorkflowService.submitToLead({ ticketId: req.params.ticketId, body: req.body, user: req.user });
    res.status(201).json({ ticket: mapTicketForResponse(result.ticket, req.user), approval_tasks: enrichApprovalTasks(result.approval_tasks), workflow_history: enrichWorkflowHistoryRows(result.workflow_history) });
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'submit_to_lead_failed' });
  }
});

router.post('/:ticketId/lead-approve', requireApproval('EVALUATION', 'LEAD', (req) => resourceContext(getTicketByIdentifier(req.params.ticketId))), (req, res) => {
  try {
    const result = evaluationWorkflowService.leadApprove({ ticketId: req.params.ticketId, body: req.body, user: req.user });
    res.json({ ticket: mapTicketForResponse(result.ticket, req.user), approval_tasks: enrichApprovalTasks(result.approval_tasks), workflow_history: enrichWorkflowHistoryRows(result.workflow_history) });
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'lead_approve_failed' });
  }
});

router.post('/:ticketId/lead-reject', requireApproval('EVALUATION', 'LEAD', (req) => resourceContext(getTicketByIdentifier(req.params.ticketId))), (req, res) => {
  try {
    const result = evaluationWorkflowService.leadReject({ ticketId: req.params.ticketId, body: req.body, user: req.user });
    res.json({ ticket: mapTicketForResponse(result.ticket, req.user), approval_tasks: enrichApprovalTasks(result.approval_tasks), workflow_history: enrichWorkflowHistoryRows(result.workflow_history) });
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'lead_reject_failed' });
  }
});

router.post('/:ticketId/tbp-reject', requireApproval('EVALUATION', 'TBP', (req) => resourceContext(getTicketByIdentifier(req.params.ticketId))), (req, res) => {
  try {
    const result = evaluationWorkflowService.tbpReject({ ticketId: req.params.ticketId, body: req.body, user: req.user });
    res.json({ ticket: mapTicketForResponse(result.ticket, req.user), approval_tasks: enrichApprovalTasks(result.approval_tasks), workflow_history: enrichWorkflowHistoryRows(result.workflow_history) });
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'tbp_reject_failed' });
  }
});

router.post('/:ticketId/tbp-send-gdk', requireApproval('EVALUATION', 'TBP', (req) => resourceContext(getTicketByIdentifier(req.params.ticketId))), (req, res) => {
  try {
    const result = evaluationWorkflowService.tbpSendGdk({ ticketId: req.params.ticketId, body: req.body, user: req.user });
    res.json({ ticket: mapTicketForResponse(result.ticket, req.user), approval_tasks: enrichApprovalTasks(result.approval_tasks), workflow_history: enrichWorkflowHistoryRows(result.workflow_history) });
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'tbp_send_gdk_failed' });
  }
});

router.post('/:ticketId/tbp-approve', requireApproval('EVALUATION', 'TBP', (req) => resourceContext(getTicketByIdentifier(req.params.ticketId))), (req, res) => {
  try {
    const result = evaluationWorkflowService.tbpApprove({ ticketId: req.params.ticketId, body: req.body, user: req.user });
    res.json({ ticket: mapTicketForResponse(result.ticket, req.user), approval_tasks: enrichApprovalTasks(result.approval_tasks), workflow_history: enrichWorkflowHistoryRows(result.workflow_history) });
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'tbp_approve_failed' });
  }
});

router.post('/:ticketId/gdk-reject', requireApproval('EVALUATION', 'GDK', (req) => resourceContext(getTicketByIdentifier(req.params.ticketId))), (req, res) => {
  try {
    const result = evaluationWorkflowService.gdkReject({ ticketId: req.params.ticketId, body: req.body, user: req.user });
    res.json({ ticket: mapTicketForResponse(result.ticket, req.user), approval_tasks: enrichApprovalTasks(result.approval_tasks), workflow_history: enrichWorkflowHistoryRows(result.workflow_history) });
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'gdk_reject_failed' });
  }
});

router.post('/:ticketId/gdk-approve', requireApproval('EVALUATION', 'GDK', (req) => resourceContext(getTicketByIdentifier(req.params.ticketId))), (req, res) => {
  try {
    const result = evaluationWorkflowService.gdkApprove({ ticketId: req.params.ticketId, body: req.body, user: req.user });
    res.json({ ticket: mapTicketForResponse(result.ticket, req.user), approval_tasks: enrichApprovalTasks(result.approval_tasks), workflow_history: enrichWorkflowHistoryRows(result.workflow_history) });
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'gdk_approve_failed' });
  }
});

router.post('/:ticketId/approval-tasks/:taskId/act', requireApproval('EVALUATION', (req) => {
  const ticket = getTicketByIdentifier(req.params.ticketId);
  return ticket ? approvalTaskRepository.findByIdAndTicket(parseInt(req.params.taskId, 10), ticket.id)?.approval_level : null;
}, (req) => resourceContext(getTicketByIdentifier(req.params.ticketId))), (req, res) => {
  try {
    const result = evaluationWorkflowService.actOnApprovalTask({
      ticketId: req.params.ticketId,
      taskId: req.params.taskId,
      body: req.body,
      user: req.user,
    });
    res.json({ ticket: mapTicketForResponse(result.ticket, req.user), approval_tasks: enrichApprovalTasks(result.approval_tasks), workflow_history: enrichWorkflowHistoryRows(result.workflow_history) });
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'approval_task_action_failed' });
  }
});

router.get('/:ticketId/rounds/:roundNo', (req, res) => {
  const roundNo = parseInt(req.params.roundNo, 10);
  try {
    res.json(withEvaluationActionEnvelope(
      evaluationScoringService.getRoundPayload({ ticketId: req.params.ticketId, roundNo, user: req.user }),
      req.user
    ));
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'round_load_failed' });
  }
});

router.put('/:ticketId/rounds/:roundNo/answers', canEditEvaluation, (req, res) => {
  const roundNo = parseInt(req.params.roundNo, 10);
  try {
    res.json(withEvaluationActionEnvelope(evaluationScoringService.updateAnswers({
      ticketId: req.params.ticketId,
      roundNo,
      answers: req.body?.answers || {},
      canonicalAnswers: req.body?.canonical_answers,
      attendees: req.body?.attendees,
      supplierIntroduction: req.body?.supplier_introduction,
      user: req.user,
    }), req.user));
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'round_answers_update_failed' });
  }
});

router.post('/:ticketId/rounds/:roundNo/complete', canEditEvaluation, (req, res) => {
  const roundNo = parseInt(req.params.roundNo, 10);
  try {
    res.json(withEvaluationActionEnvelope(evaluationScoringService.completeRound({
      ticketId: req.params.ticketId,
      roundNo,
      answers: req.body?.answers || null,
      canonicalAnswers: req.body?.canonical_answers,
      attendees: req.body?.attendees,
      supplierIntroduction: req.body?.supplier_introduction,
      finalAction: String(req.body?.final_action || '').trim(),
      user: req.user,
    }), req.user));
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'round_complete_failed' });
  }
});

router.post('/:ticketId/rounds/:roundNo/attachments', canEditEvaluation, upload.single('file'), (req, res) => {
  const ticket = getTicketByIdentifier(req.params.ticketId);
  if (!ticket) {
    if (req.file) removeLocalFile(req.file.path);
    return res.status(404).json({ error: 'ticket_not_found' });
  }
  try { policyService.assert(req.user, PERMISSIONS.EVALUATION_SCORE, { context: resourceContext(ticket) }); }
  catch (error) {
    if (req.file) removeLocalFile(req.file.path);
    return policyErrorResponse(res, error, req);
  }
  const roundNo = parseInt(req.params.roundNo, 10);
  const round = ensureRound(ticket, roundNo, req.user);
  if (!round) {
    if (req.file) removeLocalFile(req.file.path);
    return res.status(404).json({ error: 'round_not_found' });
  }
  if (round.locked_at) {
    if (req.file) removeLocalFile(req.file.path);
    return res.status(403).json({ error: 'round_locked' });
  }
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const canonicalQuestionItemId = parseInt(req.body?.question_item_id || '0', 10);
  let questionId = parseInt(req.body?.question_id || req.body?.questionId || '0', 10);
  if (canonicalQuestionItemId) {
    try {
      const normalized = evaluationScoringService.normalizeIncomingAnswers(ticket, {
        [String(canonicalQuestionItemId)]: {},
      }, true);
      questionId = parseInt(Object.keys(normalized)[0] || '0', 10);
    } catch (error) {
      removeLocalFile(req.file.path);
      return res.status(error.status || 400).json(error.payload || { error: 'question_not_in_ticket' });
    }
  }
  if (!questionId) {
    removeLocalFile(req.file.path);
    return res.status(400).json({ error: 'question_id_required' });
  }
  if (readonlyInheritedAnswers(ticket.id, roundNo)[String(questionId)]) {
    removeLocalFile(req.file.path);
    return res.status(400).json({ error: 'inherited_answer_readonly', question_ids: [String(questionId)] });
  }
  const uploaded = evaluationAttachmentService.uploadAnswerAttachment({ ticket, round, questionId, file: req.file, user: req.user });
  res.status(201).json({ attachment: uploaded.attachment, answer_id: uploaded.answer.id });
});

router.post('/', canCreateEvaluation, legalFileUpload, (req, res) => {
  const body = req.body || {};
  try {
    const created = evaluationTicketService.createTicket({ body, files: req.files, user: req.user });
    try {
      notificationService.createEvaluationAssigned({ ticket: created, actor: req.user });
    } catch (notificationError) {
      logger.error('evaluation.notification_dispatch_failed', {
        error: notificationError,
        ticket_code: created.ticket_code,
        notification_kind: 'ASSIGNED',
      });
    }
    res.status(201).json({ ticket: mapTicketForResponse(created, req.user) });
  } catch (e) {
    cleanupUploadedFiles(req.files);
    res.status(e.status || 500).json({ error: e.code || 'ticket_create_failed', errors: e.errors || undefined });
  }
});

router.put('/:code', canCreateEvaluation, legalFileUpload, (req, res) => {
  const body = req.body || {};
  try {
    const updated = evaluationTicketService.updateTicket({ code: req.params.code, body, files: req.files, user: req.user });
    res.json({ ticket: mapTicketForResponse(updated, req.user) });
  } catch (e) {
    cleanupUploadedFiles(req.files);
    res.status(e.status || 500).json({ error: e.code || 'ticket_update_failed', errors: e.errors || undefined });
  }
});

router.delete('/:code', canDeleteEvaluation, (req, res) => {
  const reason = String(req.body?.reason || req.query.reason || '').trim();
  try {
    res.json(evaluationTicketService.deleteTicket({ code: req.params.code, reason, user: req.user }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'ticket_delete_failed' });
  }
});

router.put('/:code/answers', canEditEvaluation, (req, res) => {
  const ticket = getTicketRowByCode(req.params.code);
  if (!ticket) return res.status(404).json({ error: 'ticket_not_found' });
  try { policyService.assert(req.user, PERMISSIONS.EVALUATION_SCORE, { context: resourceContext(ticket) }); }
  catch (error) { return policyErrorResponse(res, error, req); }
  mock.answers[req.params.code] = clone(req.body.answers || {});
  res.json({ answers: clone(mock.answers[req.params.code]) });
});

router.patch('/:code', (req, res) => {
  const ticket = getTicketRowByCode(req.params.code);
  if (!ticket) return res.status(404).json({ error: 'ticket_not_found' });
  try { policyService.assert(req.user, PERMISSIONS.EVALUATION_READ, { context: resourceContext(ticket) }); }
  catch (error) { return policyErrorResponse(res, error, req); }
  const body = req.body || {};
  if (body.workflow_status) {
    const nextStatus = String(body.workflow_status);
    const approvalStage = approvalStageForPatchTransition(ticket, nextStatus);
    if (approvalStage) {
      try {
        policyService.assertApproval(req.user, 'EVALUATION', approvalStage, resourceContext(ticket));
      } catch (error) {
        return policyErrorResponse(res, error, req);
      }
    }
    const scoringFields = [
      'score_percent', 'grade_code', 'result_label', 'result_reason', 'scoring_locked', 'completed_round',
      'corrected_score_percent', 'corrected_grade_code', 'corrected_result_label', 'correction_date',
      'next_evaluation_date', 'final_conclusion', 'specialist_proposal',
    ];
    const touchesScoring = scoringFields.some((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (touchesScoring && !policyService.has(req.user, PERMISSIONS.EVALUATION_SCORE)) return res.status(403).json({ error: 'forbidden_permission' });
    if (nextStatus === WORKFLOW_STATUSES.COMPLETED &&
        !policyService.has(req.user, PERMISSIONS.EVALUATION_APPROVE_TBP) &&
        !policyService.has(req.user, PERMISSIONS.EVALUATION_APPROVE_GDK) &&
        !policyService.has(req.user, PERMISSIONS.SYSTEM_ADMIN)) {
      if (!(policyService.has(req.user, PERMISSIONS.EVALUATION_SCORE) && specialistCanCloseCompletedScoring(ticket))) return res.status(403).json({ error: 'forbidden_permission' });
    }
    if (nextStatus === WORKFLOW_STATUSES.IN_PROGRESS &&
        ![PERMISSIONS.EVALUATION_SCORE, PERMISSIONS.EVALUATION_APPROVE_LEAD, PERMISSIONS.SYSTEM_ADMIN].some((p) => policyService.has(req.user, p))) return res.status(403).json({ error: 'forbidden_permission' });
    if (nextStatus === WORKFLOW_STATUSES.WAITING_TBP && !policyService.has(req.user, PERMISSIONS.EVALUATION_APPROVE_LEAD)) return res.status(403).json({ error: 'forbidden_permission' });
    if (nextStatus === WORKFLOW_STATUSES.WAITING_GDK && !policyService.has(req.user, PERMISSIONS.EVALUATION_APPROVE_TBP)) return res.status(403).json({ error: 'forbidden_permission' });
    if (nextStatus === WORKFLOW_STATUSES.WAITING_LEAD &&
        ![PERMISSIONS.EVALUATION_SCORE, PERMISSIONS.EVALUATION_APPROVE_TBP, PERMISSIONS.SYSTEM_ADMIN].some((p) => policyService.has(req.user, p))) return res.status(403).json({ error: 'forbidden_permission' });
  } else if (!policyService.has(req.user, PERMISSIONS.EVALUATION_SCORE)) {
    return res.status(403).json({ error: 'forbidden_permission' });
  }
  let correctionDate = body.correction_date ?? null;
  let nextEvaluationDate = body.next_evaluation_date ?? null;
  try {
    if (Object.prototype.hasOwnProperty.call(body, 'correction_date')) {
      correctionDate = assertValidDateField(body.correction_date, 'correction_date_invalid');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'next_evaluation_date')) {
      nextEvaluationDate = assertValidDateField(body.next_evaluation_date, 'next_evaluation_date_invalid');
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.code || 'validation_failed', errors: e.errors || undefined });
  }
  db.prepare(`
    UPDATE evaluation_tickets SET
      current_status = COALESCE(@workflow_status, current_status),
      score_percent = CASE WHEN @has_score_percent THEN @score_percent ELSE score_percent END,
      grade_code = CASE WHEN @has_grade_code THEN @grade_code ELSE grade_code END,
      result_label = CASE WHEN @has_result_label THEN @result_label ELSE result_label END,
      result_reason = CASE WHEN @has_result_reason THEN @result_reason ELSE result_reason END,
      corrected_score_percent = CASE WHEN @has_corrected_score_percent THEN @corrected_score_percent ELSE corrected_score_percent END,
      corrected_grade_code = CASE WHEN @has_corrected_grade_code THEN @corrected_grade_code ELSE corrected_grade_code END,
      corrected_result_label = CASE WHEN @has_corrected_result_label THEN @corrected_result_label ELSE corrected_result_label END,
      correction_date = CASE WHEN @has_correction_date THEN @correction_date ELSE correction_date END,
      next_evaluation_date = CASE WHEN @has_next_evaluation_date THEN @next_evaluation_date ELSE next_evaluation_date END,
      final_conclusion = CASE WHEN @has_final_conclusion THEN @final_conclusion ELSE final_conclusion END,
      specialist_proposal = CASE WHEN @has_specialist_proposal THEN @specialist_proposal ELSE specialist_proposal END,
      scoring_locked = CASE WHEN @has_scoring_locked THEN @scoring_locked ELSE scoring_locked END,
      completed_round = CASE WHEN @has_completed_round THEN @completed_round ELSE completed_round END,
      updated_at = datetime('now'),
      updated_by = @updated_by
    WHERE ticket_code = @ticket_code
  `).run({
    ticket_code: req.params.code,
    workflow_status: body.workflow_status || null,
    has_score_percent: Object.prototype.hasOwnProperty.call(body, 'score_percent') ? 1 : 0,
    score_percent: body.score_percent ?? null,
    has_grade_code: Object.prototype.hasOwnProperty.call(body, 'grade_code') ? 1 : 0,
    grade_code: body.grade_code ?? null,
    has_result_label: Object.prototype.hasOwnProperty.call(body, 'result_label') ? 1 : 0,
    result_label: body.result_label ?? null,
    has_result_reason: Object.prototype.hasOwnProperty.call(body, 'result_reason') ? 1 : 0,
    result_reason: body.result_reason ?? null,
    has_corrected_score_percent: Object.prototype.hasOwnProperty.call(body, 'corrected_score_percent') ? 1 : 0,
    corrected_score_percent: body.corrected_score_percent ?? null,
    has_corrected_grade_code: Object.prototype.hasOwnProperty.call(body, 'corrected_grade_code') ? 1 : 0,
    corrected_grade_code: body.corrected_grade_code ?? null,
    has_corrected_result_label: Object.prototype.hasOwnProperty.call(body, 'corrected_result_label') ? 1 : 0,
    corrected_result_label: body.corrected_result_label ?? null,
    has_correction_date: Object.prototype.hasOwnProperty.call(body, 'correction_date') ? 1 : 0,
    correction_date: correctionDate,
    has_next_evaluation_date: Object.prototype.hasOwnProperty.call(body, 'next_evaluation_date') ? 1 : 0,
    next_evaluation_date: nextEvaluationDate,
    has_final_conclusion: Object.prototype.hasOwnProperty.call(body, 'final_conclusion') ? 1 : 0,
    final_conclusion: body.final_conclusion ?? null,
    has_specialist_proposal: Object.prototype.hasOwnProperty.call(body, 'specialist_proposal') ? 1 : 0,
    specialist_proposal: body.specialist_proposal ?? null,
    has_scoring_locked: Object.prototype.hasOwnProperty.call(body, 'scoring_locked') ? 1 : 0,
    scoring_locked: body.scoring_locked ? 1 : 0,
    has_completed_round: Object.prototype.hasOwnProperty.call(body, 'completed_round') ? 1 : 0,
    completed_round: body.completed_round || null,
    updated_by: req.user.email,
  });
  const updatedTicket = getTicketRowByCode(req.params.code);
  if (body.workflow_status && body.workflow_status !== ticket.current_status) {
    logWorkflow(ticket.id, req.user, 'STATUS_CHANGE', ticket.current_status, updatedTicket.current_status, body.comment || null);
  }
  res.json({ ticket: mapTicketForResponse(updatedTicket, req.user) });
});

router.post('/:code/round-2', canEditEvaluation, (req, res) => {
  try {
    res.status(201).json(withEvaluationActionEnvelope(evaluationScoringService.createRound2({
      code: req.params.code,
      answers: req.body?.answers || null,
      canonicalAnswers: req.body?.canonical_answers,
      user: req.user,
    }), req.user));
  } catch (e) {
    res.status(e.status || 500).json(e.payload || { error: 'round_2_create_failed' });
  }
});

module.exports = router;
