(function initNavigationManifest(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QLCL_NAVIGATION = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function navigationManifestFactory() {
  'use strict';

  const NAVIGATION_VERSION = 9;
  const DEFAULT_FEATURE_FLAGS = Object.freeze({
    ADMIN_UAT_RUNS: false,
  });
  const LEGACY_ROUTE_ALIASES = Object.freeze({
    '/scoring': '/evaluations/scoring',
  });
  const ADMIN_CAPABILITIES = Object.freeze([
    'SYSTEM.ADMIN', 'USER.MANAGE', 'AUDIT.READ', 'AUDIT.EXPORT',
    'REPORT_TEMPLATE.MANAGE', 'REPORT_TEMPLATE.PUBLISH', 'REPORT_TEMPLATE.ADVANCED',
    'QUESTION_TEMPLATE.MANAGE', 'SCORING_POLICY.MANAGE', 'SCORING_POLICY.PUBLISH',
  ]);

  const define = (item) => Object.freeze({
    ...item,
    sidebar: item.sidebar !== false,
    sidebar_active: item.sidebar_active || null,
    admin_module: item.admin_module || null,
    admin_pane: item.admin_pane || null,
    active_match: Object.freeze([...(item.active_match || [])]),
    permissions: Object.freeze([...(item.permissions || [])]),
    breadcrumbs: Object.freeze([...(item.breadcrumbs || [])]),
    version: NAVIGATION_VERSION,
  });

  const NAVIGATION_MANIFEST = Object.freeze([
    define({ id: 'work', kind: 'section', parent: null, route: null, view: null,
      label: 'Công việc', short_label: 'Công việc', description: 'Không gian làm việc và hàng chờ phê duyệt.',
      icon: 'briefcase', order: 10, active_match: [], permissions: [], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: [], contextual: false }),
    define({ id: 'workspace', kind: 'route', parent: 'work', route: '/workspace', view: 'view-workspace',
      label: 'Không gian làm việc', short_label: 'Công việc', description: 'Các nghiệp vụ cần người dùng xử lý theo quyền và phân công.',
      icon: 'workspace', order: 10, active_match: ['/workspace'], permissions: ['EVALUATION.READ'], permission_mode: 'all',
      feature_flag: null, mobile_priority: 1, breadcrumbs: ['work'], contextual: false }),
    define({ id: 'approvals', kind: 'route', parent: 'work', route: '/approvals', view: 'view-approvals',
      label: 'Việc cần phê duyệt', short_label: 'Phê duyệt', description: 'Các phiếu đang chờ người dùng xử lý theo phân công.',
      icon: 'approval', order: 20, active_match: ['/approvals'], permissions: [
        'EVALUATION.APPROVE_LEAD', 'EVALUATION.APPROVE_TBP', 'EVALUATION.APPROVE_GDK',
      ], permission_mode: 'any', feature_flag: null, mobile_priority: 2, breadcrumbs: ['work'], contextual: false }),

    define({ id: 'supplier-business', kind: 'section', parent: null, route: null, view: null,
      label: 'Nghiệp vụ NCC', short_label: 'NCC', description: 'Hồ sơ, đánh giá và danh mục nhà cung cấp.',
      icon: 'supplier', order: 20, active_match: [], permissions: [], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: [], contextual: false }),
    define({ id: 'evaluations', kind: 'route', parent: 'supplier-business', route: '/evaluations', view: 'view-evaluations',
      label: 'Phiếu đánh giá', short_label: 'Đánh giá', description: 'Danh sách phiếu đánh giá chất lượng NCC.',
      icon: 'evaluation', order: 20, active_match: ['/evaluations'], permissions: ['EVALUATION.READ'], permission_mode: 'all',
      feature_flag: null, mobile_priority: 4, breadcrumbs: ['supplier-business'], contextual: false }),
    define({ id: 'evaluation-new', kind: 'route', parent: 'evaluations', route: '/evaluations/new', view: 'view-evaluation-new',
      label: 'Tạo phiếu đánh giá', short_label: 'Tạo phiếu', description: 'Khởi tạo phiếu đánh giá từ danh mục NCC.',
      icon: 'add', order: 21, active_match: ['/evaluations/new'], permissions: ['EVALUATION.CREATE'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['supplier-business', 'evaluations'], contextual: true }),
    define({ id: 'scoring', kind: 'route', parent: 'evaluations', route: '/evaluations/scoring', view: 'view-scoring',
      label: 'Chấm điểm', short_label: 'Chấm điểm', description: 'Chấm điểm và theo dõi khắc phục cho một phiếu đánh giá.',
      icon: 'score', order: 22, active_match: ['/evaluations/scoring', '/evaluations/scoring/*'], permissions: ['EVALUATION.SCORE'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['supplier-business', 'evaluations'], contextual: true }),
    define({ id: 'suppliers', kind: 'route', parent: 'supplier-business', route: '/suppliers', view: 'view-suppliers',
      label: 'Danh mục NCC', short_label: 'Danh mục', description: 'Danh mục nhà cung cấp dùng chung cho các nghiệp vụ.',
      icon: 'supplier', order: 30, active_match: ['/suppliers'], permissions: ['SUPPLIER.READ'], permission_mode: 'all',
      feature_flag: null, mobile_priority: 20, breadcrumbs: ['supplier-business'], contextual: false }),

    define({ id: 'analytics', kind: 'section', parent: null, route: null, view: null,
      label: 'Báo cáo & phân tích', short_label: 'Phân tích', description: 'Báo cáo vận hành và các lát cắt chất lượng.',
      icon: 'analytics', order: 30, active_match: [], permissions: [], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: [], contextual: false }),
    define({ id: 'overview', kind: 'route', parent: 'analytics', route: '/dashboard', view: 'view-overview',
      label: 'Báo cáo thống kê', short_label: 'Thống kê', description: 'Báo cáo thống kê chất lượng nhà cung cấp theo kỳ.',
      icon: 'workspace', order: 10, active_match: ['/dashboard'], permissions: ['DASHBOARD.READ'], permission_mode: 'all',
      feature_flag: null, mobile_priority: 30, breadcrumbs: ['analytics'], contextual: false }),
    define({ id: 'reports', kind: 'route', parent: 'evaluations', route: '/reports', view: 'view-reports',
      label: 'Báo cáo', short_label: 'Báo cáo', description: 'Tìm, xem và xuất báo cáo đánh giá NCC.',
      icon: 'report', order: 23, active_match: ['/reports'], permissions: ['REPORT.READ'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['supplier-business', 'evaluations'], contextual: true }),
    define({ id: 'administration', kind: 'section', parent: null, route: null, view: null,
      label: 'Quản trị', short_label: 'Quản trị', description: 'Cấu hình hệ thống và kiểm soát truy cập.',
      icon: 'settings', order: 40, active_match: [], permissions: [], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: [], contextual: false }),
    define({ id: 'admin', kind: 'route', parent: 'administration', route: '/admin', view: 'view-admin',
      label: 'Trung tâm quản trị', short_label: 'Quản trị', description: 'Điểm vào các module quản trị được cấp quyền.',
      icon: 'settings', order: 10, active_match: ['/admin'], permissions: ADMIN_CAPABILITIES,
      permission_mode: 'any', feature_flag: null, mobile_priority: 40, breadcrumbs: ['administration'], contextual: false }),
    define({ id: 'admin-people-access', kind: 'group', parent: 'admin', route: null, view: null,
      label: 'Nhân sự & phân quyền', short_label: 'Nhân sự', description: 'Quản lý nhân sự, vai trò, phạm vi dữ liệu và phân công phê duyệt.',
      icon: 'users', order: 10, active_match: [], permissions: [], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin'], contextual: false }),
    define({ id: 'admin-users', kind: 'route', parent: 'admin-people-access', route: '/admin/users', view: 'view-admin',
      label: 'Danh sách nhân sự', short_label: 'Nhân sự', description: 'Quản lý tài khoản, nhiều vai trò, thời hạn và quyền hiệu lực.',
      icon: 'users', order: 10, active_match: ['/admin/users'], permissions: ['USER.MANAGE'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin', 'admin-people-access'], contextual: false,
      admin_module: 'authorization', admin_pane: 'users' }),
    define({ id: 'admin-roles', kind: 'route', parent: 'admin-people-access', route: '/admin/roles', view: 'view-admin',
      label: 'Vai trò & tổ hợp quyền', short_label: 'Vai trò', description: 'Quản lý vai trò tùy chỉnh, clone vai trò và ma trận ALLOW/DENY.',
      icon: 'users', order: 20, active_match: ['/admin/roles'], permissions: ['USER.MANAGE'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin', 'admin-people-access'], contextual: false,
      admin_module: 'authorization', admin_pane: 'roles' }),
    define({ id: 'admin-personnel-import', kind: 'route', parent: 'admin-people-access', route: '/admin/personnel-import', view: 'view-admin',
      label: 'Nhập nhân sự & mapping', short_label: 'Nhập nhân sự', description: 'Chuẩn bị nhập nhân sự theo lô và mapping vào vai trò hiện hữu.',
      icon: 'upload', order: 30, active_match: ['/admin/personnel-import'], permissions: ['USER.MANAGE'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin', 'admin-people-access'], contextual: false,
      admin_module: 'personnel-import', admin_pane: null }),
    define({ id: 'admin-data-scopes', kind: 'route', parent: 'admin-people-access', route: '/admin/data-scopes', view: 'view-admin',
      label: 'Phạm vi dữ liệu', short_label: 'Phạm vi', description: 'Quản lý phạm vi dữ liệu theo người dùng, vai trò và thời hạn hiệu lực.',
      icon: 'settings', order: 40, active_match: ['/admin/data-scopes'], permissions: ['USER.MANAGE'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin', 'admin-people-access'], contextual: false,
      admin_module: 'authorization', admin_pane: 'scopes' }),
    define({ id: 'admin-approval-assignments', kind: 'route', parent: 'admin-people-access', route: '/admin/approval-assignments', view: 'view-admin',
      label: 'Phân công phê duyệt', short_label: 'Phân công', description: 'Xem trước và công bố phân công phê duyệt theo scope và độ ưu tiên.',
      icon: 'approval', order: 50, active_match: ['/admin/approval-assignments'], permissions: ['USER.MANAGE'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin', 'admin-people-access'], contextual: false,
      admin_module: 'authorization', admin_pane: 'approvals' }),

    define({ id: 'admin-business-config', kind: 'group', parent: 'admin', route: null, view: null,
      label: 'Cấu hình nghiệp vụ', short_label: 'Nghiệp vụ', description: 'Quản lý cấu hình phiên bản cho câu hỏi, báo cáo, tính điểm và cảnh báo.',
      icon: 'settings', order: 20, active_match: [], permissions: [], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin'], contextual: false }),
    define({ id: 'admin-question-templates', kind: 'route', parent: 'admin-business-config', route: '/admin/question-templates', view: 'view-admin',
      label: 'Bộ câu hỏi đánh giá', short_label: 'Bộ câu hỏi', description: 'Quản lý mẫu và câu hỏi đánh giá NCC.',
      icon: 'questions', order: 10, active_match: ['/admin/question-templates'], permissions: ['QUESTION_TEMPLATE.MANAGE'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin', 'admin-business-config'], contextual: false,
      admin_module: 'question-templates', admin_pane: null }),
    define({ id: 'admin-report-templates', kind: 'route', parent: 'admin-business-config', route: '/admin/report-templates', view: 'view-admin',
      label: 'Mẫu báo cáo', short_label: 'Mẫu báo cáo', description: 'Quản lý mẫu báo cáo đánh giá.',
      icon: 'template', order: 20, active_match: ['/admin/report-templates'], permissions: ['REPORT_TEMPLATE.MANAGE'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin', 'admin-business-config'], contextual: false,
      admin_module: 'report-templates', admin_pane: null }),
    define({ id: 'admin-scoring-policies', kind: 'route', parent: 'admin-business-config', route: '/admin/scoring-policies', view: 'view-admin',
      label: 'Chính sách tính điểm', short_label: 'Tính điểm', description: 'Quản lý phiên bản công thức, band, penalty và quy tắc kết luận.',
      icon: 'threshold', order: 30, active_match: ['/admin/scoring-policies'], permissions: ['SCORING_POLICY.MANAGE'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin', 'admin-business-config'], contextual: false,
      admin_module: 'scoring-policies', admin_pane: null }),
    define({ id: 'admin-system-operations', kind: 'group', parent: 'admin', route: null, view: null,
      label: 'Vận hành hệ thống', short_label: 'Vận hành', description: 'Theo dõi tải dữ liệu, audit và UAT được bật theo feature flag.',
      icon: 'settings', order: 30, active_match: [], permissions: [], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin'], contextual: false }),
    define({ id: 'admin-system-logs', kind: 'route', parent: 'admin-system-operations', route: '/admin/system-logs', view: 'view-admin',
      label: 'Nhật ký hệ thống', short_label: 'Nhật ký', description: 'Tìm kiếm và xem chi tiết sự kiện audit.',
      icon: 'audit', order: 20, active_match: ['/admin/system-logs'], permissions: ['AUDIT.READ'], permission_mode: 'all',
      feature_flag: null, mobile_priority: null, breadcrumbs: ['administration', 'admin', 'admin-system-operations'], contextual: false,
      admin_module: 'system-logs', admin_pane: null }),
    define({ id: 'admin-uat-runs', kind: 'route', parent: 'admin-system-operations', route: '/admin/uat-runs', view: 'view-admin-uat-runs',
      label: 'UAT runs', short_label: 'UAT', description: 'Theo dõi các lần chạy UAT khi module được phát hành.',
      icon: 'test', order: 30, active_match: ['/admin/uat-runs'], permissions: ['SYSTEM.ADMIN'], permission_mode: 'all',
      feature_flag: 'ADMIN_UAT_RUNS', mobile_priority: null, breadcrumbs: ['administration', 'admin', 'admin-system-operations'], contextual: false,
      admin_module: 'uat-runs', admin_pane: null }),
  ]);

  const byId = new Map(NAVIGATION_MANIFEST.map((item) => [item.id, item]));

  function resolvedFlags(flags) {
    return { ...DEFAULT_FEATURE_FLAGS, ...(flags || {}) };
  }

  function isFeatureEnabled(item, flags) {
    return !item.feature_flag || resolvedFlags(flags)[item.feature_flag] === true;
  }

  function hasPermissions(item, capabilities) {
    const required = item.permissions || [];
    if (!required.length) return true;
    const granted = new Set(capabilities || []);
    return item.permission_mode === 'any'
      ? required.some((permission) => granted.has(permission))
      : required.every((permission) => granted.has(permission));
  }

  function canAccessItem(item, capabilities, flags) {
    return Boolean(item) && isFeatureEnabled(item, flags) && hasPermissions(item, capabilities);
  }

  function visibleNavigation(capabilities, flags) {
    const visibleIds = new Set();
    const leaves = NAVIGATION_MANIFEST.filter((item) => item.kind === 'route' && !item.contextual)
      .filter((item) => canAccessItem(item, capabilities, flags));
    const includeWithParents = (item) => {
      if (!item || visibleIds.has(item.id)) return;
      visibleIds.add(item.id);
      includeWithParents(byId.get(item.parent));
    };
    leaves.forEach(includeWithParents);
    return NAVIGATION_MANIFEST.filter((item) => visibleIds.has(item.id))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  function sidebarNavigation(capabilities, flags) {
    const visible = visibleNavigation(capabilities, flags);
    const visibleIds = new Set(visible.map((item) => item.id));
    const sidebarIds = new Set();
    const includeWithParents = (item) => {
      if (!item || !visibleIds.has(item.id) || sidebarIds.has(item.id)) return;
      sidebarIds.add(item.id);
      includeWithParents(byId.get(item.parent));
    };
    visible.filter((item) => item.kind === 'route' && item.sidebar).forEach(includeWithParents);
    return visible.filter((item) => sidebarIds.has(item.id));
  }

  function mobilePrimary(capabilities, flags) {
    return sidebarNavigation(capabilities, flags)
      .filter((item) => item.kind === 'route' && Number.isFinite(item.mobile_priority))
      .sort((left, right) => left.mobile_priority - right.mobile_priority || left.order - right.order)
      .slice(0, 4);
  }

  function groupedNavigationFor(parentId, capabilities, flags) {
    const visible = visibleNavigation(capabilities, flags);
    const visibleIds = new Set(visible.map((item) => item.id));
    return NAVIGATION_MANIFEST
      .filter((item) => item.kind === 'group' && item.parent === parentId && visibleIds.has(item.id))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((group) => ({
        group,
        items: NAVIGATION_MANIFEST
          .filter((item) => item.kind === 'route' && item.parent === group.id && visibleIds.has(item.id))
          .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
      }))
      .filter(({ items }) => items.length);
  }

  function moduleNavigationFor(id, capabilities, flags) {
    const current = byId.get(id);
    if (!current) return [];
    const trail = [...current.breadcrumbs, current.id].map((itemId) => byId.get(itemId)).filter(Boolean);
    const moduleRoot = trail.find((candidate) => candidate.kind === 'route' &&
      NAVIGATION_MANIFEST.filter((item) => item.kind === 'route' && item.parent === candidate.id).length >= 2);
    if (moduleRoot) {
      return NAVIGATION_MANIFEST
        .filter((item) => item.kind === 'route' && (item.id === moduleRoot.id || item.parent === moduleRoot.id))
        .filter((item) => canAccessItem(item, capabilities, flags))
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    }
    const section = trail.find((item) => item.kind === 'section');
    if (!section) return [];
    return visibleNavigation(capabilities, flags)
      .filter((item) => item.kind === 'route' && item.parent === section.id);
  }

  function matchRoute(item, route) {
    const normalized = String(route || '').split('?')[0].replace(/\/$/, '') || '/dashboard';
    return [item.route, ...(item.active_match || [])].filter(Boolean).some((pattern) => {
      if (pattern.endsWith('/*')) return normalized.startsWith(pattern.slice(0, -1));
      return normalized === String(pattern).replace(/\/$/, '');
    });
  }

  function resolveRoute(route, capabilities, flags) {
    const requestedRoute = String(route || '').trim() || '/dashboard';
    const queryIndex = requestedRoute.indexOf('?');
    const requestedPath = (queryIndex >= 0 ? requestedRoute.slice(0, queryIndex) : requestedRoute).replace(/\/$/, '') || '/dashboard';
    const query = queryIndex >= 0 ? requestedRoute.slice(queryIndex) : '';
    const canonicalPath = LEGACY_ROUTE_ALIASES[requestedPath] || requestedPath;
    const canonicalRoute = canonicalPath + query;
    const item = NAVIGATION_MANIFEST.find((candidate) => candidate.route && matchRoute(candidate, canonicalRoute));
    const redirect = canonicalPath !== requestedPath ? { redirected_from: requestedRoute } : {};
    if (!item) return { status: 'not_found', item: null, canonical_route: canonicalRoute, ...redirect };
    if (!isFeatureEnabled(item, flags)) return { status: 'feature_off', item, canonical_route: canonicalRoute, ...redirect };
    if (!hasPermissions(item, capabilities)) return { status: 'denied', item, canonical_route: canonicalRoute, ...redirect };
    return { status: 'allowed', item, canonical_route: canonicalRoute, ...redirect };
  }

  function breadcrumbsFor(id) {
    const item = byId.get(id);
    if (!item) return [];
    return [...item.breadcrumbs, item.id].map((crumbId) => byId.get(crumbId)).filter(Boolean)
      .map((crumb) => ({ id: crumb.id, label: crumb.label, route: crumb.route, contextual: crumb.contextual }));
  }

  function validateManifest() {
    const errors = [];
    const required = ['id', 'parent', 'route', 'view', 'label', 'short_label', 'description', 'icon', 'order',
      'active_match', 'permissions', 'feature_flag', 'mobile_priority', 'breadcrumbs', 'contextual',
      'sidebar', 'sidebar_active', 'admin_module', 'admin_pane', 'version'];
    const ids = new Set();
    const routes = new Set();
    const mobilePriorities = new Set();
    for (const item of NAVIGATION_MANIFEST) {
      for (const field of required) if (!Object.prototype.hasOwnProperty.call(item, field)) errors.push(`${item.id || 'unknown'}.${field}:missing`);
      if (ids.has(item.id)) errors.push(`${item.id}:duplicate_id`);
      ids.add(item.id);
      if (item.route) {
        if (routes.has(item.route)) errors.push(`${item.id}:duplicate_route`);
        routes.add(item.route);
      }
      if (item.parent && !byId.has(item.parent)) errors.push(`${item.id}:parent_missing`);
      if (item.version !== NAVIGATION_VERSION) errors.push(`${item.id}:version_mismatch`);
      if (!Array.isArray(item.active_match)) errors.push(`${item.id}:active_match_invalid`);
      if (!Array.isArray(item.permissions)) errors.push(`${item.id}:permissions_invalid`);
      if (!Array.isArray(item.breadcrumbs)) errors.push(`${item.id}:breadcrumbs_invalid`);
      if (typeof item.sidebar !== 'boolean') errors.push(`${item.id}:sidebar_invalid`);
      if (item.sidebar_active && !byId.has(item.sidebar_active)) errors.push(`${item.id}:sidebar_active_missing`);
      for (const crumb of item.breadcrumbs || []) if (!byId.has(crumb)) errors.push(`${item.id}:breadcrumb_missing:${crumb}`);
      if (item.permissions.includes(item.label)) errors.push(`${item.id}:label_is_permission`);
      if (item.feature_flag && !Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, item.feature_flag)) errors.push(`${item.id}:feature_flag_unknown`);
      if (Number.isFinite(item.mobile_priority)) {
        if (mobilePriorities.has(item.mobile_priority)) errors.push(`${item.id}:duplicate_mobile_priority`);
        mobilePriorities.add(item.mobile_priority);
      }
    }
    return errors.sort();
  }

  return Object.freeze({
    NAVIGATION_VERSION,
    DEFAULT_FEATURE_FLAGS,
    LEGACY_ROUTE_ALIASES,
    ADMIN_CAPABILITIES,
    NAVIGATION_MANIFEST,
    validateManifest,
    isFeatureEnabled,
    hasPermissions,
    canAccessItem,
    visibleNavigation,
    sidebarNavigation,
    mobilePrimary,
    groupedNavigationFor,
    moduleNavigationFor,
    resolveRoute,
    breadcrumbsFor,
  });
});
