export const EVALUATION_STATUS = Object.freeze({
  DRAFT: 'Khởi tạo',
  IN_PROGRESS: 'Đang xử lý',
  WAITING_CORRECTION: 'Chờ khắc phục',
  ROUND_2: 'Đang đánh giá lần 2',
  WAITING_LEAD: 'Chờ duyệt (Lead)',
  WAITING_TBP: 'Chờ duyệt (TBP)',
  WAITING_GDK: 'Chờ duyệt (GĐK)',
  COMPLETED: 'Hoàn thành',
  EXTENDED: 'Gia hạn',
  SUSPENDED: 'Tạm ngừng',
  CANCELLED: 'Hủy',
});

export const EVALUATION_STATUS_TABS = Object.freeze([
  { value: '', label: 'Tất cả' },
  { value: EVALUATION_STATUS.DRAFT, label: EVALUATION_STATUS.DRAFT },
  { value: EVALUATION_STATUS.IN_PROGRESS, label: EVALUATION_STATUS.IN_PROGRESS },
  { value: EVALUATION_STATUS.WAITING_CORRECTION, label: EVALUATION_STATUS.WAITING_CORRECTION },
  { value: EVALUATION_STATUS.ROUND_2, label: EVALUATION_STATUS.ROUND_2 },
  { value: EVALUATION_STATUS.WAITING_LEAD, label: EVALUATION_STATUS.WAITING_LEAD },
  { value: EVALUATION_STATUS.WAITING_TBP, label: EVALUATION_STATUS.WAITING_TBP },
  { value: EVALUATION_STATUS.WAITING_GDK, label: EVALUATION_STATUS.WAITING_GDK },
  { value: EVALUATION_STATUS.COMPLETED, label: EVALUATION_STATUS.COMPLETED },
]);

const STATUS_META = Object.freeze({
  [EVALUATION_STATUS.DRAFT]: { badgeClass: 'draft' },
  [EVALUATION_STATUS.IN_PROGRESS]: { badgeClass: 'processing' },
  [EVALUATION_STATUS.WAITING_CORRECTION]: { badgeClass: 'waiting' },
  [EVALUATION_STATUS.ROUND_2]: { badgeClass: 'processing' },
  [EVALUATION_STATUS.WAITING_LEAD]: { badgeClass: 'waiting' },
  [EVALUATION_STATUS.WAITING_TBP]: { badgeClass: 'waiting' },
  [EVALUATION_STATUS.WAITING_GDK]: { badgeClass: 'waiting' },
  [EVALUATION_STATUS.COMPLETED]: { badgeClass: 'done' },
  [EVALUATION_STATUS.EXTENDED]: { badgeClass: 'waiting' },
  [EVALUATION_STATUS.SUSPENDED]: { badgeClass: 'failed' },
  'Tạm ngưng': { badgeClass: 'failed' },
  [EVALUATION_STATUS.CANCELLED]: { badgeClass: 'failed' },
  'Đã hủy': { badgeClass: 'failed' },
});

export function evaluationStatusMeta(status) {
  const label = String(status || '').trim();
  return { label: label || '—', badgeClass: STATUS_META[label]?.badgeClass || 'failed' };
}

export function filterEvaluationsByStatus(rows, status) {
  const selected = String(status || '').trim();
  return selected ? (rows || []).filter((row) => row?.status === selected) : [...(rows || [])];
}

export function evaluationStatusCounts(rows) {
  const counts = Object.fromEntries(EVALUATION_STATUS_TABS.map((tab) => [tab.value, 0]));
  counts[''] = (rows || []).length;
  (rows || []).forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(counts, row?.status)) counts[row.status] += 1;
  });
  return counts;
}

const KNOWN_STATUSES = new Set(Object.keys(STATUS_META));
const BUSINESS_STEP_SEQUENCE = Object.freeze([
  EVALUATION_STATUS.DRAFT,
  EVALUATION_STATUS.IN_PROGRESS,
  EVALUATION_STATUS.WAITING_CORRECTION,
  EVALUATION_STATUS.EXTENDED,
  EVALUATION_STATUS.ROUND_2,
  EVALUATION_STATUS.WAITING_LEAD,
  EVALUATION_STATUS.WAITING_TBP,
  EVALUATION_STATUS.WAITING_GDK,
  EVALUATION_STATUS.COMPLETED,
  EVALUATION_STATUS.SUSPENDED,
  EVALUATION_STATUS.CANCELLED,
]);
const BUSINESS_STEP_ORDER = new Map(BUSINESS_STEP_SEQUENCE.map((status, index) => [status, index]));

