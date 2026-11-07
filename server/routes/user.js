'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { getDb, transaction } = require('../db');
const { HttpError } = require('../http-error');

const SOURCES = new Set(['netease', 'kuwo', 'bilibili']);
const PLAY_MODES = new Set(['list', 'single', 'random']);
const QUALITY = new Set(['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jymaster', '128', '320', 'flac']);
const LIMITS = Object.freeze({
  playlistCount: Number(process.env.MAX_NAMED_PLAYLISTS || 50),
  playlistItems: Number(process.env.MAX_PLAYLIST_ITEMS || 2000),
  favorites: Number(process.env.MAX_FAVORITES || 5000),
  batch: Number(process.env.MAX_BATCH_ITEMS || 200),
  importItems: Number(process.env.MAX_IMPORT_ITEMS || 10000),
});

function rejectUnknown(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'BODY_INVALID', '请求内容无效');
  for (const key of Object.keys(body)) if (!keys.includes(key)) throw new HttpError(400, 'FIELD_NOT_ALLOWED', '包含不支持的字段');
}
function etag(res, version) { res.set('ETag', '"v' + version + '"'); }
function requireVersion(req) {
  const value = req.get('If-Match');
  if (!value) throw new HttpError(428, 'VERSION_REQUIRED', '请刷新列表后重试');
  const match = /^"?v(\d+)"?$/.exec(value);
  if (!match) throw new HttpError(400, 'VERSION_INVALID', '列表版本无效');
  return Number(match[1]);
}
function assertVersion(req, current) {
  const expected = requireVersion(req);
  if (expected !== current) throw new HttpError(412, 'VERSION_CONFLICT', '列表已在其他设备更新，请刷新后确认', { currentVersion: current });
}
function parseLimit(query) {
  const n = Number.parseInt(query.limit || '50', 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new HttpError(400, 'PAGE_LIMIT_INVALID', '每页条数必须在 1 到 100 之间');
  return n;
}
function parseOffset(query) {
  const n = Number.parseInt(query.offset || '0', 10);
  if (!Number.isInteger(n) || n < 0 || n > 10000000) throw new HttpError(400, 'PAGE_OFFSET_INVALID', '分页位置无效');
  return n;
}
function sanitizeSong(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(422, 'TRACK_INVALID', '歌曲信息无效');
  const source = String(input.source || 'netease').toLowerCase();
  const trackId = String(input.track_id ?? input.id ?? input.songmid ?? input.mid ?? input.songid ?? '').trim();
  const name = String(input.name || input.title || '').trim();
  if (!SOURCES.has(source) || !trackId || trackId.length > 160 || !name || Array.from(name).length > 300) throw new HttpError(422, 'TRACK_INVALID', '歌曲来源、标识或标题无效');
  const artist = Array.isArray(input.artist) ? input.artist.slice(0, 8).map(value => String(value).slice(0, 100)) : String(input.artist || input.author || '').slice(0, 300);
  const song = {
    id: trackId,
    source,
    name,
    artist,
    album: String(input.album || '').slice(0, 200),
    pic: String(input.pic || '').slice(0, 2048),
    pic_id: String(input.pic_id || '').slice(0, 256),
    lyric_id: String(input.lyric_id || input.lyricId || '').slice(0, 256),
  };
  if (Buffer.byteLength(JSON.stringify(song), 'utf8') > 4096) throw new HttpError(422, 'TRACK_TOO_LARGE', '歌曲元数据过大');
  return song;
}
function songKey(song) { return song.source + ':' + song.id; }
function getOwnedPlaylist(database, userId, id) {
  const row = database.prepare('SELECT id,user_id,kind,name,version,created_at,updated_at FROM playlists WHERE id=? AND user_id=?').get(id, userId);
  if (!row) throw new HttpError(404, 'NOT_FOUND', '歌单不存在');
  return row;
}
function readItems(database, playlistId) {
  return database.prepare('SELECT id,source,track_id,song_json,position,created_at FROM playlist_items WHERE playlist_id=? ORDER BY position').all(playlistId)
    .map(row => ({ id: row.id, source: row.source, trackId: row.track_id, song: JSON.parse(row.song_json), position: row.position, createdAt: row.created_at }));
}
function playlistPayload(database, row) {
  return { id: row.id, kind: row.kind, name: row.name, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, items: readItems(database, row.id) };
}
function bumpPlaylist(database, row) {
  const now = Date.now();
  database.prepare('UPDATE playlists SET version=version+1,updated_at=? WHERE id=? AND user_id=?').run(now, row.id, row.user_id);
  return row.version + 1;
}
function resequence(database, playlistId) {
  const rows = database.prepare('SELECT id FROM playlist_items WHERE playlist_id=? ORDER BY position').all(playlistId);
  const max = rows.length + Number(database.prepare('SELECT COALESCE(MAX(position),0) AS n FROM playlist_items WHERE playlist_id=?').get(playlistId).n) + 10;
  database.prepare('UPDATE playlist_items SET position=position+? WHERE playlist_id=?').run(max, playlistId);
  const update = database.prepare('UPDATE playlist_items SET position=? WHERE id=?');
  rows.forEach((row, index) => update.run(index, row.id));
}
function userFavorites(database, userId, limit, offset) {
  return database.prepare('SELECT source,track_id,song_json,created_at FROM favorites WHERE user_id=? ORDER BY created_at DESC,source,track_id LIMIT ? OFFSET ?')
    .all(userId, limit, offset).map(row => ({ source: row.source, trackId: row.track_id, song: JSON.parse(row.song_json), createdAt: row.created_at }));
}
function ownedQueue(database, userId) {
  const row = database.prepare("SELECT id,user_id,kind,name,version,created_at,updated_at FROM playlists WHERE user_id=? AND kind='queue'").get(userId);
  if (!row) throw new HttpError(500, 'QUEUE_MISSING', '系统队列未初始化');
  return row;
}
function ensureItemsArray(items, max = LIMITS.batch) {
  if (!Array.isArray(items) || items.length > max) throw new HttpError(413, 'BATCH_LIMIT_EXCEEDED', '批量歌曲数量超过限制');
  return items.map(sanitizeSong);
}
function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new HttpError(422, 'SETTINGS_INVALID', '偏好设置无效');
  const allowed = ['playbackQuality', 'searchSource', 'radarSettings'];
  rejectUnknown(settings, allowed);
  const result = {};
  if (Object.hasOwn(settings, 'playbackQuality')) {
    if (!QUALITY.has(String(settings.playbackQuality))) throw new HttpError(422, 'SETTING_INVALID', '音质设置无效');
    result.playbackQuality = String(settings.playbackQuality);
  }
  if (Object.hasOwn(settings, 'searchSource')) {
    if (!SOURCES.has(String(settings.searchSource))) throw new HttpError(422, 'SETTING_INVALID', '搜索来源无效');
    result.searchSource = String(settings.searchSource);
  }
  if (Object.hasOwn(settings, 'radarSettings')) {
    const genres = settings.radarSettings?.genres;
    if (!Array.isArray(genres) || genres.length > 24 || genres.some(value => typeof value !== 'string' || value.length > 64)) throw new HttpError(422, 'SETTING_INVALID', '雷达偏好无效');
    result.radarSettings = { genres: [...new Set(genres)] };
  }
  return result;
}
function assertNoIdentityFields(body) {
  for (const key of ['userId', 'user_id', 'role', 'status', 'deviceId', 'device_id']) if (Object.hasOwn(body || {}, key)) throw new HttpError(400, 'FIELD_NOT_ALLOWED', '不能指定账号、角色或设备归属');
}
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}
function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}
function validatePlayback(value, database, userId) {
  rejectUnknown(value, ['context', 'playlistId', 'source', 'trackId', 'positionMs', 'playMode']);
  const contexts = new Set(['queue', 'playlist', 'favorites', 'transient']);
  if (!contexts.has(value.context)) throw new HttpError(422, 'PLAYBACK_INVALID', '播放上下文无效');
  const positionMs = Number(value.positionMs);
  if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs > 24 * 60 * 60 * 1000) throw new HttpError(422, 'PLAYBACK_INVALID', '播放进度无效');
  if (!PLAY_MODES.has(value.playMode)) throw new HttpError(422, 'PLAYBACK_INVALID', '播放模式无效');
  let playlistId = null;
  if (value.context === 'queue' || value.context === 'playlist') {
    if (value.context === 'queue') playlistId = ownedQueue(database, userId).id;
    else {
      const row = database.prepare("SELECT id FROM playlists WHERE id=? AND user_id=? AND kind='custom'").get(value.playlistId, userId);
      if (!row) throw new HttpError(404, 'NOT_FOUND', '歌单不存在');
      playlistId = row.id;
    }
  } else if (value.playlistId != null) throw new HttpError(422, 'PLAYBACK_INVALID', '此播放上下文不能包含歌单 ID');
  const source = String(value.source || 'netease').toLowerCase();
  const trackId = String(value.trackId || '').trim();
  if (!SOURCES.has(source) || trackId.length < 1 || trackId.length > 160) throw new HttpError(422, 'PLAYBACK_INVALID', '歌曲身份无效');
  return { context: value.context, playlistId, source, trackId, positionMs: Math.floor(positionMs), playMode: value.playMode, savedAt: Date.now(), resumeRequested: false };
}
function settingsRow(database, userId) {
  return database.prepare('SELECT settings_json,version,updated_at FROM user_settings WHERE user_id=?').get(userId);
}

