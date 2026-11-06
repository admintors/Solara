#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, transaction, DB_PATH, DATA_DIR } = require('./db');
const { hashPassword } = require('./security/passwords');
const { createInitialAdmin, validateUsername } = require('./services/accounts');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readHiddenPassword() {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let value = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { value += chunk; });
      process.stdin.on('end', () => resolve(value.trimEnd()));
      process.stdin.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = '';
    process.stdout.write('Password (input hidden): ');
    input.setRawMode(true);
    input.resume();
    const onData = chunk => {
      const char = chunk.toString('utf8');
      if (char === '\u0003') { input.setRawMode(false); process.stdout.write('\n'); reject(new Error('CANCELLED')); }
      else if (char === '\r' || char === '\n') { input.setRawMode(false); input.pause(); input.removeListener('data', onData); process.stdout.write('\n'); resolve(value); }
      else if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
      else value += char;
    };
    input.on('data', onData);
  });
}

function quoteSql(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function consistentBackup(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(destinationPath)) throw new Error('BACKUP_EXISTS');
  const source = new DatabaseSync(sourcePath);
  try { source.exec('VACUUM INTO ' + quoteSql(destinationPath)); }
  finally { source.close(); }
  fs.chmodSync(destinationPath, 0o600);
  return destinationPath;
}

function integrityCheck(database) {
  const result = database.prepare('PRAGMA integrity_check').all();
  return result.length === 1 && result[0].integrity_check === 'ok';
}

function resolveUser(database, value) {
  return database.prepare('SELECT id, username, role, status FROM users WHERE id = ? OR username = ?').get(value, String(value).toLowerCase());
}

function parseLegacy(value) {
  if (value == null || value === '') return null;
  try { return JSON.parse(value); } catch { return value; }
}

function safeSong(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = String(value.source || 'netease').toLowerCase();
  const trackId = String(value.track_id ?? value.id ?? '').trim();
  const name = String(value.name || '').trim();
  if (!['netease','kuwo','bilibili'].includes(source) || !trackId || trackId.length > 160 || !name || name.length > 300) return null;
  const song = {
    id: trackId, source, name,
    artist: Array.isArray(value.artist) ? value.artist.slice(0, 8).map(x => String(x).slice(0, 100)) : String(value.artist || value.author || '').slice(0, 300),
    album: String(value.album || '').slice(0, 200),
    pic: String(value.pic || '').slice(0, 2048),
    pic_id: String(value.pic_id || '').slice(0, 256),
    lyric_id: String(value.lyric_id || '').slice(0, 256),
  };
  return song;
}