function statusValue(value) {
  const status = String(value || '').trim();
  return KNOWN_STATUSES.has(status) ? status : '';
}

function chronologicalHistory(history) {
  return [...(history || [])].sort((a, b) => {
    const aTime = Date.parse(a?.created_at || '') || 0;
    const bTime = Date.parse(b?.created_at || '') || 0;
    return aTime - bTime || Number(a?.id || 0) - Number(b?.id || 0);
  });
}

function businessStepIdentity(status) {
  // TARGET gives round 2 and every approval stage a distinct canonical status.
  // That status is the business-step identity; repeated audit transitions are not new steps.
  return statusValue(status);
}

function workflowEvidence(history) {
  const evidence = new Map();
  const remember = (status, occurredAt, sequence) => {
    const identity = businessStepIdentity(status);
    if (!identity) return;
    const existing = evidence.get(identity);
    if (!existing) {
      evidence.set(identity, {
        identity,
        status: identity,
        firstSequence: sequence,
        firstOccurredAt: occurredAt || '',
        lastOccurredAt: occurredAt || '',
      });
      return;
    }
    if (!existing.firstOccurredAt && occurredAt) existing.firstOccurredAt = occurredAt;
    if (occurredAt) existing.lastOccurredAt = occurredAt;
  };
  chronologicalHistory(history).forEach((entry, sequence) => {
    const from = statusValue(entry?.from_status);
    const to = statusValue(entry?.to_status);
    if (!from && !to) return;
    if (from === to) {
      remember(to, '', sequence);
      return;
    }
    remember(from, '', sequence);
    remember(to, entry?.created_at, sequence);
  });
  return evidence;
}

function sortBusinessSteps(steps) {
  return [...steps].sort((a, b) => {
    const aOrder = BUSINESS_STEP_ORDER.get(a.status) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = BUSINESS_STEP_ORDER.get(b.status) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder || Number(a.firstSequence || 0) - Number(b.firstSequence || 0);
  });
}

function inferredSteps(current, evaluation) {
  const paths = {
    [EVALUATION_STATUS.DRAFT]: [EVALUATION_STATUS.DRAFT],
    [EVALUATION_STATUS.IN_PROGRESS]: [EVALUATION_STATUS.DRAFT, EVALUATION_STATUS.IN_PROGRESS],
    [EVALUATION_STATUS.WAITING_CORRECTION]: [EVALUATION_STATUS.DRAFT, EVALUATION_STATUS.IN_PROGRESS, EVALUATION_STATUS.WAITING_CORRECTION],
    [EVALUATION_STATUS.ROUND_2]: [EVALUATION_STATUS.DRAFT, EVALUATION_STATUS.IN_PROGRESS, EVALUATION_STATUS.WAITING_CORRECTION, EVALUATION_STATUS.ROUND_2],
    [EVALUATION_STATUS.WAITING_LEAD]: [EVALUATION_STATUS.DRAFT, EVALUATION_STATUS.IN_PROGRESS, EVALUATION_STATUS.WAITING_LEAD],
    [EVALUATION_STATUS.WAITING_TBP]: [EVALUATION_STATUS.DRAFT, EVALUATION_STATUS.IN_PROGRESS, EVALUATION_STATUS.WAITING_LEAD, EVALUATION_STATUS.WAITING_TBP],
    [EVALUATION_STATUS.WAITING_GDK]: [EVALUATION_STATUS.DRAFT, EVALUATION_STATUS.IN_PROGRESS, EVALUATION_STATUS.WAITING_LEAD, EVALUATION_STATUS.WAITING_TBP, EVALUATION_STATUS.WAITING_GDK],
  };
  let statuses = paths[current] || [current];
  if ([EVALUATION_STATUS.COMPLETED, EVALUATION_STATUS.SUSPENDED, EVALUATION_STATUS.CANCELLED].includes(current)) {
    const approvalLevels = new Set((evaluation?.approval_tasks || []).map((task) => String(task?.approval_level || '').toUpperCase()));
    const proven = [EVALUATION_STATUS.DRAFT, EVALUATION_STATUS.IN_PROGRESS];
    if (evaluation?.round_2_exists) proven.push(EVALUATION_STATUS.WAITING_CORRECTION, EVALUATION_STATUS.ROUND_2);
    if (approvalLevels.has('LEAD')) proven.push(EVALUATION_STATUS.WAITING_LEAD);
    if (approvalLevels.has('TBP')) proven.push(EVALUATION_STATUS.WAITING_TBP);
    if (approvalLevels.has('GDK')) proven.push(EVALUATION_STATUS.WAITING_GDK);
    statuses = proven.length > 2 ? [...proven, current] : [current];
  }
  return statuses.filter(Boolean).map((status) => ({ status, label: status, occurredAt: '' }));
}