module.exports = function createUserRouter(database = getDb()) {
  const router = Router();

  router.get('/bootstrap', (req, res) => {
    const userId = req.user.id;
    const queue = ownedQueue(database, userId);
    const favoritesMeta = database.prepare('SELECT favorites_version FROM users WHERE id=?').get(userId);
    const settings = settingsRow(database, userId);
    const playback = database.prepare('SELECT state_json,version,updated_at FROM playback_states WHERE user_id=? AND device_id=?').get(userId, req.session.device_id);
    const custom = database.prepare("SELECT id,user_id,kind,name,version,created_at,updated_at FROM playlists WHERE user_id=? AND kind='custom' ORDER BY created_at").all(userId);
    const favoritesCount = database.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id=?').get(userId).count;
    etag(res, queue.version);
    res.json({ data: {
      userId,
      queue: playlistPayload(database, queue),
      playlists: custom.map(row => ({ ...playlistPayload(database, row), items: undefined })),
      favorites: { items: userFavorites(database, userId, 100, 0), version: favoritesMeta.favorites_version, count: favoritesCount, complete: favoritesCount <= 100 },
      settings: { settings: parseJson(settings.settings_json, {}), version: settings.version },
      playback: playback ? { state: parseJson(playback.state_json, null), version: playback.version, updatedAt: playback.updated_at } : { state: null, version: 0, updatedAt: null },
    } });
  });

  router.get('/playlists', (req, res) => {
    const rows = database.prepare('SELECT id,user_id,kind,name,version,created_at,updated_at FROM playlists WHERE user_id=? ORDER BY kind,created_at').all(req.user.id);
    res.json({ data: rows.map(row => ({ id: row.id, kind: row.kind, name: row.name, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at })) });
  });

  router.post('/playlists', (req, res) => {
    rejectUnknown(req.body, ['name']); assertNoIdentityFields(req.body);
    const name = String(req.body.name || '').trim();
    if (!name || Array.from(name).length > 80) throw new HttpError(422, 'PLAYLIST_NAME_INVALID', '歌单名称须为 1 至 80 个字符');
    const count = database.prepare("SELECT COUNT(*) AS count FROM playlists WHERE user_id=? AND kind='custom'").get(req.user.id).count;
    if (count >= LIMITS.playlistCount) throw new HttpError(409, 'PLAYLIST_LIMIT_REACHED', '命名歌单已达到上限');
    const id = crypto.randomUUID(), now = Date.now();
    try {
      database.prepare("INSERT INTO playlists(id,user_id,kind,name,version,created_at,updated_at) VALUES(?,?,'custom',?,1,?,?)").run(id, req.user.id, name, now, now);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'PLAYLIST_NAME_EXISTS', '已有同名歌单');
      throw error;
    }
    etag(res, 1);
    res.status(201).json({ data: { id, kind: 'custom', name, version: 1, items: [] } });
  });

  router.get('/playlists/:id', (req, res) => {
    const row = getOwnedPlaylist(database, req.user.id, req.params.id);
    etag(res, row.version);
    res.json({ data: playlistPayload(database, row) });
  });

  router.patch('/playlists/:id', (req, res) => {
    rejectUnknown(req.body, ['name']); assertNoIdentityFields(req.body);
    const name = String(req.body.name || '').trim();
    if (!name || Array.from(name).length > 80) throw new HttpError(422, 'PLAYLIST_NAME_INVALID', '歌单名称须为 1 至 80 个字符');
    const result = transaction(db => {
      const row = getOwnedPlaylist(db, req.user.id, req.params.id);
      if (row.kind !== 'custom') throw new HttpError(409, 'SYSTEM_PLAYLIST_IMMUTABLE', '系统队列不能重命名');
      assertVersion(req, row.version);
      try { db.prepare('UPDATE playlists SET name=?,version=version+1,updated_at=? WHERE id=? AND user_id=?').run(name, Date.now(), row.id, req.user.id); }
      catch (error) { if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'PLAYLIST_NAME_EXISTS', '已有同名歌单'); throw error; }
      return row.version + 1;
    }, database);
    etag(res, result);
    res.json({ data: { id: req.params.id, name, version: result } });
  });

  router.delete('/playlists/:id', (req, res) => {
    const result = transaction(db => {
      const row = getOwnedPlaylist(db, req.user.id, req.params.id);
      if (row.kind !== 'custom') throw new HttpError(409, 'SYSTEM_PLAYLIST_IMMUTABLE', '系统队列不能删除');
      assertVersion(req, row.version);
      db.prepare('DELETE FROM playlists WHERE id=? AND user_id=?').run(row.id, req.user.id);
      return row.version + 1;
    }, database);
    etag(res, result);
    res.json({ data: { success: true, version: result } });
  });

  router.post('/playlists/:id/items/batch', (req, res) => {
    rejectUnknown(req.body, ['items']); assertNoIdentityFields(req.body);
    const songs = ensureItemsArray(req.body.items);
    const result = transaction(db => {
      const row = getOwnedPlaylist(db, req.user.id, req.params.id);
      assertVersion(req, row.version);
      const count = db.prepare('SELECT COUNT(*) AS count FROM playlist_items WHERE playlist_id=?').get(row.id).count;
      const existingKeys = new Set(db.prepare('SELECT source,track_id FROM playlist_items WHERE playlist_id=?').all(row.id).map(item => item.source + ':' + item.track_id));
      const candidates = new Map(songs.map(song => [songKey(song), song]));
      const additions = [...candidates].filter(([key]) => !existingKeys.has(key)).map(([, song]) => song);
      if (count + additions.length > LIMITS.playlistItems) throw new HttpError(409, 'PLAYLIST_LIMIT_REACHED', '歌单歌曲已达到上限');
      const add = db.prepare('INSERT OR IGNORE INTO playlist_items(id,playlist_id,user_id,source,track_id,song_json,position,created_at) VALUES(?,?,?,?,?,?,?,?)');
      let added = 0, position = count;
      for (const song of additions) {
        const changed = add.run(crypto.randomUUID(), row.id, req.user.id, song.source, song.id, JSON.stringify(song), position, Date.now());
        if (Number(changed.changes)) { added++; position++; }
      }
      const duplicates = songs.length - added;
      if (added) resequence(db, row.id);
      const version = added ? bumpPlaylist(db, row) : row.version;
      return { added, duplicates, version, playlist: getOwnedPlaylist(db, req.user.id, row.id) };
    }, database);
    etag(res, result.version);
    res.json({ data: { added: result.added, duplicates: result.duplicates, version: result.version, playlist: playlistPayload(database, result.playlist) } });
  });

  router.delete('/playlists/:id/items/:itemId', (req, res) => {
    const result = transaction(db => {
      const row = getOwnedPlaylist(db, req.user.id, req.params.id);
      assertVersion(req, row.version);
      const changed = db.prepare('DELETE FROM playlist_items WHERE id=? AND playlist_id=? AND user_id=?').run(req.params.itemId, row.id, req.user.id);
      if (!Number(changed.changes)) throw new HttpError(404, 'NOT_FOUND', '歌曲条目不存在');
      resequence(db, row.id);
      const version = bumpPlaylist(db, row);
      return { version, playlist: getOwnedPlaylist(db, req.user.id, row.id) };
    }, database);
    etag(res, result.version);
    res.json({ data: playlistPayload(database, result.playlist) });
  });

  router.post('/playlists/:id/items/clear', (req, res) => {
    rejectUnknown(req.body, []); assertNoIdentityFields(req.body);
    const result = transaction(db => {
      const row = getOwnedPlaylist(db, req.user.id, req.params.id);
      assertVersion(req, row.version);
      db.prepare('DELETE FROM playlist_items WHERE playlist_id=? AND user_id=?').run(row.id, req.user.id);
      const version = bumpPlaylist(db, row);
      return { version, id: row.id };
    }, database);
    etag(res, result.version);
    res.json({ data: { id: result.id, items: [], version: result.version } });
  });

  router.put('/playlists/:id/order', (req, res) => {
    rejectUnknown(req.body, ['itemIds']); assertNoIdentityFields(req.body);
    if (!Array.isArray(req.body.itemIds) || req.body.itemIds.length > LIMITS.playlistItems || req.body.itemIds.some(id => typeof id !== 'string')) throw new HttpError(422, 'ORDER_INVALID', '歌曲顺序无效');
    const result = transaction(db => {
      const row = getOwnedPlaylist(db, req.user.id, req.params.id);
      assertVersion(req, row.version);
      const current = db.prepare('SELECT id,position FROM playlist_items WHERE playlist_id=? AND user_id=? ORDER BY position').all(row.id, req.user.id);
      if (current.length !== req.body.itemIds.length || new Set(req.body.itemIds).size !== current.length || current.some(item => !req.body.itemIds.includes(item.id))) throw new HttpError(409, 'ORDER_CONFLICT', '排序必须包含当前歌单的全部歌曲');
      const max = Math.max(0, ...current.map(item => item.position)) + current.length + 100;
      db.prepare('UPDATE playlist_items SET position=position+? WHERE playlist_id=? AND user_id=?').run(max, row.id, req.user.id);
      const update = db.prepare('UPDATE playlist_items SET position=? WHERE id=? AND playlist_id=? AND user_id=?');
      req.body.itemIds.forEach((id, index) => update.run(index, id, row.id, req.user.id));
      const version = req.body.itemIds.every((id, index) => current[index]?.id === id) ? row.version : bumpPlaylist(db, row);
      return { version, playlist: getOwnedPlaylist(db, req.user.id, row.id) };
    }, database);
    etag(res, result.version);
    res.json({ data: playlistPayload(database, result.playlist) });
  });

  router.get('/favorites', (req, res) => {
    const limit = parseLimit(req.query), offset = parseOffset(req.query);
    const user = database.prepare('SELECT favorites_version FROM users WHERE id=?').get(req.user.id);
    const count = database.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id=?').get(req.user.id).count;
    etag(res, user.favorites_version);
    res.json({ data: { items: userFavorites(database, req.user.id, limit, offset), version: user.favorites_version, count, nextOffset: offset + limit < count ? offset + limit : null } });
  });

  router.put('/favorites/:source/:trackId', (req, res) => {
    rejectUnknown(req.body, ['song']); assertNoIdentityFields(req.body);
    const song = sanitizeSong({ ...req.body.song, source: req.params.source, id: req.params.trackId });
    if (song.source !== req.params.source || song.id !== req.params.trackId) throw new HttpError(400, 'TRACK_ID_MISMATCH', '歌曲身份不匹配');
    const result = transaction(db => {
      const exists = db.prepare('SELECT 1 FROM favorites WHERE user_id=? AND source=? AND track_id=?').get(req.user.id, song.source, song.id);
      if (exists) return { changed: false, version: db.prepare('SELECT favorites_version FROM users WHERE id=?').get(req.user.id).favorites_version };
      const count = db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id=?').get(req.user.id).count;
      if (count >= LIMITS.favorites) throw new HttpError(409, 'FAVORITES_LIMIT_REACHED', '收藏已达到上限');
      db.prepare('INSERT INTO favorites(user_id,source,track_id,song_json,created_at) VALUES(?,?,?,?,?)').run(req.user.id, song.source, song.id, JSON.stringify(song), Date.now());
      db.prepare('UPDATE users SET favorites_version=favorites_version+1,updated_at=? WHERE id=?').run(Date.now(), req.user.id);
      return { changed: true, version: db.prepare('SELECT favorites_version FROM users WHERE id=?').get(req.user.id).favorites_version };
    }, database);
    etag(res, result.version);
    res.json({ data: { saved: true, changed: result.changed, version: result.version } });
  });

  router.delete('/favorites/:source/:trackId', (req, res) => {
    if (!SOURCES.has(req.params.source)) throw new HttpError(422, 'SOURCE_INVALID', '歌曲来源无效');
    const result = transaction(db => {
      const changed = db.prepare('DELETE FROM favorites WHERE user_id=? AND source=? AND track_id=?').run(req.user.id, req.params.source, req.params.trackId);
      if (Number(changed.changes)) db.prepare('UPDATE users SET favorites_version=favorites_version+1,updated_at=? WHERE id=?').run(Date.now(), req.user.id);
      return { changed: Number(changed.changes) > 0, version: db.prepare('SELECT favorites_version FROM users WHERE id=?').get(req.user.id).favorites_version };
    }, database);
    etag(res, result.version);
    res.json({ data: { removed: true, changed: result.changed, version: result.version } });
  });

  router.post('/favorites/batch', (req, res) => {
    rejectUnknown(req.body, ['items']); assertNoIdentityFields(req.body);
    const songs = ensureItemsArray(req.body.items);
    const result = transaction(db => {
      const count = db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id=?').get(req.user.id).count;
      const existingKeys = new Set(db.prepare('SELECT source,track_id FROM favorites WHERE user_id=?').all(req.user.id).map(item => item.source + ':' + item.track_id));
      const unique = new Map(songs.map(song => [songKey(song), song]));
      const additions = [...unique].filter(([key]) => !existingKeys.has(key)).map(([, song]) => song);
      if (count + additions.length > LIMITS.favorites) throw new HttpError(409, 'FAVORITES_LIMIT_REACHED', '收藏已达到上限');
      const add = db.prepare('INSERT OR IGNORE INTO favorites(user_id,source,track_id,song_json,created_at) VALUES(?,?,?,?,?)');
      let added = 0;
      for (const song of additions) {
        const changed = add.run(req.user.id, song.source, song.id, JSON.stringify(song), Date.now());
        if (Number(changed.changes)) added++;
      }
      if (added) db.prepare('UPDATE users SET favorites_version=favorites_version+1,updated_at=? WHERE id=?').run(Date.now(), req.user.id);
      const version = db.prepare('SELECT favorites_version FROM users WHERE id=?').get(req.user.id).favorites_version;
      return { added, duplicates: songs.length - added, version };
    }, database);
    etag(res, result.version);
    res.json({ data: result });
  });

  router.post('/favorites/clear', (req, res) => {
    rejectUnknown(req.body, []); assertNoIdentityFields(req.body);
    const result = transaction(db => {
      const user = db.prepare('SELECT favorites_version FROM users WHERE id=?').get(req.user.id);
      assertVersion(req, user.favorites_version);
      const changed = db.prepare('DELETE FROM favorites WHERE user_id=?').run(req.user.id);
      if (Number(changed.changes)) db.prepare('UPDATE users SET favorites_version=favorites_version+1,updated_at=? WHERE id=?').run(Date.now(), req.user.id);
      return db.prepare('SELECT favorites_version FROM users WHERE id=?').get(req.user.id).favorites_version;
    }, database);
    etag(res, result);
    res.json({ data: { items: [], version: result } });
  });

  router.get('/settings', (req, res) => {
    const row = settingsRow(database, req.user.id);
    etag(res, row.version);
    res.json({ data: { settings: parseJson(row.settings_json, {}), version: row.version, updatedAt: row.updated_at } });
  });

  router.patch('/settings', (req, res) => {
    rejectUnknown(req.body, ['settings']); assertNoIdentityFields(req.body);
    const patch = validateSettings(req.body.settings);
    if (!Object.keys(patch).length) throw new HttpError(400, 'SETTINGS_EMPTY', '没有可保存的偏好');
    const result = transaction(db => {
      const row = settingsRow(db, req.user.id);
      assertVersion(req, row.version);
      const next = { ...parseJson(row.settings_json, {}), ...patch };
      db.prepare('UPDATE user_settings SET settings_json=?,version=version+1,updated_at=? WHERE user_id=?').run(JSON.stringify(next), Date.now(), req.user.id);
      return { settings: next, version: row.version + 1 };
    }, database);
    etag(res, result.version);
    res.json({ data: result });
  });

  router.get('/playback', (req, res) => {
    const row = database.prepare('SELECT state_json,version,updated_at FROM playback_states WHERE user_id=? AND device_id=?').get(req.user.id, req.session.device_id);
    const version = row?.version || 0;
    etag(res, version);
    res.json({ data: { state: row ? parseJson(row.state_json) : null, version, updatedAt: row?.updated_at || null, deviceId: req.session.device_id } });
  });

  router.put('/playback', (req, res) => {
    assertNoIdentityFields(req.body);
    const state = validatePlayback(req.body, database, req.user.id);
    const result = transaction(db => {
      const row = db.prepare('SELECT version FROM playback_states WHERE user_id=? AND device_id=?').get(req.user.id, req.session.device_id);
      const version = row?.version || 0;
      assertVersion(req, version);
      const nextVersion = version + 1;
      db.prepare('INSERT INTO playback_states(user_id,device_id,state_json,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET state_json=excluded.state_json,version=excluded.version,updated_at=excluded.updated_at')
        .run(req.user.id, req.session.device_id, JSON.stringify(state), nextVersion, Date.now());
      return nextVersion;
    }, database);
    etag(res, result);
    res.json({ data: { state, version: result } });
  });

  router.get('/devices', (req, res) => {
    const rows = database.prepare('SELECT device_id,state_json,version,updated_at FROM playback_states WHERE user_id=? AND device_id<>? ORDER BY updated_at DESC').all(req.user.id, req.session.device_id);
    res.json({ data: rows.map(row => ({ deviceId: row.device_id, state: parseJson(row.state_json), version: row.version, updatedAt: row.updated_at })) });
  });

  router.post('/playback/resume', (req, res) => {
    rejectUnknown(req.body, ['sourceDeviceId']); assertNoIdentityFields(req.body);
    if (typeof req.body.sourceDeviceId !== 'string' || req.body.sourceDeviceId === req.session.device_id) throw new HttpError(400, 'DEVICE_ID_INVALID', '来源设备无效');
    const result = transaction(db => {
      const source = db.prepare('SELECT state_json FROM playback_states WHERE user_id=? AND device_id=?').get(req.user.id, req.body.sourceDeviceId);
      if (!source) throw new HttpError(404, 'NOT_FOUND', '设备播放记录不存在');
      const target = db.prepare('SELECT version FROM playback_states WHERE user_id=? AND device_id=?').get(req.user.id, req.session.device_id);
      const version = target?.version || 0;
      assertVersion(req, version);
      const state = parseJson(source.state_json);
      if (!state) throw new HttpError(409, 'PLAYBACK_INVALID', '播放记录无法恢复');
      state.resumeRequested = true;
      state.savedAt = Date.now();
      const nextVersion = version + 1;
      db.prepare('INSERT INTO playback_states(user_id,device_id,state_json,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET state_json=excluded.state_json,version=excluded.version,updated_at=excluded.updated_at')
        .run(req.user.id, req.session.device_id, JSON.stringify(state), nextVersion, Date.now());
      return { state, version: nextVersion };
    }, database);
    etag(res, result.version);
    res.json({ data: result });
  });

  router.get('/export', (req, res) => {
    const playlists = database.prepare('SELECT id,kind,name,version FROM playlists WHERE user_id=? ORDER BY created_at').all(req.user.id)
      .map(row => ({ ...row, items: readItems(database, row.id).map(item => item.song) }));
    const favoritesVersion = database.prepare('SELECT favorites_version FROM users WHERE id=?').get(req.user.id).favorites_version;
    const settings = settingsRow(database, req.user.id);
    const unresolved = database.prepare('SELECT raw_json,reason,created_at FROM import_unresolved WHERE user_id=? ORDER BY created_at').all(req.user.id)
      .map(row => ({ raw: parseJson(row.raw_json, row.raw_json), reason: row.reason, createdAt: row.created_at }));
    res.set('Content-Disposition', 'attachment; filename="solara-export-v2.json"');
    res.json({ data: { formatVersion: 2, exportedAt: new Date().toISOString(), playlists, favorites: userFavorites(database, req.user.id, LIMITS.favorites, 0), favoritesVersion, settings: parseJson(settings.settings_json, {}), unresolved } });
  });

  router.post('/import', (req, res) => {
    rejectUnknown(req.body, ['formatVersion', 'sourceType', 'sourceDigest', 'queue', 'playlists', 'favorites', 'settings']);
    assertNoIdentityFields(req.body);
    const sourceType = String(req.body.sourceType || 'json-v2');
    if (!['browser-v1', 'json-v2'].includes(sourceType)) throw new HttpError(422, 'IMPORT_SOURCE_INVALID', '导入来源无效');
    const canonical = stableStringify(req.body);
    const sourceDigest = crypto.createHash('sha256').update(canonical).digest('hex');
    const tracks = [];
    const unresolved = [];
    const collect = (items, target) => {
      if (items == null) return;
      if (!Array.isArray(items)) throw new HttpError(422, 'IMPORT_INVALID', '导入列表格式无效');
      for (const raw of items) {
        try { target.push(sanitizeSong(raw)); }
        catch (error) { unresolved.push({ raw, reason: error.code || 'invalid track metadata' }); }
      }
    };
    collect(req.body.queue || [], tracks);
    const favoriteTracks = [];
    collect(req.body.favorites || [], favoriteTracks);
    const namedLists = Array.isArray(req.body.playlists) ? req.body.playlists : [];
    if (namedLists.length > LIMITS.playlistCount) throw new HttpError(413, 'IMPORT_LIMIT_EXCEEDED', '命名歌单数量超过限制');
    const namedPrepared = namedLists.map(playlist => {
      if (!playlist || typeof playlist !== 'object' || typeof playlist.name !== 'string') throw new HttpError(422, 'IMPORT_INVALID', '歌单数据格式无效');
      const songs = [];
      collect(playlist.items || [], songs);
      return { name: playlist.name.trim(), songs, raw: playlist };
    });
    const totalItems = tracks.length + favoriteTracks.length + namedPrepared.reduce((sum, item) => sum + item.songs.length, 0) + unresolved.length;
    if (totalItems > LIMITS.importItems) throw new HttpError(413, 'IMPORT_LIMIT_EXCEEDED', '导入条目数量超过限制');
    const settingsPatch = req.body.settings ? validateSettings(req.body.settings) : {};
    const now = Date.now();
    const result = transaction(db => {
      const existing = db.prepare('SELECT id,user_id,result_json FROM data_imports WHERE user_id=? AND source_type=? AND source_digest=?').get(req.user.id, sourceType, sourceDigest);
      if (existing) return { alreadyImported: true, ...parseJson(existing.result_json, {}) };
      const queue = ownedQueue(db, req.user.id);
      const currentQueueCount = db.prepare('SELECT COUNT(*) AS count FROM playlist_items WHERE playlist_id=?').get(queue.id).count;
      const currentFavoriteCount = db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id=?').get(req.user.id).count;
      const queueKeys = new Set(db.prepare('SELECT source,track_id FROM playlist_items WHERE playlist_id=?').all(queue.id).map(row => row.source + ':' + row.track_id));
      const newQueue = new Map();
      for (const song of tracks) if (!queueKeys.has(songKey(song))) newQueue.set(songKey(song), song);
      const favoriteKeys = new Set(db.prepare('SELECT source,track_id FROM favorites WHERE user_id=?').all(req.user.id).map(row => row.source + ':' + row.track_id));
      const newFavorites = new Map();
      for (const song of favoriteTracks) if (!favoriteKeys.has(songKey(song))) newFavorites.set(songKey(song), song);
      if (currentQueueCount + newQueue.size > LIMITS.playlistItems || currentFavoriteCount + newFavorites.size > LIMITS.favorites) throw new HttpError(409, 'IMPORT_QUOTA_EXCEEDED', '导入超出当前曲库配额');
      const importId = crypto.randomUUID();
      db.prepare('INSERT INTO data_imports(id,user_id,source_type,source_digest,result_json,created_at) VALUES(?,?,?,?,?,?)').run(importId, req.user.id, sourceType, sourceDigest, '{}', now);
      let addedQueue = 0, addedFavorites = 0, duplicates = tracks.length - newQueue.size + favoriteTracks.length - newFavorites.size;
      const addQueue = db.prepare('INSERT OR IGNORE INTO playlist_items(id,playlist_id,user_id,source,track_id,song_json,position,created_at) VALUES(?,?,?,?,?,?,?,?)');
      let position = currentQueueCount;
      for (const song of newQueue.values()) {
        const changed = addQueue.run(crypto.randomUUID(), queue.id, req.user.id, song.source, song.id, JSON.stringify(song), position++, now);
        if (Number(changed.changes)) addedQueue++;
      }
      if (addedQueue) bumpPlaylist(db, queue);
      const addFavorite = db.prepare('INSERT OR IGNORE INTO favorites(user_id,source,track_id,song_json,created_at) VALUES(?,?,?,?,?)');
      for (const song of newFavorites.values()) {
        const changed = addFavorite.run(req.user.id, song.source, song.id, JSON.stringify(song), now);
        if (Number(changed.changes)) addedFavorites++;
      }
      if (addedFavorites) db.prepare('UPDATE users SET favorites_version=favorites_version+1,updated_at=? WHERE id=?').run(now, req.user.id);
      for (const playlist of namedPrepared) {
        const name = playlist.name;
        if (!name || Array.from(name).length > 80) { unresolved.push({ raw: playlist.raw, reason: 'invalid playlist name' }); continue; }
        const existingName = db.prepare("SELECT id FROM playlists WHERE user_id=? AND kind='custom' AND name=?").get(req.user.id, name);
        if (existingName) { duplicates++; continue; }
        const count = db.prepare("SELECT COUNT(*) AS count FROM playlists WHERE user_id=? AND kind='custom'").get(req.user.id).count;
        if (count >= LIMITS.playlistCount) throw new HttpError(409, 'PLAYLIST_LIMIT_REACHED', '命名歌单已达到上限');
        if (playlist.songs.length > LIMITS.playlistItems) throw new HttpError(409, 'PLAYLIST_LIMIT_REACHED', '歌单歌曲已达到上限');
        const id = crypto.randomUUID();
        db.prepare("INSERT INTO playlists(id,user_id,kind,name,version,created_at,updated_at) VALUES(?,?,'custom',?,1,?,?)").run(id, req.user.id, name, now, now);
        const insert = db.prepare('INSERT OR IGNORE INTO playlist_items(id,playlist_id,user_id,source,track_id,song_json,position,created_at) VALUES(?,?,?,?,?,?,?,?)');
        let p = 0;
        for (const song of playlist.songs) insert.run(crypto.randomUUID(), id, req.user.id, song.source, song.id, JSON.stringify(song), p++, now);
      }
      if (Object.keys(settingsPatch).length) {
        const current = settingsRow(db, req.user.id);
        db.prepare('UPDATE user_settings SET settings_json=?,version=version+1,updated_at=? WHERE user_id=?')
          .run(JSON.stringify({ ...parseJson(current.settings_json, {}), ...settingsPatch }), now, req.user.id);
      }
      for (const entry of unresolved) db.prepare('INSERT INTO import_unresolved(id,import_id,user_id,raw_json,reason,created_at) VALUES(?,?,?,?,?,?)')
        .run(crypto.randomUUID(), importId, req.user.id, JSON.stringify(entry.raw).slice(0, 12000), String(entry.reason).slice(0, 200), now);
      const report = { id: importId, sourceType, sourceDigest, importedQueue: addedQueue, importedFavorites: addedFavorites, duplicates, unresolved: unresolved.length };
      db.prepare('UPDATE data_imports SET result_json=? WHERE id=?').run(JSON.stringify(report), importId);
      return report;
    }, database);
    res.status(result.alreadyImported ? 200 : 201).json({ data: result });
  });

  router.get('/imports/:id', (req, res) => {
    const row = database.prepare('SELECT id,source_type,source_digest,result_json,created_at FROM data_imports WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', '导入记录不存在');
    res.json({ data: { id: row.id, sourceType: row.source_type, sourceDigest: row.source_digest, result: parseJson(row.result_json), createdAt: row.created_at } });
  });

  return router;
};
