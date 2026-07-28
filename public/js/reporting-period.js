(function initReportingPeriod(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QLCL_REPORTING_PERIOD = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function reportingPeriodFactory() {
  'use strict';

  function isValidPeriod(value) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || '').trim());
  }

  function labelForPeriod(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
    return match ? `Tháng ${match[2]}/${match[1]}` : '—';
  }

  function normalizePeriods(items) {
    const byValue = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
      const source = typeof item === 'string' ? { value: item, has_data: true } : (item || {});
      const value = String(source.value || source.report_month || '').trim();
      if (!isValidPeriod(value)) return;
      byValue.set(value, {
        value,
        has_data: source.has_data !== false,
        is_current: source.is_current === true,
        updated_at: source.updated_at || null,
      });
    });
    return Array.from(byValue.values()).sort((a, b) => b.value.localeCompare(a.value));
  }

  function periodFromRoute(route) {
    const text = String(route || '');
    const queryIndex = text.indexOf('?');
    if (queryIndex < 0) return '';
    const value = new URLSearchParams(text.slice(queryIndex + 1)).get('period') || '';
    return isValidPeriod(value) ? value : '';
  }

  function routeWithPeriod(route, period) {
    const text = String(route || '/dashboard');
    const queryIndex = text.indexOf('?');
    const path = queryIndex < 0 ? text : text.slice(0, queryIndex);
    const params = new URLSearchParams(queryIndex < 0 ? '' : text.slice(queryIndex + 1));
    if (isValidPeriod(period)) params.set('period', period);
    else params.delete('period');
    const query = params.toString();
    return path + (query ? `?${query}` : '');
  }

  function adjacentPeriods(items, selected) {
    const periods = normalizePeriods(items);
    const index = periods.findIndex((item) => item.value === selected);
    if (index < 0) return { previous: '', next: '' };
    return {
      previous: periods[index + 1]?.value || '',
      next: periods[index - 1]?.value || '',
    };
  }

  function selectInitialPeriod({ urlPeriod, sessionPeriod, currentPeriod, periods }) {
    const normalized = normalizePeriods(periods);
    const withData = normalized.filter((item) => item.has_data);
    if (isValidPeriod(urlPeriod)) return { value: urlPeriod, source: 'url', fallback_from_current: false };
    if (isValidPeriod(sessionPeriod)) return { value: sessionPeriod, source: 'session', fallback_from_current: false };
    const current = normalized.find((item) => item.value === currentPeriod);
    if (current?.has_data) return { value: currentPeriod, source: 'current', fallback_from_current: false };
    if (withData.length) {
      const monthIndex = (value) => {
        const [year, month] = String(value).split('-').map(Number);
        return (year * 12) + month;
      };
      const currentIndex = isValidPeriod(currentPeriod) ? monthIndex(currentPeriod) : null;
      const nearest = currentIndex == null ? withData[0] : [...withData].sort((a, b) => {
        const aDistance = Math.abs(monthIndex(a.value) - currentIndex);
        const bDistance = Math.abs(monthIndex(b.value) - currentIndex);
        if (aDistance !== bDistance) return aDistance - bDistance;
        const aIsPast = a.value <= currentPeriod;
        const bIsPast = b.value <= currentPeriod;
        if (aIsPast !== bIsPast) return aIsPast ? -1 : 1;
        return b.value.localeCompare(a.value);
      })[0];
      return { value: nearest.value, source: 'nearest', fallback_from_current: true };
    }
    return { value: isValidPeriod(currentPeriod) ? currentPeriod : '', source: 'current-empty', fallback_from_current: false };
  }

  return Object.freeze({
    adjacentPeriods,
    isValidPeriod,
    labelForPeriod,
    normalizePeriods,
    periodFromRoute,
    routeWithPeriod,
    selectInitialPeriod,
  });
});
