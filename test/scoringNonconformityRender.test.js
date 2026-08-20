'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extractFunction(name) {
  const pattern = new RegExp(`(?:async\\s+)?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`);
  const match = appSource.match(pattern);
  assert.ok(match, `Missing production function ${name}`);
  return match[0];
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.value = '';
    this.disabled = false;
    this._textContent = '';
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\\s+/).filter(Boolean));
        names.forEach((name) => current.add(name));
        this.className = Array.from(current).join(' ');
      },
      toggle: (name, enabled) => {
        const current = new Set(this.className.split(/\\s+/).filter(Boolean));
        if (enabled) current.add(name); else current.delete(name);
        this.className = Array.from(current).join(' ');
      },
    };
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  set textContent(value) {
    this._textContent = String(value ?? '');
    if (this._textContent === '') this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent || '').join('');
  }
}

function descendants(node, tagName) {
  const expected = String(tagName).toUpperCase();
  const result = [];
  const visit = (current) => {
    if (current.tagName === expected) result.push(current);
    current.children.forEach(visit);
  };
  visit(node);
  return result;
}

function createHarness(overrides = {}) {
  const elements = {
    'nonconformity-tbody': new FakeElement('tbody'),
    'nonconformity-count': new FakeElement('span'),
    'nonconformity-empty': new FakeElement('div'),
    'scoring-msg': new FakeElement('p'),
  };
  const state = { scoringDraftCorrectiveRequirements: {} };
  const consoleErrors = [];
  const el = (tagName, options = {}) => {
    const node = new FakeElement(tagName);
    node.className = options.className || '';
    if (Object.prototype.hasOwnProperty.call(options, 'text')) node.textContent = options.text;
    Object.entries(options.attrs || {}).forEach(([name, value]) => node.setAttribute(name, value));
    return node;
  };
  const labeledTd = (label, options) => {
    const td = el('td', options || {});
    td.setAttribute('data-label', label);
    return td;
  };
  const context = {
    state,
    scoringValidationTarget: null,
    CORRECTIVE_REQUIREMENT_OPTIONS: ['Bổ sung hồ sơ', 'Khắc phục tại cơ sở'],
    $: (id) => elements[id],
    el,
    labeledTd,
    document: { createElement: (tagName) => new FakeElement(tagName) },
    resourceCan: (ticket, action) => Boolean(ticket && action === 'score' && ticket.allowed_actions?.includes('score')),
    issueMatchesNonconformity: () => false,
    localTodayISODate: () => '2026-08-03',
    console: { error: (...args) => consoleErrors.push(args) },
    ...overrides,
  };
  const functionNames = [
    'isValidISODate',
    'addCalendarDaysISODate',
    'dateInputValue',
    'correctionRowLocked',
    'nonconformityQuestionKey',
    'draftCorrectiveRequirementKey',
    'draftCorrectiveRequirementStore',
    'evaluationDateForNonconformities',
    'defaultCorrectionDueDateForTicket',
    'currentRoundNonconformityRows',
    'nonconformityDisplayRow',
    'renderNonconformityErrorState',
    'handleScoringRenderError',
    'renderNonconformities',
  ];
  const factory = new Function(
    ...Object.keys(context),
    `${functionNames.map(extractFunction).join('\n')}\nreturn { ${functionNames.join(', ')} };`,
  );
  return { ...factory(...Object.values(context)), elements, state, consoleErrors };
}

function ticket(overrides = {}) {
  return {
    code: 'RUN05-TICKET',
    status: 'Đang xử lý',
    current_round_no: 1,
    actual_evaluation_date_iso: '2026-08-03',
    planned_iso: '2026-08-01',
    scoringLocked: false,
    allowed_actions: ['score'],
    nonconformities: [],
    ...overrides,
  };
}

function question(id, score, note) {
  return {
    id: String(id),
    question_item_id: Number(id),
    section: `Hạng mục ${id}`,
    question_code: `DK-${id}`,
    question: `Điều khoản ${id}`,
    score,
    note,
  };
}

test('RUN-05 resolves the evaluation date from actual evaluation date only', () => {
  const harness = createHarness();
  assert.equal(harness.evaluationDateForNonconformities(ticket()), '2026-08-03');
  assert.equal(harness.evaluationDateForNonconformities(ticket({ actual_evaluation_date_iso: '' }),),'');
  assert.equal(harness.evaluationDateForNonconformities(ticket({ actual_evaluation_date_iso: '', planned_iso: '' }),), '');
});

test('RUN-05 defaults correction due date to 7 days after actual evaluation date', () => {
  const harness = createHarness();

  assert.equal(
    harness.defaultCorrectionDueDateForTicket(ticket()),
    '2026-08-10',
  );
});

test('RUN-05 does not default correction due date before evaluation is completed', () => {
  const harness = createHarness();

  assert.equal(
    harness.defaultCorrectionDueDateForTicket(
      ticket({ actual_evaluation_date_iso: '' }),
    ),
    '',
  );
});

