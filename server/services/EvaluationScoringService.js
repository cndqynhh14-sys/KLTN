const {
  finalConclusionFromScore,
  validateScoringAnswers,
} = require('../domain/evaluationRules');
const {
  buildEvaluationResultWithPolicy,
  calculateWithPolicy,
  definitionChecksum,
  leadSubmissionEligibilityWithPolicy,
  stableJson,
} = require('../scoring/scoringPolicyEngine');
const ScoringPolicyRepository = require('../scoring/ScoringPolicyRepository');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { resourceContext } = require('./PolicyService');
const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');
const logger = require('../logger');
const { assertTicketMutable } = require('../domain/historicalEvaluation');
const { resolveUserId } = require('../domain/userIdentity');

function calculatedScore(score, definition) {
  const value = definition?.score_values?.[score];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeAttendee(value) {
  return {
    name: String(value?.name || value?.title || '').trim(),
    user_id: String(value?.user_id || '').trim() || null,
    opening: !!(value?.opening || value?.opening_meeting),
    closing: !!(value?.closing || value?.closing_meeting),
  };
}

function normalizeAttendees(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeAttendee).filter((row) => row.name || row.opening || row.closing);
}

function normalizeSupplierIntroduction(value) {
  return String(value == null ? '' : value).trim();
}

class EvaluationScoringService {
  constructor({
    db,
    ticketRepository,
    roundRepository,
    answerRepository,
    participantRepository,
    attachmentRepository,
    logWorkflow,
    mapTicket,
    mapAttachment,
    questionsForTicket,
    nonconformitiesForTicket,
    syncRoundNonconformities,
    missingRequiredNonconformityActions,
    pendingApprovalTask,
    statuses,
    policyService,
    scoringPolicyRepository = null,
  }) {
    this.db = db;
    this.ticketRepository = ticketRepository;
    this.roundRepository = roundRepository;
    this.answerRepository = answerRepository;
    this.participantRepository = participantRepository;
    this.attachmentRepository = attachmentRepository;
    this.logWorkflow = logWorkflow;
    this.mapTicket = mapTicket;
    this.mapAttachment = mapAttachment;
    this.questionsForTicket = questionsForTicket;
    this.nonconformitiesForTicket = nonconformitiesForTicket;
    this.syncRoundNonconformities = syncRoundNonconformities;
    this.missingRequiredNonconformityActions = missingRequiredNonconformityActions;
    this.pendingApprovalTask = pendingApprovalTask;
    this.statuses = statuses;
    this.policyService = policyService;
    this.scoringPolicyRepository = scoringPolicyRepository || new ScoringPolicyRepository(db);
    this.statements = {
      ticketToProcessing: db.prepare("UPDATE evaluation_tickets SET current_status=?, updated_at=datetime('now'), updated_by=? WHERE id=?"),
      updateRound1TicketResult: db.prepare(`
        UPDATE evaluation_tickets
        SET current_status=@processing_status, current_round_no=@round_no, completed_round=@round_no,
            actual_evaluation_date=@actual_evaluation_date,
            score_percent=@score_percent, grade_code=@grade_code, result_label=@result_label,
            corrected_score_percent=NULL, corrected_grade_code=NULL, corrected_result_label=NULL,
            correction_date=NULL, next_evaluation_date=@next_evaluation_date,
            final_conclusion=@final_conclusion, result_reason=@result_reason,
            scoring_locked=1, updated_at=datetime('now'), updated_by=@updated_by
        WHERE id=@ticket_id
      `),
      updateRound2TicketResult: db.prepare(`
        UPDATE evaluation_tickets
        SET current_status=@processing_status, current_round_no=@round_no, completed_round=@round_no,
            corrected_score_percent=@score_percent, corrected_grade_code=@grade_code,
            corrected_result_label=@result_label, correction_date=@correction_date,
            next_evaluation_date=@next_evaluation_date, final_conclusion=@final_conclusion,
            result_reason=@result_reason, scoring_locked=1, updated_at=datetime('now'), updated_by=@updated_by
        WHERE id=@ticket_id
      `),
      openRound2Ticket: db.prepare(`
        UPDATE evaluation_tickets SET current_round_no=2, current_status=@status,
          scoring_locked=0, updated_at=datetime('now'), updated_by=@updated_by
        WHERE id=@ticket_id
      `),
      updateSupplierIntroduction: db.prepare(`
        UPDATE evaluation_tickets
        SET supplier_introduction=@supplier_introduction, updated_at=datetime('now'), updated_by=@updated_by
        WHERE id=@ticket_id
      `),
    };
  }

