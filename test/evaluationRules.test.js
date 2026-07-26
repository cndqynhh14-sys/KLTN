const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../server/domain/evaluationRules');

const questionBank = [
  { id: 'legal-1', section: 'Hồ sơ pháp lý', question: 'Giấy chứng nhận đăng ký kinh doanh', clause: 'normal', critical: false },
  { id: 'legal-2', section: 'Hồ sơ pháp lý', question: 'Giấy chứng nhận ATTP', clause: 'exclusion', critical: false },
  { id: 'quality-1', section: 'Kiểm soát chất lượng', question: 'Quy trình kiểm soát đầu vào', clause: 'normal', critical: true },
  { id: 'trace-1', section: 'Truy xuất nguồn gốc', question: 'Hồ sơ truy xuất theo lô', clause: 'normal', critical: true },
  { id: 'trace-2', section: 'Truy xuất nguồn gốc', question: 'Lưu hồ sơ lô', clause: 'normal', critical: false },
];

function answers(overrides = {}) {
  return {
    'legal-1': { score: 'A', note: '' },
    'legal-2': { score: 'A', note: '' },
    'quality-1': { score: 'A', note: '' },
    'trace-1': { score: 'A', note: '' },
    'trace-2': { score: 'A', note: '' },
    ...overrides,
  };
}

test('classifyScore maps BRD thresholds to grade and pass status', () => {
  assert.deepEqual(
    [59.99, 60, 75, 75.01, 90, 90.01].map((score) => {
      const result = classifyScore(score, false);
      return { score, grade: result.grade, passed: result.passed, months: result.nextEvaluationMonths };
    }),
    [
      { score: 59.99, grade: 'D', passed: false, months: null },
      { score: 60, grade: 'C', passed: true, months: 6 },
      { score: 75, grade: 'C', passed: true, months: 6 },
      { score: 75.01, grade: 'B', passed: true, months: 12 },
      { score: 90, grade: 'B', passed: true, months: 12 },
      { score: 90.01, grade: 'A', passed: true, months: 24 },
    ],
  );
  const forced = classifyScore(99, true);
  assert.equal(forced.grade, 'D');
  assert.equal(forced.passed, false);
});

test('centralized result helpers normalize labels and plan next evaluation dates', () => {
  assert.equal(normalizeResultLabel('Dat co dieu kien'), 'Đạt mức cơ bản, đánh giá lại sau 6 tháng');
  assert.equal(normalizeResultLabel('Đạt mức cao'), 'Đạt mức cao');
  assert.equal(calculateNextEvaluationDate('2026-07-15', 59.99), '');
  assert.equal(calculateNextEvaluationDate('2026-07-15', 60), '2027-01-15');
  assert.equal(calculateNextEvaluationDate('2026-07-15', 75), '2027-01-15');
  assert.equal(calculateNextEvaluationDate('2026-07-15', 75.01), '2027-07-15');
  assert.equal(calculateNextEvaluationDate('2026-07-15', 90), '2027-07-15');
  assert.equal(calculateNextEvaluationDate('2026-07-15', 90.01), '2028-07-15');
  assert.equal(calculateNextEvaluationDate('2026-07-15', 99, true), '');
  assert.equal(buildEvaluationResult({ score: 99, forcedFail: true, evaluationDate: '2026-07-15' }).finalConclusion, 'Đạt');
  assert.deepEqual(
    buildEvaluationResult({ score: 90.01, evaluationDate: '2026-07-15' }),
    {
      score: 90.01,
      grade: 'A',
      label: 'Đạt mức cao',
      passed: true,
      band: 'HIGH_PASS',
      nextEvaluationMonths: 24,
      nextEvaluationDate: '2028-07-15',
      finalConclusion: 'Đạt',
    },
  );
  assert.equal(finalConclusionFromScore(60), 'Đạt');
  assert.equal(finalConclusionFromScore(59.99), 'Không đạt');
});

test('validateScoringAnswers requires a score for every question', () => {
  const errors = validateScoringAnswers(questionBank, answers({ 'trace-2': { score: '', note: '' } }));
  assert.match(errors[0], /chưa chọn điểm/);
});

test('validateScoringAnswers rejects B/C on exclusion clauses', () => {
  const errors = validateScoringAnswers(questionBank, answers({ 'legal-2': { score: 'B', note: 'Thiếu hồ sơ' } }));
  assert.ok(errors.some((msg) => msg.includes('A/D/NA')));
});

test('validateScoringAnswers requires notes for B, C, D, and NA', () => {
  const errors = validateScoringAnswers(questionBank, answers({
    'quality-1': { score: 'B', note: '' },
    'trace-1': { score: 'C', note: '' },
    'trace-2': { score: 'NA', note: '' },
  }));
  assert.equal(errors.filter((msg) => msg.includes('cần nhập')).length, 3);
});

test('validateScoringAnswers requires attachment when question setup requires evidence', () => {
  const bank = [
    ...questionBank,
    { id: 'evidence-1', section: 'Evidence', question: 'Upload evidence', clause: 'normal', critical: false, requiresAttachment: true },
  ];
  const errors = validateScoringAnswers(bank, {
    ...answers(),
    'evidence-1': { score: 'A', note: '' },
  });
  assert.ok(errors.some((msg) => msg.includes('attachment')));
  const ok = validateScoringAnswers(bank, {
    ...answers(),
    'evidence-1': { score: 'A', note: '', attachments: [{ id: 1 }] },
  });
  assert.deepEqual(ok, []);
});