test('RUN-05 renders one temporary D finding with editable corrective fields and +7 day default', () => {
  const harness = createHarness();
  const selected = ticket();
  const rows = harness.currentRoundNonconformityRows(selected, [question(101, 'D', 'Thiếu hồ sơ kiểm soát')]);

  assert.doesNotThrow(() => harness.renderNonconformities(rows, selected));
  assert.equal(harness.elements['nonconformity-tbody'].children.length, 1);
  assert.equal(harness.elements['nonconformity-count'].textContent, '1 điều khoản');
  assert.match(harness.elements['nonconformity-tbody'].textContent, /Hạng mục 101/);
  assert.match(harness.elements['nonconformity-tbody'].textContent, /DK-101/);
  assert.match(harness.elements['nonconformity-tbody'].textContent, /D/);
  assert.match(harness.elements['nonconformity-tbody'].textContent, /Thiếu hồ sơ kiểm soát/);

  const selects = descendants(harness.elements['nonconformity-tbody'], 'select');
  const inputs = descendants(harness.elements['nonconformity-tbody'], 'input');
  assert.equal(selects.length, 1, 'Yêu cầu khắc phục phải nhập được trước khi lưu');
  assert.equal(inputs.length, 1, 'Thời hạn khắc phục phải nhập được trước khi lưu');
  assert.equal(inputs[0].value, '2026-08-10');
  assert.equal(inputs[0].getAttribute('min'), '2026-08-03');
  assert.deepEqual(harness.consoleErrors, []);
});

test('RUN-05 renders every current-round B/C/D and excludes A/NA', () => {
  const harness = createHarness();
  const selected = ticket();
  const rows = harness.currentRoundNonconformityRows(selected, [
    question(1, 'A', ''),
    question(2, 'B', 'Ghi chú B'),
    question(3, 'C', 'Ghi chú C'),
    question(4, 'D', 'Ghi chú D'),
    question(5, 'NA', 'Không áp dụng'),
  ]);

  harness.renderNonconformities(rows, selected);
  assert.equal(rows.length, 3);
  assert.equal(harness.elements['nonconformity-tbody'].children.length, 3);
  assert.match(harness.elements['nonconformity-tbody'].textContent, /DK-2/);
  assert.match(harness.elements['nonconformity-tbody'].textContent, /DK-3/);
  assert.match(harness.elements['nonconformity-tbody'].textContent, /DK-4/);
  assert.doesNotMatch(harness.elements['nonconformity-tbody'].textContent, /DK-1|DK-5/);
});

test('RUN-05 saved findings are authoritative after reload without duplicates or lost corrective values', () => {
  const harness = createHarness();
  const saved = {
    id: 9001,
    evaluation_answer_id: 7001,
    question_item_id: 101,
    round_no: 1,
    severity: 'D',
    clause_code: 'DK-101',
    category: 'Hạng mục 101',
    nonconformity_content: 'Thiếu hồ sơ kiểm soát',
    remediation_content: 'Bổ sung hồ sơ',
    remediation: 'Bổ sung hồ sơ',
    due_date: '2026-08-15',
    status: 'OPEN',
  };
  const selected = ticket({ nonconformities: [saved] });
  const rows = harness.currentRoundNonconformityRows(selected, [question(101, 'D', 'Thiếu hồ sơ kiểm soát')]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 9001);
  assert.equal(rows[0].remediation, 'Bổ sung hồ sơ');
  assert.equal(rows[0].due_date, '2026-08-15');
  harness.renderNonconformities(rows, selected);
  assert.equal(harness.elements['nonconformity-tbody'].children.length, 1);
  assert.equal(descendants(harness.elements['nonconformity-tbody'], 'select')[0].value, 'Bổ sung hồ sơ');
  assert.equal(descendants(harness.elements['nonconformity-tbody'], 'input')[0].value, '2026-08-15');
});

test('RUN-05 changing B/C/D to A/NA removes findings and a locked round is read-only', () => {
  const harness = createHarness();
  const persisted = {
    id: 9001,
    evaluation_answer_id: 7001,
    question_item_id: 101,
    round_no: 1,
    severity: 'D',
    remediation: 'Bổ sung hồ sơ',
    due_date: '2026-08-15',
  };
  const editable = ticket({ nonconformities: [persisted] });
  assert.deepEqual(harness.currentRoundNonconformityRows(editable, []), []);

  const locked = ticket({ scoringLocked: true, nonconformities: [persisted] });
  const rows = harness.currentRoundNonconformityRows(locked, null);
  harness.renderNonconformities(rows, locked);
  assert.equal(descendants(harness.elements['nonconformity-tbody'], 'select').length, 0);
  assert.equal(descendants(harness.elements['nonconformity-tbody'], 'input').length, 0);
});

test('RUN-05 separates API load failures from render failures and leaves an explained table state', async () => {
  const messages = { 'scoring-msg': new FakeElement('p') };
  let renderCalls = 0;
  let renderErrors = 0;
  const dependencies = {
    $: (id) => messages[id],
    loadRoundData: async () => { throw new Error('synthetic_api_failure'); },
    renderScoring: () => { renderCalls += 1; },
    handleScoringRenderError: () => { renderErrors += 1; },
  };
  const loadFactory = new Function(
    ...Object.keys(dependencies),
    `${extractFunction('loadScoringRoundAndRender')}\nreturn loadScoringRoundAndRender;`,
  );
  const load = loadFactory(...Object.values(dependencies));
  await load(ticket());
  assert.equal(messages['scoring-msg'].textContent, 'Không tải được dữ liệu chấm điểm.');
  assert.equal(renderCalls, 0);
  assert.equal(renderErrors, 0);

  const harness = createHarness();
  harness.handleScoringRenderError(new ReferenceError('synthetic render reference'));
  assert.notEqual(harness.elements['scoring-msg'].textContent, 'Không tải được dữ liệu chấm điểm.');
  assert.equal(harness.elements['nonconformity-tbody'].children.length, 1);
  assert.match(harness.elements['nonconformity-tbody'].textContent, /Không thể hiển thị bảng điểm không phù hợp/);
});