function guaranteedFutureStatuses(current, actualSteps) {
  if (current === EVALUATION_STATUS.DRAFT) return [EVALUATION_STATUS.IN_PROGRESS];
  if ([EVALUATION_STATUS.IN_PROGRESS, EVALUATION_STATUS.WAITING_CORRECTION, EVALUATION_STATUS.ROUND_2].includes(current)) return [EVALUATION_STATUS.COMPLETED];
  if (current === EVALUATION_STATUS.WAITING_LEAD) return [EVALUATION_STATUS.WAITING_TBP, EVALUATION_STATUS.COMPLETED];
  if (current === EVALUATION_STATUS.WAITING_TBP) {
    const hasRequiredGdk = actualSteps.some((step) => step.status === EVALUATION_STATUS.WAITING_GDK);
    return hasRequiredGdk ? [EVALUATION_STATUS.WAITING_GDK, EVALUATION_STATUS.COMPLETED] : [EVALUATION_STATUS.COMPLETED];
  }
  if (current === EVALUATION_STATUS.WAITING_GDK) return [EVALUATION_STATUS.COMPLETED];
  return [];
}

/** Build the real ticket journey without inventing optional round-2/GDK steps. */
export function getEvaluationWorkflowSteps(evaluation) {
  const current = statusValue(evaluation?.status || evaluation?.workflow_status || evaluation?.current_status);
  if (!current) return [];
  const evidence = workflowEvidence(evaluation?.workflow_history);
  const proven = evidence.size
    ? [...evidence.values()]
    : inferredSteps(current, evaluation).map((step, index) => ({
      ...step,
      identity: businessStepIdentity(step.status),
      firstSequence: index,
      firstOccurredAt: step.occurredAt || '',
      lastOccurredAt: step.occurredAt || '',
    }));
  const byIdentity = new Map(proven.map((step) => [step.identity || businessStepIdentity(step.status), step]));
  if (!byIdentity.has(current)) {
    byIdentity.set(current, {
      identity: current,
      status: current,
      firstSequence: byIdentity.size,
      firstOccurredAt: '',
      lastOccurredAt: '',
    });
  }
  guaranteedFutureStatuses(current, [...byIdentity.values()]).forEach((status) => {
    const identity = businessStepIdentity(status);
    if (!identity || byIdentity.has(identity)) return;
    byIdentity.set(identity, {
      identity,
      status: identity,
      firstSequence: byIdentity.size,
      firstOccurredAt: '',
      lastOccurredAt: '',
    });
  });
  const ordered = sortBusinessSteps(byIdentity.values());
  const currentIndex = ordered.findIndex((step) => step.status === current);
  return ordered.map((step, index) => {
    const state = index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming';
    const occurredAt = state === 'upcoming'
      ? ''
      : (state === 'current' ? step.lastOccurredAt : step.firstOccurredAt) || '';
    return {
      status: step.status,
      label: evaluationStatusMeta(step.status).label,
      occurredAt,
      state,
      key: `workflow:${step.identity || step.status}`,
    };
  });
}
