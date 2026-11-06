'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { getDb, transaction } = require('../db');
const { token, digest, requireAdmin, publicOrigin } = require('../security');
const { HttpError } = require('../http-error');
const { writeAudit } = require('../services/accounts');

function tokenLink(raw, purpose) {
  return publicOrigin() + (purpose === 'invite' ? '/login#invite=' : '/login#reset=') + encodeURIComponent(raw);
}
function bodyFields(req, fields) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'BODY_INVALID', '请求内容无效');
  for (const key of Object.keys(req.body)) if (!fields.includes(key)) throw new HttpError(400, 'FIELD_NOT_ALLOWED', '包含不支持的字段');
}

module.exports = function createAdminRouter(database = getDb()) {
  const router = Router();
  router.use(requireAdmin);
  router.get('/users', (req, res) => {
    const rows = database.prepare('SELECT id,username,display_name,role,status,created_at,updated_at FROM users ORDER BY created_at').all();
    res.set('Cache-Control', 'no-store').json({ data: rows.map(row => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at })) });
  });
  router.patch('/users/:id', (req, res) => {
    bodyFields(req, ['status']);
    if (!['active', 'disabled'].includes(req.body.status)) throw new HttpError(400, 'STATUS_INVALID', '账号状态无效');
    const target = database.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
    if (!target) throw new HttpError(404, 'NOT_FOUND', '账号不存在');
    try {
      transaction(db => {
        db.prepare('UPDATE users SET status=?,updated_at=? WHERE id=?').run(req.body.status, Date.now(), target.id);
        if (req.body.status === 'disabled') db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
        writeAudit(db, { actorId: req.user.id, targetId: target.id, action: 'user-status-' + req.body.status, requestId: req.requestId });
      }, database);
    } catch (error) {
      if (String(error.message).includes('LAST_ACTIVE_ADMIN')) throw new HttpError(409, 'LAST_ADMIN', '不能停用最后一位管理员');
      throw error;
    }
    res.json({ data: { id: target.id, status: req.body.status } });
  });
  router.post('/invites', (req, res) => {
    bodyFields(req, []);
    const raw = token(), now = Date.now(), id = crypto.randomUUID();
    transaction(db => {
      db.prepare("INSERT INTO auth_tokens(id,token_hash,purpose,user_id,created_by,expires_at,created_at) VALUES(?,?,'invite',NULL,?,?,?)")
        .run(id, digest(raw), req.user.id, now + 7 * 86400000, now);
      writeAudit(db, { actorId: req.user.id, targetId: id, action: 'invite-create', requestId: req.requestId });
    }, database);
    res.status(201).json({ data: { id, expiresAt: now + 7 * 86400000, url: tokenLink(raw, 'invite') } });
  });
  router.get('/invites', (req, res) => {
    const rows = database.prepare("SELECT id,expires_at,created_at FROM auth_tokens WHERE purpose='invite' AND used_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC").all();
    res.json({ data: rows.map(row => ({ id: row.id, expiresAt: row.expires_at, createdAt: row.created_at })) });
  });
  router.delete('/invites/:id', (req, res) => {
    const changed = database.prepare("UPDATE auth_tokens SET revoked_at=? WHERE id=? AND purpose='invite' AND used_at IS NULL AND revoked_at IS NULL").run(Date.now(), req.params.id);
    if (Number(changed.changes) !== 1) throw new HttpError(404, 'NOT_FOUND', '邀请不存在或已经使用');
    writeAudit(database, { actorId: req.user.id, targetId: req.params.id, action: 'invite-revoke', requestId: req.requestId });
    res.json({ data: { success: true } });
  });
  router.post('/users/:id/reset-token', (req, res) => {
    bodyFields(req, []);
    const user = database.prepare('SELECT id,status FROM users WHERE id=?').get(req.params.id);
    if (!user) throw new HttpError(404, 'NOT_FOUND', '账号不存在');
    if (user.status !== 'active') throw new HttpError(409, 'USER_DISABLED', '请先启用该账号');
    const raw = token(), id = crypto.randomUUID(), now = Date.now();
    transaction(db => {
      db.prepare("UPDATE auth_tokens SET revoked_at=? WHERE user_id=? AND purpose='password_reset' AND used_at IS NULL AND revoked_at IS NULL").run(now, user.id);
      db.prepare("INSERT INTO auth_tokens(id,token_hash,purpose,user_id,created_by,expires_at,created_at) VALUES(?,?,'password_reset',?,?,?,?)")
        .run(id, digest(raw), user.id, req.user.id, now + 30 * 60 * 1000, now);
      writeAudit(db, { actorId: req.user.id, targetId: user.id, action: 'password-reset-token-create', requestId: req.requestId });
    }, database);
    res.status(201).json({ data: { id, expiresAt: now + 30 * 60 * 1000, url: tokenLink(raw, 'reset') } });
  });
  return router;
};