  assessmentCode(ticket, roundNo) {
    return `${ticket.ticket_code}-R${roundNo}`;
  }

  getRound(ticketId, roundNo) {
    return this.roundRepository.getByTicketAndRound(ticketId, roundNo);
  }

  roundParticipantResolution(round) {
    const resolution = this.participantRepository?.resolveRoundParticipants(round.id)
      || { participants: [], source: 'NONE', mismatch: false, mismatch_count: 0, fallback_count: 0 };
    if (resolution.mismatch) {
      logger.warn('evaluation.canonical_read_mismatch', {
        resource_type: 'round_participant',
        ticket_id: round.ticket_id,
        round_id: round.id,
        mismatch_count: resolution.mismatch_count,
        fallback_count: resolution.fallback_count,
      });
    }
    return resolution;
  }

  mapAssessmentRound(ticket, round) {
    const participantResolution = this.roundParticipantResolution(round);
    const evaluator = participantResolution.participants
      .find((participant) => participant.participant_role === 'EVALUATOR');
    const canonicalAttendees = participantResolution.participants
      .filter((participant) => participant.participant_role === 'ATTENDEE')
      .map((participant) => ({
        name: participant.display_name,
        ...(participant.user_id ? { user_id: participant.user_id } : {}),
        opening: !!participant.opening_meeting,
        closing: !!participant.closing_meeting,
      }));
    const attendees = canonicalAttendees;
    return {
      id: round.id,
      assessment_code: round.assessment_code || this.assessmentCode(ticket, round.round_no),
      label: `Đánh giá lần ${String(round.round_no).padStart(3, '0')}`,
      round_no: round.round_no,
      source_assessment_id: round.source_round_id || null,
      source_assessment_code: round.source_assessment_code || (round.source_round_no ? this.assessmentCode(ticket, round.source_round_no) : null),
      source_round_no: round.source_round_no || null,
      status: round.status,
      assessment_date: round.assessment_date || String(round.completed_at || round.started_at || '').slice(0, 10),
      evaluator_id: evaluator?.user_id || evaluator?.display_name || round.locked_by || '',
      total_score: round.total_score,
      final_result: round.final_result,
      classification: round.classification,
      participants: participantResolution.participants,
      participant_source: participantResolution.source,
      participant_mismatch: participantResolution.mismatch,
      attendees,
      final_conclusion: round.total_score == null ? '' : finalConclusionFromScore(round.total_score),
      started_at: round.started_at,
      completed_at: round.completed_at,
      locked_at: round.locked_at,
      locked_by: round.locked_by,
      readonly: !!round.locked_at,
    };
  }

  assessmentRoundsForTicket(ticket) {
    return this.roundRepository.listByTicket(ticket.id).map((round) => this.mapAssessmentRound(ticket, round));
  }

  round2Gate(ticket) {
    const round1 = this.getRound(ticket.id, 1);
    const round2 = this.getRound(ticket.id, 2);
    if (round2) return { exists: true, eligible: false, reason: 'round_2_exists' };
    if (!round1 || !round1.locked_at) return { exists: false, eligible: false, reason: 'round_1_not_locked' };
    if ((ticket.completed_round || 0) < 1) return { exists: false, eligible: false, reason: 'round_1_not_completed' };
    if (this.pendingApprovalTask(ticket.id)) return { exists: false, eligible: false, reason: 'pending_approval_exists' };
    if (![this.statuses.WAITING_CORRECTION_STATUS, WORKFLOW_STATUSES.EXTENDED].includes(ticket.current_status)) {
      return { exists: false, eligible: false, reason: 'correction_phase_not_active' };
    }
    return { exists: false, eligible: true, reason: '' };
  }

  ensureRound(ticket, roundNo, user) {
    const userEmail = resolveUserId(this.db,
      typeof user === 'string' ? user : (user?.userId || user?.user_id || user?.email),
      { required: true });
    const workflowUser = typeof user === 'string' ? { userId: userEmail, email: null, role: null } : user;
    const existing = this.getRound(ticket.id, roundNo);
    if (existing) {
      this.participantRepository.ensureRoundOwnerAttendee(existing.id, userEmail);
      return existing;
    }
    if (roundNo !== 2) return null;
    if (!this.round2Gate(ticket).eligible) return null;
    return this.db.transaction(() => this.openRound2Transaction(ticket, workflowUser, null))();
  }

