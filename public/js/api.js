const BASE = '/qlcl/api';
let activeActionContext = null;

function actionRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function withActionRequestContext(context, callback) {
  const previous = activeActionContext;
  activeActionContext = {
    actionId: context?.actionId || '',
    mutation: context?.mutation === true,
    idempotencyKey: context?.idempotencyKey || actionRequestId(),
  };
  try {
    return await callback();
  } finally {
    activeActionContext = previous;
  }
}

export function actionRequestHeaders() {
  if (!activeActionContext?.actionId) return {};
  return {
    'X-Action-Id': activeActionContext.actionId,
    ...(activeActionContext.mutation ? { 'Idempotency-Key': activeActionContext.idempotencyKey } : {}),
  };
}

export async function api(pathUrl, opts) {
  const init = {
    method: (opts && opts.method) || 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  };
  Object.assign(init.headers, actionRequestHeaders());
  if (opts && opts.body && !(opts.body instanceof FormData)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  } else if (opts && opts.body instanceof FormData) {
    init.body = opts.body;
  }
  let res;
  try {
    res = await fetch(BASE + pathUrl, init);
  } catch {
    return { ok: false, status: 0, data: { error: 'network' } };
  }
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!pathUrl.startsWith('/auth/') && (res.status === 401 || res.status === 403) && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(res.status === 401 ? 'qlcl:session-stale' : 'qlcl:action-forbidden', {
      detail: { status: res.status, error: data?.error || '' },
    }));
  }
  return {
    ok: res.ok,
    status: res.status,
    data,
    requestId: res.headers.get('x-request-id') || data?.request_id || null,
  };
}