function importLegacy(sourcePath, ownerArg, dryRun = false, dbPath = DB_PATH) {
  if (!fs.existsSync(sourcePath)) return { skipped: true, reason: 'legacy database not found' };
  const snapshotPath = path.join(DATA_DIR, 'backups', 'legacy-migration-' + Date.now() + '.db');
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const oldDb = new DatabaseSync(sourcePath);
  try { oldDb.exec('VACUUM INTO ' + quoteSql(snapshotPath)); } finally { oldDb.close(); }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex');
  const legacy = new DatabaseSync(snapshotPath, { readOnly: true });
  let values = {};
  try {
    for (const table of ['playback_store', 'favorites_store']) {
      const exists = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) continue;
      for (const row of legacy.prepare('SELECT key,value FROM ' + table).all()) values[row.key] = row.value;
    }
  } finally { legacy.close(); }
  const database = openDatabase(dbPath);
  try {
    const owner = resolveUser(database, ownerArg || '');
    if (!owner || owner.role !== 'admin' || owner.status !== 'active') throw new Error('ACTIVE_ADMIN_OWNER_REQUIRED');
    const prior = database.prepare("SELECT id,user_id,result_json FROM data_imports WHERE source_type='legacy-db' AND source_digest=?").get(digest);
    if (prior) {
      if (prior.user_id !== owner.id) throw new Error('LEGACY_SOURCE_ALREADY_ASSIGNED');
      return { skipped: true, alreadyImported: true, report: JSON.parse(prior.result_json), backup: snapshotPath };
    }
    const queueRaw = parseLegacy(values.playlistSongs);
    const favoritesRaw = parseLegacy(values.favoriteSongs);
    const queue = Array.isArray(queueRaw) ? queueRaw : [];
    const favorites = Array.isArray(favoritesRaw) ? favoritesRaw : [];
    const validQueue = [], validFavorites = [], unresolved = [];
    const currentSongRaw = parseLegacy(values.currentSong);
    const currentSong = safeSong(currentSongRaw);
    if (currentSongRaw && !currentSong) unresolved.push({ raw: currentSongRaw, reason: 'legacy playback song metadata is invalid or unsupported' });
    const positionSeconds = Number.parseFloat(parseLegacy(values.currentPlaybackTime));
    const legacyPlayback = currentSong ? {
      context: parseLegacy(values.currentList) === 'favorite' ? 'favorites' : 'queue',
      source: currentSong.source, trackId: currentSong.id,
      positionMs: Number.isFinite(positionSeconds) ? Math.max(0, Math.min(86400000, Math.floor(positionSeconds * 1000))) : 0,
      playMode: ['list','single','random'].includes(parseLegacy(values.playMode)) ? parseLegacy(values.playMode) : 'list',
      restoredFrom: 'legacy-import',
    } : null;
    for (const [list, target] of [[queue, validQueue], [favorites, validFavorites]]) {
      for (const raw of list) {
        const song = safeSong(raw);
        if (song) target.push(song);
        else unresolved.push({ raw, reason: 'invalid or unsupported track metadata' });
      }
    }
    const report = { sourceDigest: digest, rawQueue: queue.length, rawFavorites: favorites.length, importedQueue: validQueue.length, importedFavorites: validFavorites.length, duplicates: 0, unresolved: unresolved.length, restoredPlayback: Boolean(legacyPlayback) };
    if (dryRun) return { dryRun: true, report, backup: snapshotPath };
    const result = transaction(db => {
      const playlist = db.prepare("SELECT id,version FROM playlists WHERE user_id=? AND kind='queue'").get(owner.id);
      const queueCount = db.prepare('SELECT COUNT(*) AS count FROM playlist_items WHERE playlist_id=?').get(playlist.id).count;
      const favCount = db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id=?').get(owner.id).count;
      if (queueCount + validQueue.length > 2000 || favCount + validFavorites.length > 5000) throw new Error('IMPORT_QUOTA_EXCEEDED');
      const importId = crypto.randomUUID();
      db.prepare('INSERT INTO data_imports(id,user_id,source_type,source_digest,result_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(importId, owner.id, 'legacy-db', digest, JSON.stringify(report), Date.now());
      let addedQueue = 0, addedFavorites = 0, duplicates = 0, position = queueCount;
      const addItem = db.prepare('INSERT OR IGNORE INTO playlist_items(id,playlist_id,user_id,source,track_id,song_json,position,created_at) VALUES(?,?,?,?,?,?,?,?)');
      for (const song of validQueue) {
        const r = addItem.run(crypto.randomUUID(), playlist.id, owner.id, song.source, song.id, JSON.stringify(song), position++, Date.now());
        if (Number(r.changes) > 0) addedQueue++; else duplicates++;
      }
      if (addedQueue) db.prepare('UPDATE playlists SET version=version+1,updated_at=? WHERE id=?').run(Date.now(), playlist.id);
      const addFav = db.prepare('INSERT OR IGNORE INTO favorites(user_id,source,track_id,song_json,created_at) VALUES(?,?,?,?,?)');
      for (const song of validFavorites) {
        const r = addFav.run(owner.id, song.source, song.id, JSON.stringify(song), Date.now());
        if (Number(r.changes) > 0) addedFavorites++; else duplicates++;
      }
      if (addedFavorites) db.prepare('UPDATE users SET favorites_version=favorites_version+1,updated_at=? WHERE id=?').run(Date.now(), owner.id);
      for (const entry of unresolved) db.prepare('INSERT INTO import_unresolved(id,import_id,user_id,raw_json,reason,created_at) VALUES(?,?,?,?,?,?)')
        .run(crypto.randomUUID(), importId, owner.id, JSON.stringify(entry.raw), entry.reason, Date.now());
      const settings = {};
      if (values.playbackQuality && ['standard','higher','exhigh','lossless','hires','jymaster','128','320','flac'].includes(String(parseLegacy(values.playbackQuality)))) settings.playbackQuality = String(parseLegacy(values.playbackQuality));
      if (values.searchSource && ['netease','kuwo','bilibili'].includes(String(parseLegacy(values.searchSource)))) settings.searchSource = String(parseLegacy(values.searchSource));
      if (values.radarSettings) {
        const parsed = parseLegacy(values.radarSettings);
        if (parsed && Array.isArray(parsed.genres)) settings.radarSettings = { genres: [...new Set(parsed.genres.filter(x => typeof x === 'string').slice(0, 24))] };
      }
      if (Object.keys(settings).length) db.prepare('UPDATE user_settings SET settings_json=?,version=version+1,updated_at=? WHERE user_id=?')
        .run(JSON.stringify(settings), Date.now(), owner.id);
      if (legacyPlayback) {
        db.prepare('INSERT INTO playback_states(user_id,device_id,state_json,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET state_json=excluded.state_json,version=playback_states.version+1,updated_at=excluded.updated_at')
          .run(owner.id, 'legacy-import', JSON.stringify(legacyPlayback), 1, Date.now());
      }
      const finalReport = { ...report, importedQueue: addedQueue, importedFavorites: addedFavorites, duplicates, restoredPlayback: Boolean(legacyPlayback) };
      db.prepare('UPDATE data_imports SET result_json=? WHERE id=?').run(JSON.stringify(finalReport), importId);
      db.prepare('INSERT INTO audit_events(id,actor_id,target_id,action,created_at) VALUES(?,?,?,?,?)')
        .run(crypto.randomUUID(), null, owner.id, 'legacy-db-import', Date.now());
      return finalReport;
    }, database);
    return { report: result, backup: snapshotPath };
  } finally { database.close(); }
}

