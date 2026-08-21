(function initBusinessConfigurationWorkspace(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QLCL_BUSINESS_CONFIG = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function businessConfigurationWorkspaceFactory() {
  'use strict';

  const LIFECYCLE_LABELS = Object.freeze([
    'Thông tin',
    'Nội dung',
    'Kiểm tra',
    'Gửi duyệt',
    'Published',
  ]);
  const READ_ONLY_STATUSES = new Set(['PUBLISHED', 'RETIRED']);
  const ACTIVE_LIFECYCLE_INDEX = Object.freeze({
    DRAFT: 1,
    IN_REVIEW: 3,
    PUBLISHED: 4,
    RETIRED: 4,
  });
  const STATUS_LABELS = Object.freeze({ DRAFT: 'Bản nháp', IN_REVIEW: 'Chờ duyệt', PUBLISHED: 'Đã phát hành', RETIRED: 'Ngừng áp dụng' });

  function normalizedStatus(value) {
    return String(value || '').trim().toUpperCase();
  }

  function lifecycleFor(status) {
    const normalized = normalizedStatus(status);
    const current = Object.prototype.hasOwnProperty.call(ACTIVE_LIFECYCLE_INDEX, normalized)
      ? ACTIVE_LIFECYCLE_INDEX[normalized]
      : 0;
    return LIFECYCLE_LABELS.map((label, index) => ({
      label,
      state: normalized === 'RETIRED'
        ? 'complete'
        : index < current ? 'complete' : index === current ? 'current' : 'pending',
    }));
  }

  function statusLabel(status) {
    const normalized = normalizedStatus(status);
    return STATUS_LABELS[normalized] || String(status || '—');
  }

  function versionState(version = {}) {
    const status = normalizedStatus(version.status);
    return Object.freeze({
      status,
      readOnly: READ_ONLY_STATUSES.has(status),
      lifecycle: lifecycleFor(status),
    });
  }

  function actionState(resource = {}, actionId) {
    const allowed = Array.isArray(resource.allowed_actions) && resource.allowed_actions.includes(actionId);
    if (allowed) return { state: 'enabled', reason: '' };
    const reason = resource.disabled_reasons?.[actionId] || 'action_unavailable';
    if (reason === 'forbidden_permission') return { state: 'hidden', reason };
    if (Object.prototype.hasOwnProperty.call(resource.disabled_reasons || {}, actionId)) {
      return { state: 'disabled', reason };
    }
    return { state: 'hidden', reason };
  }

  function surfaceState(input = {}) {
    if (input.loading) return { state: 'loading', message: input.message || 'Đang tải dữ liệu…' };
    if (Number(input.status) === 403) return { state: 'forbidden', message: input.message || 'Bạn không có quyền mở workspace này.' };
    if (Number(input.status) === 409) return { state: 'conflict', message: input.message || 'Phiên bản đã thay đổi. Hãy tải lại trước khi tiếp tục.' };
    if (input.error) return { state: 'error', message: input.message || 'Không tải được dữ liệu. Hãy thử lại.' };
    if (input.empty) return { state: 'empty', message: input.message || 'Chưa có dữ liệu để hiển thị.' };
    return { state: 'ready', message: input.message || '' };
  }

  function workspaceHash(route, query = {}) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value) !== '') params.set(key, String(value));
    });
    const encoded = params.toString();
    return `#${route}${encoded ? `?${encoded}` : ''}`;
  }

  function renderLifecycle(host, version, options = {}) {
    if (!host || typeof document === 'undefined') return;
    host.textContent = '';
    host.dataset.mode = options.mode === 'readonly' ? 'readonly' : 'versioned';
    if (options.mode === 'readonly' && options.readonlyLabel) host.dataset.readonlyLabel = options.readonlyLabel;
    const model = versionState(version).lifecycle;
    model.forEach((step, index) => {
      const item = document.createElement('li');
      item.dataset.state = step.state;
      item.setAttribute('aria-current', step.state === 'current' ? 'step' : 'false');
      const marker = document.createElement('span');
      marker.className = 'business-config-step-marker';
      marker.textContent = String(index + 1);
      marker.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = step.label;
      item.append(marker, label);
      host.appendChild(item);
    });
  }

  function applyActionState(button, resource, actionId, setReason) {
    if (!button) return { state: 'hidden', reason: 'action_unavailable' };
    const availability = actionState(resource, actionId);
    button.classList.toggle('hidden', availability.state === 'hidden');
    button.disabled = availability.state === 'disabled';
    if (typeof setReason === 'function') setReason(button, availability.state === 'disabled' ? availability.reason : '');
    return availability;
  }

  return Object.freeze({
    LIFECYCLE_LABELS,
    actionState,
    applyActionState,
    lifecycleFor,
    renderLifecycle,
    statusLabel,
    surfaceState,
    versionState,
    workspaceHash,
  });
});
