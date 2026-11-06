'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { getDb, transaction } = require('../db');
const { hashPassword, verifyPassword, validatePassword } = require('../security/passwords');
const { validateUsername, normalizeUsername, createUser, writeAudit } = require('../services/accounts');
const { token, digest, createSession, setSessionCookie, clearSessionCookies, checkOrigin, requireJson, rateLimit } = require('../security');
const { HttpError, asyncRoute } = require('../http-error');

function safeUser(user) {
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
}
function sessionHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}
function ensureAllowedBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'BODY_INVALID', '请求内容无效');
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new HttpError(400, 'FIELD_NOT_ALLOWED', '包含不支持的字段');
}
function issueClientRateLimit(key, max, windowMs, res) {
  const result = rateLimit(key, max, windowMs);
  if (!result.allowed) {
    res.set('Retry-After', String(result.retryAfter));
    throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
  }
}
function address(req) { return String(req.socket?.remoteAddress || 'unknown').slice(0, 80); }
async function makePasswordHash(password) {
  try { return await hashPassword(password); }
  catch (error) {
    if (error.message === 'HASH_QUEUE_FULL') throw new HttpError(503, 'PASSWORD_SERVICE_BUSY', '密码服务繁忙，请稍后重试');
    throw error;
  }
}
async function checkPassword(password, encoded) {
  try { return await verifyPassword(password, encoded); }
  catch (error) {
    if (error.message === 'HASH_QUEUE_FULL') throw new HttpError(503, 'PASSWORD_SERVICE_BUSY', '密码服务繁忙，请稍后重试');
    throw error;
  }
}

module.exports = function createAuthRouter(database = getDb(), requireSession) {
  const router = Router();
  router.post('/login', asyncRoute(async (req, res) => {
    checkOrigin(req); requireJson(req); sessionHeaders(res);
    ensureAllowedBody(req.body, ['username', 'password', 'deviceId']);
    const username = normalizeUsername(req.body.username);
    issueClientRateLimit('login-ip:' + address(req), 30, 15 * 60 * 1000, res);
    issueClientRateLimit('login-user-ip:' + username + ':' + address(req), 5, 15 * 60 * 1000, res);
    if (typeof req.body.password !== 'string' || typeof req.body.deviceId !== 'string') throw new HttpError(400, 'LOGIN_FIELDS_INVALID', '用户名、密码和设备信息不能为空');
    const user = database.prepare('SELECT * FROM users WHERE username=?').get(username);
    const valid = user ? await checkPassword(req.body.password, user.password_hash) : false;
    if (!user || user.status !== 'active' || !valid) throw new HttpError(401, 'LOGIN_FAILED', '用户名或密码不正确');
    const session = transaction(db => createSession(db, user.id, req.body.deviceId), database);
    clearSessionCookies(res);
    setSessionCookie(res, session.rawToken);
    res.status(200).json({ data: { user: safeUser(user), csrfToken: session.csrfToken } });
  }));

  router.post('/register', asyncRoute(async (req, res) => {
    checkOrigin(req); requireJson(req); sessionHeaders(res);
    ensureAllowedBody(req.body, ['inviteToken', 'username', 'displayName', 'password', 'deviceId']);
    const username = validateUsername(req.body.username);
    if (typeof req.body.displayName !== 'string' || typeof req.body.deviceId !== 'string') throw new HttpError(400, 'REGISTER_FIELDS_INVALID', '注册信息不完整');
    validatePassword(req.body.password);
    const passwordHash = await makePasswordHash(req.body.password);
    let sessionRecord; const now = Date.now();
    if (typeof req.body.inviteToken !== 'string' || !req.body.inviteToken) throw new HttpError(400, 'INVITE_INVALID', '邀请链接无效或已过期');
    let user;
    transaction(db => {
      const invite = db.prepare("SELECT * FROM auth_tokens WHERE token_hash=? AND purpose='invite' AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?").get(digest(req.body.inviteToken), now);
      if (!invite) throw new HttpError(400, 'INVITE_INVALID', '邀请链接无效或已过期');
      const consumed = db.prepare("UPDATE auth_tokens SET used_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?").run(now, invite.id, now);
      if (Number(consumed.changes) !== 1) throw new HttpError(409, 'TOKEN_ALREADY_USED', '邀请链接已被使用');
      user = createUser(db, { username, displayName: req.body.displayName, passwordHash, role: 'user' });
      sessionRecord = createSession(db, user.id, req.body.deviceId);
      db.prepare('INSERT INTO audit_events(id,actor_id,target_id,action,created_at) VALUES(?,?,?,?,?)')
        .run(crypto.randomUUID(), invite.created_by, user.id, 'invite-registration', now);
    }, database);
    clearSessionCookies(res);
    setSessionCookie(res, sessionRecord.rawToken);
    res.status(201).json({ data: { user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role }, csrfToken: sessionRecord.csrfToken } });
  }));

  router.get('/me', requireSession, (req, res) => {
    sessionHeaders(res);
    res.json({ data: { user: req.user, deviceId: req.session.device_id, csrfToken: req.session.csrf_token, capabilities: { api: 2, importVersion: 2 } } });
  });

  router.post('/logout', requireSession, (req, res) => {
    database.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session.token_hash);
    clearSessionCookies(res);
    res.set('Cache-Control', 'no-store').json({ data: { success: true } });
  });

  router.post('/change-password', requireSession, asyncRoute(async (req, res) => {
    checkOrigin(req); requireJson(req); sessionHeaders(res);
    ensureAllowedBody(req.body, ['currentPassword', 'newPassword']);
    const user = database.prepare('SELECT id,password_hash FROM users WHERE id=?').get(req.user.id);
    if (!await verifyPassword(req.body.currentPassword, user.password_hash)) throw new HttpError(400, 'CURRENT_PASSWORD_INVALID', '当前密码不正确');
    const passwordHash = await makePasswordHash(req.body.newPassword);
    transaction(db => {
      db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash, Date.now(), req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
      writeAudit(db, { actorId: req.user.id, targetId: req.user.id, action: 'password-change', requestId: req.requestId });
    }, database);
    clearSessionCookies(res);
    res.json({ data: { success: true } });
  }));

  router.post('/reset-password', asyncRoute(async (req, res) => {
    checkOrigin(req); requireJson(req); sessionHeaders(res);
    ensureAllowedBody(req.body, ['token', 'password']);
    if (typeof req.body.token !== 'string') throw new HttpError(400, 'RESET_TOKEN_INVALID', '重置链接无效或已过期');
    validatePassword(req.body.password);
    const passwordHash = await makePasswordHash(req.body.password), now = Date.now();
    transaction(db => {
      const row = db.prepare("SELECT * FROM auth_tokens WHERE token_hash=? AND purpose='password_reset' AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?").get(digest(req.body.token), now);
      if (!row) throw new HttpError(400, 'RESET_TOKEN_INVALID', '重置链接无效或已过期');
      const consumed = db.prepare("UPDATE auth_tokens SET used_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?").run(now, row.id, now);
      if (Number(consumed.changes) !== 1) throw new HttpError(409, 'TOKEN_ALREADY_USED', '重置链接已被使用');
      db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash, now, row.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
      writeAudit(db, { actorId: row.created_by, targetId: row.user_id, action: 'password-reset', requestId: req.requestId });
    }, database);
    clearSessionCookies(res);
    res.json({ data: { success: true } });
  }));
  return router;
};
