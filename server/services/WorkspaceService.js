'use strict';

const MODULE_LABELS = Object.freeze({
  EVALUATION: 'Phiếu đánh giá',
});

const PRIORITY_RANK = Object.freeze({ URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 });

function dateOnly(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDate(value, timeZone = process.env.APP_TIMEZONE || 'Asia/Bangkok') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function distinctBy(items, keySelector) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    const key = keySelector(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

class WorkspaceService {
  constructor({ providers = [], clock = () => new Date() } = {}) {
    this.providers = providers;
    this.clock = clock;
  }

  async getWorkspace({ user, query = {} }) {
    const today = calendarDate(this.clock());
    const dueSoonEnd = addDays(today, 7);
    const context = { today, dueSoonEnd, clock: this.clock };
    const providerResults = await Promise.all(this.providers.map(async (provider) => ({
      pending: await provider.pending(user, context),
      recent: await provider.recent(user, context),
    })));

    const allPending = distinctBy(
      providerResults.flatMap((result) => result.pending || []),
      (item) => item.work_group_key
    ).map((item) => this.normalizePending(item, today));
    const allRecent = providerResults.flatMap((result) => result.recent || [])
      .sort((a, b) => String(b.acted_at || '').localeCompare(String(a.acted_at || '')));
    const allRecentDistinct = distinctBy(allRecent, (item) => item.work_group_key);
    const recentDistinct = allRecentDistinct.slice(0, 3);

    const normalizedQuery = {
      q: String(query.q || '').trim().toLocaleLowerCase('vi'),
      status: String(query.status || '').trim(),
      module: String(query.module || '').trim().toUpperCase(),
      due: String(query.due || '').trim().toLowerCase(),
    };
    const filtered = allPending.filter((item) => {
      if (normalizedQuery.module && item.module !== normalizedQuery.module) return false;
      if (normalizedQuery.status && item.status !== normalizedQuery.status) return false;
      const dueDate = dateOnly(item.due_date);
      const overdue = !!dueDate && dueDate < today;
      const dueSoon = !!dueDate && dueDate >= today && dueDate <= dueSoonEnd;
      if (normalizedQuery.due === 'overdue' && !overdue) return false;
      if (normalizedQuery.due === 'due_soon' && !dueSoon) return false;
      if (normalizedQuery.due === 'no_due' && dueDate) return false;
      if (normalizedQuery.q) {
        const haystack = [item.entity_code, item.supplier_name, item.task_label, item.status]
          .filter(Boolean).join(' ').toLocaleLowerCase('vi');
        if (!haystack.includes(normalizedQuery.q)) return false;
      }
      return true;
    }).sort((a, b) => {
      const priority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
      if (priority) return priority;
      if (Number(b.overdue_days || 0) !== Number(a.overdue_days || 0)) {
        return Number(b.overdue_days || 0) - Number(a.overdue_days || 0);
      }
      return String(a.due_date || '9999-12-31').localeCompare(String(b.due_date || '9999-12-31'));
    });

    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const requestedPageSize = Number.parseInt(query.page_size, 10) || 20;
    const pageSize = Math.max(1, Math.min(100, requestedPageSize));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);

    return {
      summary: {
        need_action: total,
        overdue: filtered.filter((item) => item.due_date && item.due_date < today).length,
        due_soon: filtered.filter((item) => item.due_date && item.due_date >= today && item.due_date <= dueSoonEnd).length,
        handled_recent: allRecentDistinct.length,
      },
      items: pageItems,
      recent: recentDistinct,
      pagination: { page, page_size: pageSize, total, total_pages: totalPages },
      available_filters: {
        modules: distinctBy(allPending, (item) => item.module).map((item) => ({
          value: item.module,
          label: MODULE_LABELS[item.module] || item.module,
        })),
        statuses: [...new Set(allPending.map((item) => item.status).filter(Boolean))],
        due_states: [
          { value: 'overdue', label: 'Đã quá hạn' },
          { value: 'due_soon', label: 'Sắp đến hạn' },
          { value: 'no_due', label: 'Không có hạn' },
        ],
      },
    };
  }

  normalizePending(item, today) {
    const dueDate = dateOnly(item.due_date);
    const overdueDays = dueDate && dueDate < today
      ? Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${dueDate}T12:00:00Z`)) / 86400000)
      : 0;
    return {
      ...item,
      due_date: dueDate,
      overdue_days: overdueDays,
      priority: overdueDays > 0 ? 'URGENT' : (item.priority || 'MEDIUM'),
      action_label: 'Mở xử lý',
    };
  }
}

module.exports = { WorkspaceService, MODULE_LABELS, dateOnly, calendarDate };
