'use strict';

const crypto = require('node:crypto');
const { transaction } = require('../db');

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!USERNAME_RE.test(username)) throw new Error('USERNAME_INVALID');
  return username;
}

function createUser(database, { username, displayName, passwordHash, role = 'user', status = 'active' }) {
  const normalized = validateUsername(username);
  if (!['user', 'admin'].includes(role) || !['active', 'disabled'].includes(status)) throw new Error('USER_FIELDS_INVALID');
  if (typeof displayName !== 'string' || displayName.trim().length < 1 || Array.from(displayName.trim()).length > 64) throw new Error('DISPLAY_NAME_INVALID');
  const id = crypto.randomUUID();
  const now = Date.now();
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, normalized, displayName.trim(), passwordHash, role, status, now, now);
  database.prepare('INSERT INTO playlists(id, user_id, kind, name, version, created_at, updated_at) VALUES(?,?,?,?,1,?,?)')
    .run(crypto.randomUUID(), id, 'queue', '播放队列', now, now);
  database.prepare('INSERT INTO user_settings(user_id, settings_json, version, updated_at) VALUES(?,?,1,?)')
    .run(id, JSON.stringify({ playbackQuality: '320', searchSource: 'netease', radarSettings: { genres: [] } }), now);
  return database.prepare('SELECT id, username, display_name, role, status, created_at FROM users WHERE id=?').get(id);
}

function createInitialAdmin(database, fields) {
  return transaction(db => {
    const existing = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND status='active'").get().count;
    if (existing > 0) throw new Error('ADMIN_ALREADY_EXISTS');
    return createUser(db, { ...fields, role: 'admin', status: 'active' });
  }, database);
}

function writeAudit(database, { actorId = null, targetId = null, action, requestId = null }) {
  database.prepare('INSERT INTO audit_events(id, actor_id, target_id, action, request_id, created_at) VALUES(?,?,?,?,?,?)')
    .run(crypto.randomUUID(), actorId, targetId, action, requestId, Date.now());
}

module.exports = { USERNAME_RE, normalizeUsername, validateUsername, createUser, createInitialAdmin, writeAudit };