  answersForRound(roundId) {
    const rows = this.answerRepository.listRowsByRound(roundId);
    const attachments = this.attachmentRepository.listByRound(roundId);
    const byAnswer = {};
    attachments.forEach((att) => {
      if (!byAnswer[att.answer_id]) byAnswer[att.answer_id] = [];
      byAnswer[att.answer_id].push(this.mapAttachment(att));
    });
    return rows.reduce((acc, row) => {
      acc[String(row.question_id)] = {
        answer_id: row.id,
        question_item_id: row.resolved_question_item_id || row.question_item_id || null,
        score: row.score || '',
        note: row.comment || '',
        comment: row.comment || '',
        calculated_score: row.calculated_score,
        attachments: byAnswer[row.id] || [],
      };
      return acc;
    }, {});
  }

  canonicalAnswersForRound(answers) {
    return Object.values(answers || {}).reduce((acc, answer) => {
      if (answer.question_item_id == null) return acc;
      acc[String(answer.question_item_id)] = answer;
      return acc;
    }, {});
  }

  normalizeIncomingAnswers(ticket, answers, canonicalIdentifiers = false) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return answers || {};
    const legacyByInputId = new Map();
    for (const question of this.questionsForTicket(ticket)) {
      const legacyId = String(question.db_id || question.question_id || '');
      if (!legacyId) continue;
      if (!canonicalIdentifiers) legacyByInputId.set(legacyId, legacyId);
      const canonicalId = question.question_item_id || question.version_item_id;
      if (canonicalIdentifiers && canonicalId != null) legacyByInputId.set(String(canonicalId), legacyId);
    }
    return Object.entries(answers).reduce((normalized, [inputId, value]) => {
      const legacyId = legacyByInputId.get(String(inputId));
      if (!legacyId) {
        throw Object.assign(new Error('question_not_in_ticket'), {
          status: 400,
          payload: { error: 'question_not_in_ticket', question_id: inputId },
        });
      }
      normalized[legacyId] = value;
      return normalized;
    }, {});
  }

  readonlyInheritedAnswers(ticketId, roundNo) {
    if (roundNo !== 2) return {};
    const previousRound = this.getRound(ticketId, 1);
    if (!previousRound) return {};
    const previousAnswers = this.answersForRound(previousRound.id);
    return Object.entries(previousAnswers).reduce((acc, [questionId, answer]) => {
      if (['A', 'NA'].includes(answer.score)) {
        acc[questionId] = {
          score: answer.score,
          note: answer.note || answer.comment || '',
          comment: answer.comment || answer.note || '',
          calculated_score: answer.calculated_score,
          attachments: answer.attachments || [],
          inherited: true,
          readonly: true,
        };
      }
      return acc;
    }, {});
  }

  applyRoundReadonly(ticket, roundNo, answers) {
    const readonly = this.readonlyInheritedAnswers(ticket.id, roundNo);
    Object.entries(readonly).forEach(([questionId, inherited]) => {
      const current = answers[questionId] || {};
      answers[questionId] = {
        ...current,
        ...inherited,
        attachments: (current.attachments && current.attachments.length) ? current.attachments : (inherited.attachments || []),
      };
    });
    return answers;
  }

  validateRoundReadonlyChanges(ticket, roundNo, incomingAnswers) {
    const readonly = this.readonlyInheritedAnswers(ticket.id, roundNo);
    const attempted = [];
    Object.entries(incomingAnswers || {}).forEach(([questionId, value]) => {
      const inherited = readonly[String(questionId)];
      if (!inherited) return;
      const score = String(value?.score || '').trim();
      const comment = String(value?.note || value?.comment || '').trim();
      if ((score && score !== inherited.score) || comment !== (inherited.note || '')) {
        attempted.push(questionId);
      }
    });
    return attempted;
  }

  upsertRoundAnswers(round, answers, userEmail) {
    const actorUserId = resolveUserId(this.db, userEmail, { required: true });
    const pinned = round.scoring_policy_version_id || this.db.prepare(`
      SELECT scoring_policy_version_id FROM evaluation_tickets WHERE id=?
    `).get(round.ticket_id)?.scoring_policy_version_id;
    const scoringDefinition = pinned ? this.scoringPolicyRepository.definition(pinned) : null;
    if (!scoringDefinition) throw Object.assign(new Error('round_scoring_policy_unpinned'), {
      status: 409,
      payload: { error: 'round_scoring_policy_unpinned' },
    });
    Object.entries(answers || {}).forEach(([questionId, value]) => {
      const score = String(value?.score || '').trim() || null;
      const comment = String(value?.note || value?.comment || '').trim() || null;
      this.answerRepository.upsert({
        round_id: round.id,
        question_id: parseInt(questionId, 10),
        score,
        comment,
        calculated_score: calculatedScore(score, scoringDefinition),
        answered_by: actorUserId,
      });
    });
  }

  supplierIntroductionForCompletion(ticket, roundNo, incomingValue, hasIncomingValue) {
    const existing = normalizeSupplierIntroduction(ticket.supplier_introduction);
    if (roundNo === 1 && hasIncomingValue) return normalizeSupplierIntroduction(incomingValue);
    return existing || (hasIncomingValue ? normalizeSupplierIntroduction(incomingValue) : '');
  }

  maybeUpdateSupplierIntroduction(ticket, roundNo, incomingValue, userEmail) {
    if (incomingValue === undefined) return;
    const normalized = normalizeSupplierIntroduction(incomingValue);
    const existing = normalizeSupplierIntroduction(ticket.supplier_introduction);
    if (roundNo !== 1 && existing) return;
    this.statements.updateSupplierIntroduction.run({
      ticket_id: ticket.id,
      supplier_introduction: normalized,
      updated_by: resolveUserId(this.db, userEmail, { required: true }),
    });
  }

  seedRound2AnswersFromRound1(ticket, round, userEmail) {
    const actorUserId = resolveUserId(this.db, userEmail, { required: true });
    if (round.round_no !== 2) return;
    const previousRound = this.getRound(ticket.id, 1);
    if (!previousRound) return;
    const previousAnswers = this.answersForRound(previousRound.id);
    const questions = this.questionsForTicket(ticket);
    const nextAnswers = {};
    questions.forEach((question) => {
      const old = previousAnswers[String(question.db_id)] || {};
      nextAnswers[String(question.db_id)] = ['A', 'NA'].includes(old.score)
        ? { score: old.score, note: old.note || old.comment || '' }
        : { score: '', note: '' };
    });
    this.upsertRoundAnswers(round, nextAnswers, actorUserId);
    const seededAnswers = this.answersForRound(round.id);
    Object.entries(previousAnswers).forEach(([questionId, old]) => {
      if (!['A', 'NA'].includes(old.score) || !(old.attachments || []).length) return;
      const next = seededAnswers[String(questionId)];
      if (!next || !next.answer_id) return;
      old.attachments.forEach((attachment) => {
        const inheritedKey = `INHERITED:${attachment.id}`;
        if (this.attachmentRepository.inheritedExists(next.answer_id, inheritedKey)) return;
        this.attachmentRepository.insert({
          answer_id: next.answer_id,
          ticket_id: ticket.id,
          file_name: attachment.file_name,
          file_path: attachment.file_path || null,
          storage_key: inheritedKey,
          mime_type: attachment.mime_type || null,
          size_bytes: attachment.size_bytes || null,
          uploaded_by: actorUserId,
        });
      });
    });
  }

  roundPayload(ticket, round) {
    const questions = this.questionsForTicket(ticket);
    const answers = this.applyRoundReadonly(ticket, round.round_no, this.answersForRound(round.id));
    const participantResolution = this.roundParticipantResolution(round);
    const canonicalAttendees = participantResolution.participants
      .filter((participant) => participant.participant_role === 'ATTENDEE')
      .map((participant) => ({
        name: participant.display_name,
        ...(participant.user_id ? { user_id: participant.user_id } : {}),
        opening: !!participant.opening_meeting,
        closing: !!participant.closing_meeting,
      }));
    const attendees = canonicalAttendees;
    return {
      ticket: this.mapTicket(ticket),
      round: {
        id: round.id,
        ticket_id: round.ticket_id,
        round_no: round.round_no,
        source_assessment_id: round.source_round_id || null,
        source_assessment_code: round.source_assessment_code || (round.source_round_no ? this.assessmentCode(ticket, round.source_round_no) : null),
        source_round_no: round.source_round_no || null,
        status: round.status,
        started_at: round.started_at,
        completed_at: round.completed_at,
        total_score: round.total_score,
        final_result: round.final_result,
        classification: round.classification,
        participants: participantResolution.participants,
        participant_source: participantResolution.source,
        participant_mismatch: participantResolution.mismatch,
        attendees,
        locked_at: round.locked_at,
        locked_by: round.locked_by,
        locked: !!round.locked_at,
      },
      questions,
      answers,
      canonical_answers: this.canonicalAnswersForRound(answers),
      nonconformities: this.nonconformitiesForTicket(ticket.id).filter((row) => row.round_id === round.id),
    };
  }

  getRoundPayload({ ticketId, roundNo, user }) {
    const ticket = this.ticketRepository.getByIdOrCode(ticketId);
    if (!ticket) throw Object.assign(new Error('ticket_not_found'), { status: 404, payload: { error: 'ticket_not_found' } });
    this.assertVisible(ticket, user);
    if (![1, 2].includes(roundNo)) throw Object.assign(new Error('invalid_round'), { status: 400, payload: { error: 'invalid_round' } });
    const round = this.getRound(ticket.id, roundNo);
    if (!round) throw Object.assign(new Error('round_not_found'), { status: 404, payload: { error: 'round_not_found' } });
    const actorUserId = resolveUserId(this.db, user?.userId || user?.user_id || user?.email, { required: true });
    this.participantRepository.ensureRoundOwnerAttendee(round.id, actorUserId);
    return this.roundPayload(this.ticketRepository.getByCode(ticket.ticket_code), round);
  }

  updateAnswers({ ticketId, roundNo, answers, canonicalAnswers, attendees, supplierIntroduction, user }) {
    const ticket = this.ticketRepository.getByIdOrCode(ticketId);
    if (!ticket) throw Object.assign(new Error('ticket_not_found'), { status: 404, payload: { error: 'ticket_not_found' } });
    this.assertVisible(ticket, user);
    assertTicketMutable(ticket);
    assertTicketMutable(ticket);
    const round = this.ensureRound(ticket, roundNo, user);
    if (!round) throw Object.assign(new Error('round_not_found'), { status: 404, payload: { error: 'round_not_found' } });
    if (round.locked_at) throw Object.assign(new Error('round_locked'), { status: 403, payload: { error: 'round_locked' } });
    const usesCanonicalAnswers = canonicalAnswers !== undefined;
    const normalizedAnswers = this.normalizeIncomingAnswers(
      ticket,
      usesCanonicalAnswers ? canonicalAnswers : answers,
      usesCanonicalAnswers,
    );
    const readonlyAttempts = this.validateRoundReadonlyChanges(ticket, roundNo, normalizedAnswers);
    if (readonlyAttempts.length) {
      throw Object.assign(new Error('inherited_answer_readonly'), {
        status: 400,
        payload: { error: 'inherited_answer_readonly', question_ids: readonlyAttempts },
      });
    }
    const actorUserId = resolveUserId(this.db, user?.userId || user?.user_id || user?.email, { required: true });
    this.db.transaction(() => {
      if (Array.isArray(attendees)) this.roundRepository.updateAttendees(
        round.id, normalizeAttendees(attendees), actorUserId
      );
      this.maybeUpdateSupplierIntroduction(ticket, roundNo, supplierIntroduction, actorUserId);
      this.upsertRoundAnswers(round, normalizedAnswers, actorUserId);
      this.syncRoundNonconformities(ticket, round, this.questionsForTicket(ticket), this.answersForRound(round.id), actorUserId);
      this.roundRepository.markProcessingIfDraft({
        roundId: round.id,
        processingStatus: this.statuses.PROCESSING_STATUS,
        draftStatus: this.statuses.DRAFT_STATUS,
      });
      if (ticket.current_status === this.statuses.DRAFT_STATUS) {
        this.statements.ticketToProcessing.run(this.statuses.PROCESSING_STATUS, actorUserId, ticket.id);
        this.logWorkflow(ticket.id, user, 'SCORING_DRAFT_SAVE', this.statuses.DRAFT_STATUS, this.statuses.PROCESSING_STATUS, null);
      }
    })();
    return this.roundPayload(this.ticketRepository.getByCode(ticket.ticket_code), this.getRound(ticket.id, roundNo));
  }

  completeRound({ ticketId, roundNo, answers: incomingAnswers, canonicalAnswers,
    attendees, supplierIntroduction, finalAction, user }) {
    const ticket = this.ticketRepository.getByIdOrCode(ticketId);
    if (!ticket) throw Object.assign(new Error('ticket_not_found'), { status: 404, payload: { error: 'ticket_not_found' } });
    this.assertVisible(ticket, user);
    assertTicketMutable(ticket);
    const round = this.ensureRound(ticket, roundNo, user);
    if (!round) throw Object.assign(new Error('round_not_found'), { status: 404, payload: { error: 'round_not_found' } });
    if (round.locked_at) throw Object.assign(new Error('round_locked'), { status: 403, payload: { error: 'round_locked' } });
    const usesCanonicalAnswers = canonicalAnswers !== undefined;
    const selectedIncomingAnswers = usesCanonicalAnswers ? canonicalAnswers : incomingAnswers;
    const normalizedIncomingAnswers = selectedIncomingAnswers
      ? this.normalizeIncomingAnswers(ticket, selectedIncomingAnswers, usesCanonicalAnswers)
      : selectedIncomingAnswers;
    const hasAttendeePayload = Array.isArray(attendees);
    const normalizedAttendees = hasAttendeePayload
      ? normalizeAttendees(attendees)
      : this.roundParticipantResolution(round).participants
        .filter((participant) => participant.participant_role === 'ATTENDEE')
        .map((participant) => ({
          name: participant.display_name,
          opening: !!participant.opening_meeting,
          closing: !!participant.closing_meeting,
        }));
    if (!normalizedAttendees.length) {
      throw Object.assign(new Error('attendees_required'), {
        status: 400,
        payload: { error: 'attendees_required' },
      });
    }
    const hasSupplierIntroductionPayload = supplierIntroduction !== undefined;
    const normalizedSupplierIntroduction = this.supplierIntroductionForCompletion(ticket, roundNo, supplierIntroduction, hasSupplierIntroductionPayload);
    if (!normalizedSupplierIntroduction) {
      throw Object.assign(new Error('supplier_introduction_required'), {
        status: 400,
        payload: { error: 'supplier_introduction_required' },
      });
    }
    const result = this.db.transaction(() => {
      const readonlyAttempts = this.validateRoundReadonlyChanges(ticket, roundNo, normalizedIncomingAnswers || {});
      if (readonlyAttempts.length) {
        throw Object.assign(new Error('inherited_answer_readonly'), {
          status: 400,
          payload: { error: 'inherited_answer_readonly', question_ids: readonlyAttempts },
        });
      }
      const actorUserId = resolveUserId(this.db, user?.userId || user?.user_id || user?.email, { required: true });
      if (normalizedIncomingAnswers) this.upsertRoundAnswers(round, normalizedIncomingAnswers, actorUserId);
      if (hasAttendeePayload) this.roundRepository.updateAttendees(
        round.id, normalizedAttendees, actorUserId
      );
      this.maybeUpdateSupplierIntroduction(ticket, roundNo, normalizedSupplierIntroduction, actorUserId);
      const questions = this.questionsForTicket(ticket);
      const answers = this.answersForRound(round.id);
      const scoringDate = new Date().toISOString().slice(0, 10);
      const correctionDate = scoringDate;
      const evaluationDate = roundNo === 2
        ? correctionDate
        : scoringDate;

      const roundForCompletion = {
        ...round,
        assessment_date: evaluationDate,
      };

      this.syncRoundNonconformities(
        ticket,
        roundForCompletion,
        questions,
        answers,
        actorUserId,
      );
      if (roundNo !== 2) {
        const missingCorrectiveRequirements = this.missingRequiredNonconformityActions(ticket.id, round.id);
        if (missingCorrectiveRequirements.length) {
          throw Object.assign(new Error('missing_corrective_requirements'), {
            status: 400,
            payload: { error: 'missing_corrective_requirements', items: missingCorrectiveRequirements },
          });
        }
      }
      const questionBank = this.questionBank(questions);
      if (questionBank.length === 0) throw Object.assign(new Error('no_questions'), { status: 400, payload: { error: 'no_questions' } });
      const errors = validateScoringAnswers(questionBank, answers);
      if (errors.length) throw Object.assign(new Error('validation_failed'), { status: 400, payload: { error: 'validation_failed', errors } });

      const scoringPolicy = this.scoringPolicyRepository.policyForTicket(ticket);
      if (round.scoring_policy_version_id
        && Number(round.scoring_policy_version_id) !== Number(scoringPolicy.version.id)) {
        throw Object.assign(new Error('round_scoring_policy_pin_mismatch'), {
          status: 409,
          payload: { error: 'round_scoring_policy_pin_mismatch' },
        });
      }
      const score = calculateWithPolicy(scoringPolicy.definition, questionBank, answers);
      const leadEligibility = leadSubmissionEligibilityWithPolicy(scoringPolicy.definition, questionBank, answers, score);
      if (finalAction === 'SUBMIT_LEAD' && !leadEligibility.eligible) {
        throw Object.assign(new Error('lead_submission_not_eligible'), {
          status: 400,
          payload: { error: 'lead_submission_not_eligible', ...leadEligibility },
        });
      }
      const normalizedResult = buildEvaluationResultWithPolicy(scoringPolicy.definition, {
        score: score.finalScore,
        forcedFail: !score.passed,
        evaluationDate,
      });
      const scoringSnapshot = {
        schema_version: 1,
        scoring_policy_version_id: scoringPolicy.version.id,
        scoring_policy_checksum: scoringPolicy.version.checksum,
        formula_checksum: scoringPolicy.version.formula_checksum,
        score: score.finalScore,
        average: score.average,
        grade: normalizedResult.grade,
        band: normalizedResult.band,
        result_label: normalizedResult.label,
        passed: normalizedResult.passed,
        eliminated: score.eliminated,
        category_codes: Object.values(score.category_by_code || {})
          .map((item) => item.category_code).filter(Boolean),
      };
      const scoringSnapshotJson = stableJson(scoringSnapshot);
      this.roundRepository.complete({
        id: round.id,
        assessment_date: evaluationDate,
        total_score: score.finalScore,
        final_result: score.label,
        classification: score.grade,
        locked_by: actorUserId,
        scoring_policy_version_id: scoringPolicy.version.id,
        scoring_result_snapshot_json: scoringSnapshotJson,
        scoring_result_checksum: definitionChecksum(scoringSnapshot),
      });
      if (roundNo === 2) this.updateRound2TicketResult(ticket, roundNo, normalizedResult, score, correctionDate, actorUserId);
      else this.updateRound1TicketResult(ticket, roundNo, normalizedResult, score, evaluationDate, actorUserId);

      // A failed round 2 still has to go through the approval workflow. Keep the
      // ticket in round 2 after locking its score so submit_lead remains available.
      const nextStatus = roundNo === 2
        ? (leadEligibility.eligible ? this.statuses.ROUND_2_STATUS : this.statuses.COMPLETED_STATUS)
        : (finalAction === 'WAITING_CORRECTION' ? this.statuses.WAITING_CORRECTION_STATUS : this.statuses.PROCESSING_STATUS);
      const workflowAction = roundNo === 1 && finalAction === 'WAITING_CORRECTION'
        ? 'ROUND_1_END'
        : (roundNo === 2 && finalAction !== 'SUBMIT_LEAD' ? 'ROUND_2_END' : `ROUND_${roundNo}_COMPLETE`);
      this.statements.ticketToProcessing.run(nextStatus, actorUserId, ticket.id);
      this.logWorkflow(ticket.id, user, workflowAction, ticket.current_status, nextStatus, JSON.stringify({
        score_percent: score.finalScore,
        result_label: normalizedResult.label,
        classification: normalizedResult.grade,
        next_evaluation_date: normalizedResult.nextEvaluationDate || null,
        scoring_policy_version_id: scoringPolicy.version.id,
        scoring_policy_checksum: scoringPolicy.version.checksum,
      }));
      this.logWorkflow(ticket.id, user, 'CORRECTION_FIELDS_LOCK', ticket.current_status, nextStatus, JSON.stringify({
        assessment_id: round.id,
        round_no: roundNo,
        correction_locked: true,
      }));
      return { score, leadEligibility };
    })();
    return {
      ...this.roundPayload(this.ticketRepository.getByCode(ticket.ticket_code), this.getRound(ticket.id, roundNo)),
      result: { ...result.score, lead_submission_eligible: result.leadEligibility.eligible },
    };
  }

  createRound2({ code, answers, canonicalAnswers, user }) {
    const ticket = this.ticketRepository.getByCode(code);
    if (!ticket) throw Object.assign(new Error('ticket_not_found'), { status: 404, payload: { error: 'ticket_not_found' } });
    this.assertVisible(ticket, user);
    assertTicketMutable(ticket);
    if (this.getRound(ticket.id, 2)) throw Object.assign(new Error('round_2_exists'), { status: 409, payload: { error: 'round_2_exists' } });
    const gate = this.round2Gate(ticket);
    if (!gate.eligible) {
      throw Object.assign(new Error('round_2_not_allowed'), {
        status: 400,
        payload: { error: 'round_2_not_allowed', reason: gate.reason },
      });
    }
    const usesCanonicalAnswers = canonicalAnswers !== undefined;
    const selectedAnswers = usesCanonicalAnswers ? canonicalAnswers : answers;
    const normalizedAnswers = selectedAnswers
      ? this.normalizeIncomingAnswers(ticket, selectedAnswers, usesCanonicalAnswers)
      : null;
    const round = this.db.transaction(() => this.openRound2Transaction(ticket, user, normalizedAnswers))();
    return this.roundPayload(this.ticketRepository.getByCode(code), round);
  }

  openRound2Transaction(ticket, user, answers) {
    const userEmail = resolveUserId(this.db, user?.userId || user?.user_id || user?.email, { required: true });
    const sourceRound = this.getRound(ticket.id, 1);
    this.roundRepository.insert({
      ticket_id: ticket.id,
      round_no: 2,
      source_round_id: sourceRound?.id || null,
      assessment_code: this.assessmentCode(ticket, 2),
      assessment_date: new Date().toISOString().slice(0, 10),
      evaluator_id: userEmail,
      status: this.statuses.PROCESSING_STATUS,
    });
    const createdRound = this.getRound(ticket.id, 2);
    this.seedRound2AnswersFromRound1(ticket, createdRound, userEmail);
    if (answers) {
      const readonlyAttempts = this.validateRoundReadonlyChanges(ticket, 2, answers);
      if (readonlyAttempts.length) {
        throw Object.assign(new Error('inherited_answer_readonly'), {
          status: 400,
          payload: { error: 'inherited_answer_readonly', question_ids: readonlyAttempts },
        });
      }
      this.upsertRoundAnswers(createdRound, answers, userEmail);
    }
    this.statements.openRound2Ticket.run({
      status: this.statuses.ROUND_2_STATUS,
      updated_by: userEmail,
      ticket_id: ticket.id,
    });
    this.logWorkflow(ticket.id, user, 'ROUND_2_OPEN', ticket.current_status, this.statuses.ROUND_2_STATUS, JSON.stringify({
      created_by: userEmail,
      created_at: new Date().toISOString(),
      source_ticket_code: ticket.ticket_code,
      source_assessment_id: sourceRound?.id || null,
      source_assessment_code: sourceRound?.assessment_code || this.assessmentCode(ticket, 1),
      source_round_no: 1,
      target_assessment_id: createdRound.id,
      target_assessment_code: createdRound.assessment_code || this.assessmentCode(ticket, 2),
      target_round_no: 2,
    }));
    return createdRound;
  }

  questionBank(questions) {
    return questions.map((q) => ({
      id: String(q.db_id),
      section: q.section_name,
      categoryCode: q.category_code || null,
      categoryLabel: q.category_label_snapshot || q.section_name,
      question: q.text,
      clause: q.clause_type,
      critical: !!q.is_critical,
      requiresAttachment: !!q.requires_attachment,
      allowedScores: String(q.allowed_scores || '').split('/').filter(Boolean),
    }));
  }

  updateRound1TicketResult(ticket, roundNo, normalizedResult, score, actualEvaluationDate, userEmail) {
    this.statements.updateRound1TicketResult.run({
      ticket_id: ticket.id,
      processing_status: this.statuses.PROCESSING_STATUS,
      round_no: roundNo,
      actual_evaluation_date: actualEvaluationDate,
      score_percent: normalizedResult.score,
      grade_code: normalizedResult.grade,
      result_label: normalizedResult.label,
      next_evaluation_date: normalizedResult.nextEvaluationDate || null,
      final_conclusion: normalizedResult.finalConclusion,
      result_reason: score.reason,
      updated_by: userEmail,
    });
  }

  updateRound2TicketResult(ticket, roundNo, normalizedResult, score, correctionDate, userEmail) {
    this.statements.updateRound2TicketResult.run({
      ticket_id: ticket.id,
      processing_status: this.statuses.PROCESSING_STATUS,
      round_no: roundNo,
      score_percent: normalizedResult.score,
      grade_code: normalizedResult.grade,
      result_label: normalizedResult.label,
      correction_date: correctionDate,
      next_evaluation_date: normalizedResult.nextEvaluationDate || null,
      final_conclusion: normalizedResult.finalConclusion,
      result_reason: score.reason,
      updated_by: userEmail,
    });
  }

  assertVisible(ticket, user) {
    this.policyService.assert(user, PERMISSIONS.EVALUATION_READ, { context: resourceContext(ticket) });
  }
}

module.exports = EvaluationScoringService;