test('answerComplete allows A without note and requires note for nonconforming/NA values', () => {
  assert.equal(answerComplete({ score: 'A', note: '' }), true);
  assert.equal(answerComplete({ score: 'B', note: '' }), false);
  assert.equal(answerComplete({ score: 'B', note: 'Có điểm không phù hợp' }), true);
  assert.equal(answerComplete({ score: 'NA', note: '' }), false);
});

test('calculateScoring excludes NA from denominator and tracks nonconformities', () => {
  const result = calculateScoring(questionBank, answers({
    'quality-1': { score: 'B', note: 'Cần bổ sung quy trình' },
    'trace-2': { score: 'NA', note: 'Không áp dụng cho mô hình này' },
  }));
  assert.equal(result.average, 93.75);
  assert.equal(result.finalScore, 89.0625);
  assert.equal(result.grade, 'B');
  assert.equal(result.counts.B, 1);
  assert.equal(result.nonconformities.length, 1);
});

test('calculateScoring applies critical C penalty before classification', () => {
  const result = calculateScoring(questionBank, answers({
    'trace-1': { score: 'C', note: 'Thiếu hồ sơ truy xuất' },
  }));
  assert.equal(result.average, 85);
  assert.equal(result.finalScore, 76.5);
  assert.equal(result.grade, 'B');
  assert.match(result.reason, /90%/);
});

test('calculateScoring forces failure when an exclusion clause is D', () => {
  const result = calculateScoring(questionBank, answers({
    'legal-2': { score: 'D', note: 'Giấy chứng nhận ATTP hết hiệu lực' },
  }));
  assert.equal(result.finalScore, 0);
  assert.equal(result.grade, 'D');
  assert.equal(result.passed, false);
  assert.match(result.reason, /điều khoản loại/);
});

test('leadSubmissionEligibility requires score below threshold or critical D clause', () => {
  const cleanPass = calculateScoring(questionBank, answers());
  assert.deepEqual(leadSubmissionEligibility(questionBank, answers(), cleanPass), {
    eligible: false,
    score_percent: 100,
    score_below_threshold: false,
    failed_critical_count: 0,
    failed_critical_question_ids: [],
  });

  const criticalFailureAnswers = answers({
    'quality-1': { score: 'B', note: 'Critical clause is not fully met' },
  });
  const criticalFailureResult = calculateScoring(questionBank, criticalFailureAnswers);
  const criticalEligibility = leadSubmissionEligibility(questionBank, criticalFailureAnswers, criticalFailureResult);
  assert.equal(criticalEligibility.eligible, false);
  assert.equal(criticalEligibility.score_below_threshold, false);
  assert.deepEqual(criticalEligibility.failed_critical_question_ids, []);
  assert.deepEqual(failedCriticalClauses(questionBank, criticalFailureAnswers).map((q) => q.id), []);

  const criticalDAnswers = answers({
    'quality-1': { score: 'D', note: 'Critical clause failed at D' },
  });
  const criticalDResult = calculateScoring(questionBank, criticalDAnswers);
  const criticalDEligibility = leadSubmissionEligibility(questionBank, criticalDAnswers, criticalDResult);
  assert.equal(criticalDResult.finalScore, 80);
  assert.equal(criticalDEligibility.eligible, true);
  assert.equal(criticalDEligibility.score_below_threshold, false);
  assert.deepEqual(criticalDEligibility.failed_critical_question_ids, ['quality-1']);
  assert.deepEqual(failedCriticalClauses(questionBank, criticalDAnswers).map((q) => q.id), ['quality-1']);

  const lowScoreAnswers = answers({
    'legal-1': { score: 'D', note: 'Major gap' },
    'legal-2': { score: 'D', note: 'Major gap' },
    'trace-2': { score: 'D', note: 'Major gap' },
  });
  const lowScoreResult = calculateScoring(questionBank, lowScoreAnswers);
  const lowScoreEligibility = leadSubmissionEligibility(questionBank, lowScoreAnswers, lowScoreResult);
  assert.equal(lowScoreEligibility.eligible, true);
  assert.equal(lowScoreEligibility.score_below_threshold, true);
  assert.equal(lowScoreEligibility.failed_critical_count, 0);
});

test('createRound2Answers inherits A/NA and clears B/C/D for reassessment', () => {
  const next = createRound2Answers(questionBank, answers({
    'legal-2': { score: 'NA', note: 'Không áp dụng' },
    'quality-1': { score: 'B', note: 'Cần bổ sung quy trình' },
    'trace-1': { score: 'D', note: 'Không có hồ sơ' },
  }));
  assert.deepEqual(next['legal-1'], { score: 'A', note: '', inherited: true });
  assert.deepEqual(next['legal-2'], { score: 'NA', note: 'Không áp dụng', inherited: true });
  assert.deepEqual(next['quality-1'], { score: '', note: '' });
  assert.deepEqual(next['trace-1'], { score: '', note: '' });
});
