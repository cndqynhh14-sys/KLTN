const {
  GOLDEN_V1_DEFINITION,
  RESULT_LABELS,
  buildEvaluationResultWithPolicy,
  calculateWithPolicy,
  classifyWithPolicy,
  leadSubmissionEligibilityWithPolicy,
} = require('../scoring/scoringPolicyEngine');

const SCORE_VALUES = Object.freeze(Object.fromEntries(
  Object.entries(GOLDEN_V1_DEFINITION.score_values).filter(([, value]) => Number.isFinite(value)),
));
const LEAD_SUBMISSION_CRITICAL_SCORES = new Set(GOLDEN_V1_DEFINITION.workflow_thresholds.lead_submission_critical_scores);

const SCORE_BANDS = Object.freeze(GOLDEN_V1_DEFINITION.bands.map((band) => Object.freeze({
  key: band.key,
  grade: band.grade,
  min: band.min == null ? -Infinity : Number(band.min) + (band.min_inclusive ? 0 : 0.000001),
  max: band.max == null ? Infinity : Number(band.max) - (band.max_inclusive ? 0 : 0.000001),
  passed: GOLDEN_V1_DEFINITION.grades[band.grade].passed,
  nextEvaluationMonths: GOLDEN_V1_DEFINITION.grades[band.grade].next_evaluation_months,
})));

const LEGACY_RESULT_LABELS = new Map([
  ['khong dat', RESULT_LABELS.FAIL],
  ['không đạt', RESULT_LABELS.FAIL],
  ['dat muc co ban', RESULT_LABELS.BASIC_PASS],
  ['đạt mức cơ bản', RESULT_LABELS.BASIC_PASS],
  ['dat co dieu kien', RESULT_LABELS.BASIC_PASS],
  ['đạt có điều kiện', RESULT_LABELS.BASIC_PASS],
  ['dat', RESULT_LABELS.GOOD_PASS],
  ['đạt', RESULT_LABELS.GOOD_PASS],
  ['dat muc kha', RESULT_LABELS.GOOD_PASS],
  ['đạt mức khá', RESULT_LABELS.GOOD_PASS],
  ['dat muc cao', RESULT_LABELS.HIGH_PASS],
  ['đạt mức cao', RESULT_LABELS.HIGH_PASS],
]);

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeResultLabel(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (Object.values(RESULT_LABELS).includes(raw)) return raw;
  return LEGACY_RESULT_LABELS.get(normalizeText(raw)) || raw;
}

function classifyScore(score, forcedFail) {
  return classifyWithPolicy(GOLDEN_V1_DEFINITION, score, forcedFail);
}

function parseDate(value) {
  const match = String(value || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function isoDate(date) {
  return date ? date.toISOString().slice(0, 10) : '';
}

function addMonths(dateText, months) {
  const date = parseDate(dateText);
  if (!date || !months) return '';
  const day = date.getUTCDate();
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return isoDate(next);
}

function calculateNextEvaluationDate(evaluationDate, score, forcedFail) {
  const classified = classifyScore(score, forcedFail);
  if (!classified.passed || !classified.nextEvaluationMonths) return '';
  return addMonths(evaluationDate, classified.nextEvaluationMonths);
}

function finalConclusionFromScore(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return '';
  return numeric >= Number(GOLDEN_V1_DEFINITION.final_conclusion.pass_min)
    ? GOLDEN_V1_DEFINITION.final_conclusion.pass_label
    : GOLDEN_V1_DEFINITION.final_conclusion.fail_label;
}

function buildEvaluationResult({ score, forcedFail = false, evaluationDate = '', existingFinalConclusion = '' }) {
  return buildEvaluationResultWithPolicy(GOLDEN_V1_DEFINITION, { score, forcedFail, evaluationDate });
}

function answerComplete(answer) {
  if (!answer || !answer.score) return false;
  const hasComment = !['B', 'C', 'D', 'NA'].includes(answer.score) || !!String(answer.note || answer.comment || '').trim();
  const hasAttachment = !answer.requiresAttachment || !!answer.attachment_id || !!answer.attachmentName || (Array.isArray(answer.attachments) && answer.attachments.length > 0);
  return hasComment && hasAttachment;
}

function validateScoringAnswers(questionBank, answers) {
  const errors = [];
  questionBank.forEach((q) => {
    const a = answers[q.id] || {};
    if (!a.score) errors.push(`${q.section}: chưa chọn điểm cho "${q.question}".`);
    const allowed = q.allowedScores && q.allowedScores.length ? q.allowedScores : (q.clause === 'exclusion' ? ['A', 'D', 'NA'] : ['A', 'B', 'C', 'D', 'NA']);
    if (a.score && !allowed.includes(a.score)) {
      errors.push(`${q.section}: câu hỏi "${q.question}" chỉ cho phép ${allowed.join('/')}.`);
    }
    if (['B', 'C', 'D', 'NA'].includes(a.score) && !String(a.note || a.comment || '').trim()) {
      errors.push(`${q.section}: điểm ${a.score} cần nhập Ý kiến / Ghi chú.`);
    }
    if (q.requiresAttachment && a.score && !a.attachment_id && !a.attachmentName && !(Array.isArray(a.attachments) && a.attachments.length > 0)) {
      errors.push(`${q.section}: câu hỏi "${q.question}" yêu cầu bằng chứng/attachment.`);
    }
  });
  return errors;
}

function calculateScoring(questionBank, answers) {
  return calculateWithPolicy(GOLDEN_V1_DEFINITION, questionBank, answers);
}

function failedCriticalClauses(questionBank, answers) {
  return (questionBank || []).filter((q) => {
    const score = (answers?.[q.id] || {}).score;
    return q.critical && LEAD_SUBMISSION_CRITICAL_SCORES.has(score);
  });
}

function leadSubmissionEligibility(questionBank, answers, scoreResult) {
  return leadSubmissionEligibilityWithPolicy(GOLDEN_V1_DEFINITION, questionBank, answers, scoreResult);
}

function createRound2Answers(questionBank, previousAnswers) {
  const nextAnswers = {};
  questionBank.forEach((q) => {
    const old = previousAnswers[q.id] || {};
    nextAnswers[q.id] = ['A', 'NA'].includes(old.score)
      ? { score: old.score, note: old.note || '', inherited: true }
      : { score: '', note: '' };
  });
  return nextAnswers;
}

module.exports = {
  RESULT_LABELS,
  SCORE_BANDS,
  SCORE_VALUES,
  answerComplete,
  buildEvaluationResult,
  calculateScoring,
  calculateNextEvaluationDate,
  classifyScore,
  createRound2Answers,
  failedCriticalClauses,
  finalConclusionFromScore,
  leadSubmissionEligibility,
  normalizeResultLabel,
  validateScoringAnswers,
};
