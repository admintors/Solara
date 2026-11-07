'use strict';

let activeSession = null;
let bootstrapPromise = null;
let generation = 0;
const pendingRequests = new Set();
const AUTH_SIGNAL_KEY = 'solara:auth-signal:v1';
const TAB_ID = makeTabId();
let authChannel = null;

export class ApiError extends Error {
  constructor(status, code, message, details = null, requestId = null) {
    super(message || '请求失败，请稍后重试');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'API_ERROR';
    this.details = details;
    this.requestId = requestId;
  }
}

function makeTabId() {
  try { return window.crypto.randomUUID(); }
  catch { return String(Date.now()) + '-' + Math.random().toString(36).slice(2); }
}
function randomDeviceId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}
export function getDeviceId() {
  const key = 'solara:device-id:v1';
  try {
    const current = window.localStorage.getItem(key);
    if (current && /^[0-9a-f-]{36}$/i.test(current)) return current;
    const created = randomDeviceId();
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    return randomDeviceId();
  }
}

function makeError(payload, status = 0) {
  const detail = payload && typeof payload === 'object' ? payload.error : null;
  return new ApiError(
    status,
    detail?.code || (status ? 'API_ERROR' : 'NETWORK_ERROR'),
    detail?.message || (status ? '请求失败，请稍后重试' : '网络连接失败，请检查网络后重试'),
    detail?.details || null,
    detail?.requestId || null,
  );
}
async function readJson(response) {
  try { return await response.json(); }
  catch { return null; }
}
function abortPendingRequests() {
  for (const controller of pendingRequests) {
    try { controller.abort(); } catch {}
  }
  pendingRequests.clear();
}
function redirectForAuthReason(reason) {
  if (!window.location || window.location.pathname === '/login') return;
  const destination = reason === 'logout' || reason === 'session-expired' ? '/login' : '/';
  if (window.location.pathname !== destination) window.location.replace(destination);
}
function invalidateSession(reason, dispatchEvent = true) {
  const previousUserId = activeSession?.user?.id || null;
  activeSession = null;
  bootstrapPromise = null;
  generation++;
  abortPendingRequests();
  if (dispatchEvent) {
    window.dispatchEvent(new CustomEvent('solara:auth-invalid', {
      detail: { reason, userId: previousUserId },
    }));
    redirectForAuthReason(reason);
  }
}

function publishAuthChange(reason) {
  const message = { source: TAB_ID, reason, nonce: makeTabId() };
  if (authChannel) {
    try { authChannel.postMessage(message); } catch {}
    return;
  }
  try { window.localStorage.setItem(AUTH_SIGNAL_KEY, JSON.stringify(message)); }
  catch {}
}
function receiveAuthChange(message) {
  if (!message || message.source === TAB_ID) return;
  const reason = message.reason === 'logout' ? 'logout' : 'account-changed';
  invalidateSession(reason);
}
if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
  try {
    authChannel = new BroadcastChannel('solara-auth-v1');
    authChannel.addEventListener('message', event => receiveAuthChange(event.data));
  } catch { authChannel = null; }
}
if (typeof window !== 'undefined' && !authChannel) {
  window.addEventListener('storage', event => {
    if (event.key !== AUTH_SIGNAL_KEY || !event.newValue) return;
    try { receiveAuthChange(JSON.parse(event.newValue)); } catch {}
  });
}

export function getSession() {
  return activeSession;
}

export async function bootstrapAuth() {
  if (activeSession) return activeSession;
  if (bootstrapPromise) return bootstrapPromise;
  const startedAt = generation;
  const task = (async () => {
    const response = await fetch('/api/auth/me', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const payload = await readJson(response);
    if (startedAt !== generation) return activeSession;
    if (response.status === 401) {
      invalidateSession('session-expired');
      return null;
    }
    if (!response.ok) throw makeError(payload, response.status);
    const data = payload?.data;
    if (!data?.user?.id || !data.csrfToken) throw new ApiError(502, 'SESSION_RESPONSE_INVALID', '登录状态响应无效');
    activeSession = {
      user: data.user,
      deviceId: data.deviceId || getDeviceId(),
      csrfToken: data.csrfToken,
      capabilities: data.capabilities || {},
    };
    return activeSession;
  })();
  bootstrapPromise = task;
  try { return await task; }
  finally { if (bootstrapPromise === task) bootstrapPromise = null; }
}

export async function apiRequest(path, options = {}) {
  const session = activeSession;
  if (!session) throw new ApiError(401, 'AUTH_REQUIRED', '请先登录');
  const requestGeneration = generation;
  let target;
  try { target = new URL(path, window.location.href); }
  catch { throw new ApiError(400, 'API_URL_INVALID', '接口地址无效'); }
  if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) {
    throw new ApiError(400, 'API_URL_REJECTED', '仅允许访问本站 API');
  }

  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  headers.set('X-Solara-Account', session.user.id);
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (isWrite) {
    headers.set('X-CSRF-Token', session.csrfToken);
    if (options.body !== undefined && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  }
  if (options.ifMatch) headers.set('If-Match', String(options.ifMatch));

  let body;
  if (options.body !== undefined) {
    body = options.body instanceof FormData || typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body);
  }
  const controller = new AbortController();
  pendingRequests.add(controller);
  const externalSignal = options.signal;
  const abortFromCaller = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', abortFromCaller, { once: true });
  }
  let response;
  try {
    response = await fetch(target.href, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (requestGeneration !== generation) throw new ApiError(401, 'ACCOUNT_CHANGED', '当前页面账号已变更');
    throw error;
  } finally {
    pendingRequests.delete(controller);
    if (externalSignal) externalSignal.removeEventListener('abort', abortFromCaller);
  }

  const payload = await readJson(response);
  if (response.status === 401) {
    const error = makeError(payload, response.status);
    if (requestGeneration === generation) {
      const reason = error.code === 'ACCOUNT_CHANGED' ? 'account-changed' : 'session-expired';
      invalidateSession(reason);
    }
    throw error;
  }
  if (requestGeneration !== generation || activeSession?.user?.id !== session.user.id) {
    throw new ApiError(401, 'ACCOUNT_CHANGED', '当前页面账号已变更');
  }
  if (!response.ok) throw makeError(payload, response.status);
  if (!payload || typeof payload !== 'object') throw new ApiError(502, 'API_RESPONSE_INVALID', '服务器返回内容无效');
  return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

export function announceLogin() {
  invalidateSession('login', false);
  publishAuthChange('login');
}

export async function logout() {
  await apiRequest('/api/auth/logout', { method: 'POST', body: {} });
  invalidateSession('logout');
  publishAuthChange('logout');
}