function restoreBackup(input, dbPath = DB_PATH) {
  if (!input || !fs.existsSync(input)) throw new Error('BACKUP_NOT_FOUND');
  const checkDb = new DatabaseSync(input, { readOnly: true });
  try { if (!integrityCheck(checkDb)) throw new Error('BACKUP_INTEGRITY_FAILED'); }
  finally { checkDb.close(); }
  const previous = fs.existsSync(dbPath) ? dbPath + '.pre-restore-' + Date.now() + '.db' : null;
  if (previous) consistentBackup(dbPath, previous);
  const targetTemp = dbPath + '.restore.tmp';
  fs.copyFileSync(input, targetTemp);
  fs.chmodSync(targetTemp, 0o600);
  for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
  fs.renameSync(targetTemp, dbPath);
  const restored = openDatabase(dbPath);
  try { if (!integrityCheck(restored)) throw new Error('RESTORED_DATABASE_INTEGRITY_FAILED'); }
  finally { restored.close(); }
  return { restored: dbPath, previous };
}

function importUserFile(sourcePath, ownerArg, dryRun = false, dbPath = DB_PATH) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('IMPORT_FILE_NOT_FOUND');
  if (fs.statSync(sourcePath).size > 20 * 1024 * 1024) throw new Error('IMPORT_FILE_TOO_LARGE');
  const rawText = fs.readFileSync(sourcePath, 'utf8');
  let payload;
  try { payload = JSON.parse(rawText); } catch { throw new Error('IMPORT_JSON_INVALID'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('IMPORT_FORMAT_INVALID');
  const sourceDigest = crypto.createHash('sha256').update(rawText).digest('hex');
  const lists = Array.isArray(payload.playlists) ? payload.playlists : [];
  const queueList = lists.find(list => list?.kind === 'queue' || list?.name === '播放队列');
  const queueInput = Array.isArray(payload.queue) ? payload.queue : (queueList?.items || payload.songs || []);
  const favoriteInput = Array.isArray(payload.favorites) ? payload.favorites : (payload.favorites?.items || []);
  const namedInput = lists.filter(list => list && list.kind !== 'queue' && list.name !== '播放队列');
  const normalizeItems = list => (Array.isArray(list) ? list : []).map(item => item?.song || item);
  const unresolved = [];
  let duplicateCount = 0;
  function clean(input) {
    const valid = [], seen = new Set();
    for (const raw of normalizeItems(input)) {
      const song = safeSong(raw);
      if (!song) { unresolved.push({ raw, reason: 'invalid or unsupported track metadata' }); continue; }
      const key = song.source + ':' + song.id;
      if (seen.has(key)) { duplicateCount++; continue; }
      seen.add(key); valid.push(song);
    }
    return valid;
  }
  const queue = clean(queueInput), favorites = clean(favoriteInput), named = [];
  for (const entry of namedInput) {
    const name = String(entry.name || '').trim().slice(0, 80);
    if (!name) { unresolved.push({ raw: entry, reason: 'playlist name is missing' }); continue; }
    named.push({ name, songs: clean(entry.items || entry.songs || []) });
  }
  if (queue.length + favorites.length + named.reduce((n, item) => n + item.songs.length, 0) > 10000) throw new Error('IMPORT_ITEM_LIMIT');
  const settingsInput = payload.settings && typeof payload.settings === 'object' ? (payload.settings.settings || payload.settings) : {};
  const settings = {};
  if (['standard','higher','exhigh','lossless','hires','jymaster','128','320','flac'].includes(String(settingsInput.playbackQuality))) settings.playbackQuality = String(settingsInput.playbackQuality);
  if (['netease','kuwo','bilibili'].includes(String(settingsInput.searchSource))) settings.searchSource = String(settingsInput.searchSource);
  if (Array.isArray(settingsInput.radarSettings?.genres)) settings.radarSettings = { genres: [...new Set(settingsInput.radarSettings.genres.filter(x => typeof x === 'string').slice(0,24))] };
  const report = { sourceDigest, importedQueue: queue.length, importedFavorites: favorites.length, importedPlaylists: named.length, duplicates: duplicateCount, unresolved: unresolved.length };
  const db = openDatabase(dbPath);
  try {
    const owner = resolveUser(db, ownerArg || '');
    if (!owner || owner.status !== 'active') throw new Error('ACTIVE_OWNER_REQUIRED');
    const prior = db.prepare("SELECT id,user_id,result_json FROM data_imports WHERE source_type='json-v2' AND source_digest=?").get(sourceDigest);
    if (prior) {
      if (prior.user_id !== owner.id) throw new Error('IMPORT_SOURCE_ALREADY_ASSIGNED');
      return { skipped: true, alreadyImported: true, report: JSON.parse(prior.result_json) };
    }
    if (dryRun) return { dryRun: true, report, owner: owner.username };
    const result = transaction(database => {
      const queueRow = database.prepare("SELECT id FROM playlists WHERE user_id=? AND kind='queue'").get(owner.id);
      const queueCount = Number(database.prepare('SELECT COUNT(*) AS count FROM playlist_items WHERE playlist_id=?').get(queueRow.id).count);
      const favoriteCount = Number(database.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id=?').get(owner.id).count);
      if (queueCount + queue.length > 2000 || favoriteCount + favorites.length > 5000) throw new Error('IMPORT_QUOTA_EXCEEDED');
      const now = Date.now(), importId = crypto.randomUUID();
      database.prepare('INSERT INTO data_imports(id,user_id,source_type,source_digest,result_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(importId, owner.id, 'json-v2', sourceDigest, JSON.stringify(report), now);
      let addedQueue = 0, addedFavorites = 0, remoteDuplicates = 0;
      const insertItem = database.prepare('INSERT OR IGNORE INTO playlist_items(id,playlist_id,user_id,source,track_id,song_json,position,created_at) VALUES(?,?,?,?,?,?,?,?)');
      const append = (playlistId, songs) => {
        let position = Number(database.prepare('SELECT COUNT(*) AS count FROM playlist_items WHERE playlist_id=?').get(playlistId).count);
        let added = 0;
        for (const song of songs) {
          const outcome = insertItem.run(crypto.randomUUID(),playlistId,owner.id,song.source,song.id,JSON.stringify(song),position++,now);
          if (Number(outcome.changes)) added++; else remoteDuplicates++;
        }
        return added;
      };
      addedQueue = append(queueRow.id, queue);
      if (addedQueue) database.prepare('UPDATE playlists SET version=version+1,updated_at=? WHERE id=?').run(now, queueRow.id);
      const insertFavorite = database.prepare('INSERT OR IGNORE INTO favorites(user_id,source,track_id,song_json,created_at) VALUES(?,?,?,?,?)');
      for (const song of favorites) {
        const outcome = insertFavorite.run(owner.id,song.source,song.id,JSON.stringify(song),now);
        if (Number(outcome.changes)) addedFavorites++; else remoteDuplicates++;
      }
      if (addedFavorites) database.prepare('UPDATE users SET favorites_version=favorites_version+1,updated_at=? WHERE id=?').run(now,owner.id);
      let addedLists = 0;
      for (const list of named) {
        let row = database.prepare("SELECT id FROM playlists WHERE user_id=? AND kind='custom' AND name=?").get(owner.id,list.name);
        if (!row) {
          if (Number(database.prepare("SELECT COUNT(*) AS count FROM playlists WHERE user_id=? AND kind='custom'").get(owner.id).count) >= 50) throw new Error('PLAYLIST_QUOTA_EXCEEDED');
          const id = crypto.randomUUID();
          database.prepare("INSERT INTO playlists(id,user_id,kind,name,version,created_at,updated_at) VALUES(?,?,'custom',?,1,?,?)").run(id,owner.id,list.name,now,now);
          row = { id };
        }
        const added = append(row.id,list.songs);
        if (added) { addedLists++; database.prepare('UPDATE playlists SET version=version+1,updated_at=? WHERE id=?').run(now,row.id); }
      }
      if (Object.keys(settings).length) {
        const current = database.prepare('SELECT settings_json FROM user_settings WHERE user_id=?').get(owner.id);
        database.prepare('UPDATE user_settings SET settings_json=?,version=version+1,updated_at=? WHERE user_id=?').run(JSON.stringify({ ...JSON.parse(current.settings_json), ...settings }),now,owner.id);
      }
      for (const item of unresolved) database.prepare('INSERT INTO import_unresolved(id,import_id,user_id,raw_json,reason,created_at) VALUES(?,?,?,?,?,?)')
        .run(crypto.randomUUID(),importId,owner.id,JSON.stringify(item.raw).slice(0,12000),item.reason,now);
      const final = { ...report, importedQueue: addedQueue, importedFavorites: addedFavorites, importedPlaylists: addedLists, duplicates: duplicateCount + remoteDuplicates };
      database.prepare('UPDATE data_imports SET result_json=? WHERE id=?').run(JSON.stringify(final),importId);
      return final;
    }, db);
    return { report: result, owner: owner.username };
  } finally { db.close(); }
}

async function resetAdminPassword(usernameArg, password, dbPath = DB_PATH) {
  const username = validateUsername(usernameArg);
  const passwordHash = await hashPassword(password);
  const database = openDatabase(dbPath);
  try {
    return transaction(db => {
      const user = db.prepare("SELECT id,username FROM users WHERE username=? AND role='admin' AND status='active'").get(username);
      if (!user) throw new Error('ACTIVE_ADMIN_REQUIRED');
      db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash, Date.now(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      db.prepare('INSERT INTO audit_events(id,actor_id,target_id,action,created_at) VALUES(?,?,?,?,?)')
        .run(crypto.randomUUID(), null, user.id, 'admin-password-recovery', Date.now());
      return { username: user.username };
    }, database);
  } finally { database.close(); }
}

async function main() {
  const command = process.argv[2];
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write('Commands: init-db | create-admin --username NAME --display-name NAME [--password-stdin] | reset-password --username ADMIN | backup [--output PATH] | restore --input PATH | import-legacy --owner ADMIN [--source PATH] [--dry-run] | import-user --owner USER --source FILE [--dry-run]\n');
    return;
  }
  if (command === 'init-db') {
    const db = openDatabase();
    db.close();
    process.stdout.write('Database schema is current.\n');
    return;
  }
  if (command === 'create-admin') {
    const username = validateUsername(option('--username'));
    const displayName = option('--display-name') || username;
    const password = await readHiddenPassword();
    const passwordHash = await hashPassword(password);
    const db = openDatabase();
    try {
      const admin = createInitialAdmin(db, { username, displayName, passwordHash });
      process.stdout.write('Created initial administrator: ' + admin.username + ' (' + admin.id + ')\n');
    } finally { db.close(); }
    return;
  }
  if (command === 'reset-password') {
    const result = await resetAdminPassword(option('--username'), await readHiddenPassword());
    process.stdout.write('Administrator password updated: ' + result.username + '\\n');
    return;
  }
  if (command === 'backup') {
    const db = openDatabase();
    db.close();
    const output = option('--output') || path.join(DATA_DIR, 'backups', 'solara-' + new Date().toISOString().replaceAll(':', '-') + '.db');
    consistentBackup(DB_PATH, output);
    process.stdout.write('Backup created: ' + output + '\n');
    return;
  }
  if (command === 'restore') {
    const result = restoreBackup(option('--input'));
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (command === 'import-legacy') {
    const result = importLegacy(option('--source') || path.join(DATA_DIR, 'solara.db'), option('--owner'), process.argv.includes('--dry-run'));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (command === 'import-user') {
    const result = importUserFile(option('--source'), option('--owner'), process.argv.includes('--dry-run'));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  throw new Error('UNKNOWN_COMMAND');
}

if (require.main === module) {
  main().catch(error => { process.stderr.write('Command failed: ' + error.message + '\n'); process.exitCode = 1; });
}

module.exports = { main, consistentBackup, restoreBackup, integrityCheck, importLegacy, importUserFile, resetAdminPassword, safeSong };
