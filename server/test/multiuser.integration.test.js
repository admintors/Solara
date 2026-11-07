'use strict';

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let directory, database, server, origin, admin, member, adminSession, memberSession;
const password = 'test-password-for-solara-2026';

async function login(username) {
  const response = await fetch(origin + '/api/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, deviceId: crypto.randomUUID() }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie') || '';
  const match = cookie.match(/(?:solara_session|__Host-solara_session)=([^;]+)/);
  assert.ok(match, 'login response should set a session cookie');
  return { cookie: decodeURIComponent(match[1]), csrfToken: body.data.csrfToken, user: body.data.user };
}

function call(session, route, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    Origin: origin,
    Cookie: 'solara_session=' + session.cookie,
    'X-Solara-Account': options.accountId || session.user.id,
    Accept: 'application/json',
  };
  if (['POST','PUT','PATCH','DELETE'].includes(method)) {
    headers['Content-Type'] = 'application/json';
    if (options.csrf !== false) headers['X-CSRF-Token'] = session.csrfToken;
    if (options.ifMatch) headers['If-Match'] = options.ifMatch;
  }
  return fetch(origin + route, { method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}

describe('multi-user isolation and concurrency contracts', () => {
  before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solara-multiuser-'));
    process.env.APP_ENV = 'test';
    process.env.NODE_ENV = 'test';
    process.env.DATA_DIR = directory;
    process.env.DB_PATH = path.join(directory, 'test.db');
    const { openDatabase } = require('../db');
    const { hashPassword } = require('../security/passwords');
    const { createInitialAdmin, createUser } = require('../services/accounts');
    database = openDatabase(process.env.DB_PATH);
    const hash = await hashPassword(password);
    admin = createInitialAdmin(database, { username: 'admin-one', displayName: 'Admin One', passwordHash: hash });
    member = createUser(database, { username: 'member-two', displayName: 'Member Two', passwordHash: hash });
    const { createApp } = require('../app');
    server = createApp({ database, proxyReady: () => true }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    origin = 'http://127.0.0.1:' + server.address().port;
    process.env.PUBLIC_ORIGIN = origin;
    adminSession = await login('admin-one');
    memberSession = await login('member-two');
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (database) database.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('redirects an unauthenticated homepage request while keeping API responses at 401', async () => {
    const home = await fetch(origin + '/', { redirect: 'manual' });
    assert.equal(home.status, 302);
    assert.equal(new URL(home.headers.get('location'), origin).pathname, '/login');
    const api = await fetch(origin + '/api/me/bootstrap', { redirect: 'manual' });
    assert.equal(api.status, 401);
    assert.equal((await api.json()).error.code, 'AUTH_REQUIRED');
  });

  it('rejects another account ID and never exposes another user playlist', async () => {
    const created = await call(memberSession, '/api/me/playlists', { method: 'POST', body: { name: 'member-private' } });
    assert.equal(created.status, 201);
    const privateList = (await created.json()).data;
    assert.equal((await call(adminSession, '/api/me/playlists/' + encodeURIComponent(privateList.id))).status, 404);
    assert.equal((await call(adminSession, '/api/me/playlists/' + encodeURIComponent(privateList.id), { method: 'DELETE', body: {}, ifMatch: '"v1"' })).status, 404);
    const exportResponse = await call(adminSession, '/api/me/export');
    const exported = await exportResponse.text();
    assert.equal(exported.includes('member-private'), false);
    const forged = await call(adminSession, '/api/me/import', { method: 'POST', body: { sourceType: 'json-v2', queue: [], userId: member.id } });
    assert.equal(forged.status, 400);
  });

  it('rejects stale writes after an account switch and requires CSRF on writes', async () => {
    const staleWrite = await call(memberSession, '/api/me/favorites/netease/stale-track', {
      method: 'PUT', accountId: admin.id,
      body: { song: { id: 'stale-track', source: 'netease', name: 'stale' } },
    });
    assert.equal(staleWrite.status, 401);
    assert.equal((await staleWrite.json()).error.code, 'ACCOUNT_CHANGED');
    const noCsrf = await call(memberSession, '/api/me/favorites/netease/no-csrf', {
      method: 'PUT', csrf: false,
      body: { song: { id: 'no-csrf', source: 'netease', name: 'no csrf' } },
    });
    assert.equal(noCsrf.status, 403);
    const favorites = await call(memberSession, '/api/me/favorites?limit=100&offset=0');
    assert.equal((await favorites.json()).data.items.length, 0);
  });

  it('does not resurrect deleted queue data from a stale device version', async () => {
    const before = (await (await call(memberSession, '/api/me/bootstrap')).json()).data.queue;
    const song = { id: 'queue-track-1', source: 'netease', name: 'queue item', artist: 'test' };
    const added = await call(memberSession, '/api/me/playlists/' + before.id + '/items/batch', {
      method: 'POST', ifMatch: '"v' + before.version + '"', body: { items: [song] },
    });
    assert.equal(added.status, 200);
    const updated = (await added.json()).data.playlist;
    const cleared = await call(memberSession, '/api/me/playlists/' + before.id + '/items/clear', {
      method: 'POST', ifMatch: '"v' + updated.version + '"', body: {},
    });
    assert.equal(cleared.status, 200);
    const stale = await call(memberSession, '/api/me/playlists/' + before.id + '/items/batch', {
      method: 'POST', ifMatch: '"v' + before.version + '"', body: { items: [song] },
    });
    assert.equal(stale.status, 412);
    const current = (await (await call(memberSession, '/api/me/playlists/' + before.id)).json()).data;
    assert.deepEqual(current.items, []);
    assert.equal((await (await call(memberSession, '/api/me/export')).text()).includes('queue-track-1'), false);
  });

  it('allows only one concurrent use of invitation and password-reset tokens', async () => {
    const inviteResponse = await call(adminSession, '/api/admin/invites', { method: 'POST', body: {} });
    assert.equal(inviteResponse.status, 201);
    const inviteUrl = new URL((await inviteResponse.json()).data.url);
    const inviteToken = new URLSearchParams(inviteUrl.hash.slice(1)).get('invite');
    const register = username => fetch(origin + '/api/auth/register', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteToken, username, displayName: username, password, deviceId: crypto.randomUUID() }),
    });
    const registrations = await Promise.all([register('invite-user-a'), register('invite-user-b')]);
    assert.equal(registrations.filter(response => response.status === 201).length, 1);
    assert.equal(registrations.filter(response => response.status !== 201).length, 1);
    const userCount = database.prepare("SELECT COUNT(*) AS count FROM users WHERE username IN ('invite-user-a','invite-user-b')").get().count;
    assert.equal(userCount, 1);
    const createdUser = database.prepare("SELECT id,username FROM users WHERE username IN ('invite-user-a','invite-user-b')").get();
    const resetResponse = await call(adminSession, '/api/admin/users/' + createdUser.id + '/reset-token', { method: 'POST', body: {} });
    assert.equal(resetResponse.status, 201);
    const resetUrl = new URL((await resetResponse.json()).data.url);
    const resetToken = new URLSearchParams(resetUrl.hash.slice(1)).get('reset');
    const reset = newPassword => fetch(origin + '/api/auth/reset-password', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, password: newPassword }),
    });
    const resets = await Promise.all([reset('new-test-password-alpha'), reset('new-test-password-beta')]);
    assert.equal(resets.filter(response => response.status === 200).length, 1);
    assert.equal(resets.filter(response => response.status !== 200).length, 1);
  });
});
