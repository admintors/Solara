'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('./http-error');

const APP_ENV = process.env.APP_ENV || process.env.NODE_ENV || 'production';
const COOKIE_NAME = APP_ENV === 'production' ? '__Host-solara_session' : 'solara_session';
const ABSOLUTE_TTL = Number(process.env.SESSION_ABSOLUTE_TTL_SECONDS || 604800) * 1000;
const IDLE_TTL = Number(process.env.SESSION_IDLE_TTL_SECONDS || 172800) * 1000;
const ACCOUNT_RE = /^[0-9a-f-]{36}$/i;
const limits = new Map();

function token() { return crypto.randomBytes(32).toString('base64url'); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function parseCookies(header = '') {
  const result = Object.create(null);
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    try { result[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return result;
}

function publicOrigin() {
  const value = process.env.PUBLIC_ORIGIN;
  if (!value) throw new HttpError(503, 'SERVER_NOT_CONFIGURED', '服务尚未配置公开来源地址');
  let parsed;
  try { parsed = new URL(value); } catch { throw new HttpError(503, 'SERVER_NOT_CONFIGURED', 'PUBLIC_ORIGIN 配置无效'); }
  if (parsed.origin !== value || !['https:', 'http:'].includes(parsed.protocol)) throw new HttpError(503, 'SERVER_NOT_CONFIGURED', 'PUBLIC_ORIGIN 必须是完整的来源地址');
  if (APP_ENV === 'production' && parsed.protocol !== 'https:') throw new HttpError(503, 'SERVER_NOT_CONFIGURED', '生产环境必须使用 HTTPS');
  if (APP_ENV !== 'production' && parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new HttpError(503, 'SERVER_NOT_CONFIGURED', '开发环境 HTTP 只允许 loopback 来源');
  }
  return parsed.origin;
}
function requireJson(req) {
  if (!req.is('application/json')) throw new HttpError(415, 'JSON_REQUIRED', '请使用 JSON 请求');
}
function checkOrigin(req) {
  const expected = publicOrigin();
  const origin = req.get('Origin');
  if (!origin || origin !== expected) throw new HttpError(403, 'ORIGIN_REJECTED', '请求来源不匹配');
}
function requireWriteProtection(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  checkOrigin(req);
  requireJson(req);
  if (!sameSecret(req.get('X-CSRF-Token'), req.session.csrf_token)) throw new HttpError(403, 'CSRF_REJECTED', '请求校验失败，请刷新页面后重试');
  if (req.get('X-Solara-Account') !== req.user.id) throw new HttpError(401, 'ACCOUNT_CHANGED', '当前页面账号已变更');
}
function setSessionCookie(res, rawToken) {
  const secure = APP_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', COOKIE_NAME + '=' + encodeURIComponent(rawToken) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(ABSOLUTE_TTL / 1000) + secure);
}
function clearSessionCookies(res) {
  const secure = APP_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure);
  res.append('Set-Cookie', 'auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function createSession(database, userId, deviceId) {
  if (typeof deviceId !== 'string' || !ACCOUNT_RE.test(deviceId)) throw new HttpError(400, 'DEVICE_ID_INVALID', '设备标识无效');
  const rawToken = token();
  const csrfToken = token();
  const now = Date.now();
  database.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,device_id,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?)')
    .run(digest(rawToken), userId, csrfToken, deviceId, now, now, now + ABSOLUTE_TTL);
  return { rawToken, csrfToken, expiresAt: now + ABSOLUTE_TTL };
}
function createSessionMiddleware(database) {
  return (req, res, next) => {
    req.requestId = req.get('X-Request-Id')?.slice(0, 80) || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    const cookies = parseCookies(req.headers.cookie);
    const rawToken = cookies[COOKIE_NAME];
    if (!rawToken) return next(new HttpError(401, 'AUTH_REQUIRED', '请先登录'));
    const tokenHash = digest(rawToken);
    const now = Date.now();
    const row = database.prepare(
      'SELECT s.token_hash,s.user_id,s.csrf_token,s.device_id,s.created_at,s.last_seen_at,s.expires_at,' +
      'u.username,u.display_name,u.role,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?'
    ).get(tokenHash);
    if (!row || row.status !== 'active' || now >= row.expires_at || now - row.last_seen_at >= IDLE_TTL || now - row.created_at >= ABSOLUTE_TTL) {
      if (row) database.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);
      clearSessionCookies(res);
      return next(new HttpError(401, 'SESSION_EXPIRED', '登录已过期，请重新登录'));
    }
    req.user = { id: row.user_id, username: row.username, displayName: row.display_name, role: row.role };
    req.session = row;
    if (req.path.startsWith('/api') && req.get('X-Solara-Account') && req.get('X-Solara-Account') !== row.user_id) {
      return next(new HttpError(401, 'ACCOUNT_CHANGED', '当前页面账号已变更'));
    }
    try { requireWriteProtection(req); } catch (error) { return next(error); }
    if (now - row.last_seen_at >= 5 * 60 * 1000) database.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(now, tokenHash);
    req.session.token_hash = tokenHash;
    return next();
  };
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return next(new HttpError(403, 'ADMIN_REQUIRED', '需要管理员权限'));
  next();
}
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let entry = limits.get(key);
  if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + windowMs };
  entry.count++;
  limits.set(key, entry);
  if (limits.size > 10000) for (const [oldKey, oldEntry] of limits) if (now >= oldEntry.resetAt) limits.delete(oldKey);
  return { allowed: entry.count <= max, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
}
function rateLimitMiddleware({ key, max, windowMs }) {
  return (req, res, next) => {
    const result = rateLimit(key(req), max, windowMs);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      return next(new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试'));
    }
    next();
  };
}
module.exports = {
  APP_ENV, COOKIE_NAME, ABSOLUTE_TTL, IDLE_TTL, token, digest, sameSecret, parseCookies,
  publicOrigin, requireJson, checkOrigin, setSessionCookie, clearSessionCookies,
  createSession, createSessionMiddleware, requireAdmin, rateLimit, rateLimitMiddleware,
};
