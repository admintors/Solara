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
  if (!['netease','tencent','kugou','kuwo','bilibili'].includes(source) || !trackId || trackId.length > 160 || !name || name.length > 300) return null;
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
    for (const [list, target] of [[queue, validQueue], [favorites, validFavorites]]) {
      for (const raw of list) {
        const song = safeSong(raw);
        if (song) target.push(song);
        else unresolved.push({ raw, reason: 'invalid or unsupported track metadata' });
      }
    }
    const report = { sourceDigest: digest, rawQueue: queue.length, rawFavorites: favorites.length, importedQueue: validQueue.length, importedFavorites: validFavorites.length, duplicates: 0, unresolved: unresolved.length };
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
      if (values.playbackQuality) settings.playbackQuality = String(parseLegacy(values.playbackQuality)).slice(0, 32);
      if (values.searchSource) settings.searchSource = String(parseLegacy(values.searchSource)).slice(0, 32);
      if (values.radarSettings) {
        const parsed = parseLegacy(values.radarSettings);
        if (parsed && typeof parsed === 'object') settings.radarSettings = parsed;
      }
      if (Object.keys(settings).length) db.prepare('UPDATE user_settings SET settings_json=?,version=version+1,updated_at=? WHERE user_id=?')
        .run(JSON.stringify(settings), Date.now(), owner.id);
      const finalReport = { ...report, importedQueue: addedQueue, importedFavorites: addedFavorites, duplicates };
      db.prepare('UPDATE data_imports SET result_json=? WHERE id=?').run(JSON.stringify(finalReport), importId);
      db.prepare('INSERT INTO audit_events(id,actor_id,target_id,action,created_at) VALUES(?,?,?,?,?)')
        .run(crypto.randomUUID(), null, owner.id, 'legacy-db-import', Date.now());
      return finalReport;
    }, database);
    return { report: result, backup: snapshotPath };
  } finally { database.close(); }
}

async function main() {
  const command = process.argv[2];
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write('Commands: init-db | create-admin --username NAME --display-name NAME [--password-stdin] | backup [--output PATH] | restore --input PATH | import-legacy --owner USER [--source PATH] [--dry-run]\n');
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
  if (command === 'backup') {
    const db = openDatabase();
    db.close();
    const output = option('--output') || path.join(DATA_DIR, 'backups', 'solara-' + new Date().toISOString().replaceAll(':', '-') + '.db');
    consistentBackup(DB_PATH, output);
    process.stdout.write('Backup created: ' + output + '\n');
    return;
  }
  if (command === 'restore') {
    const input = option('--input');
    if (!input || !fs.existsSync(input)) throw new Error('BACKUP_NOT_FOUND');
    const checkDb = new DatabaseSync(input, { readOnly: true });
    try { if (!integrityCheck(checkDb)) throw new Error('BACKUP_INTEGRITY_FAILED'); }
    finally { checkDb.close(); }
    if (fs.existsSync(DB_PATH)) consistentBackup(DB_PATH, DB_PATH + '.pre-restore-' + Date.now() + '.db');
    const targetTemp = DB_PATH + '.restore.tmp';
    fs.copyFileSync(input, targetTemp);
    fs.chmodSync(targetTemp, 0o600);
    for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }
    fs.renameSync(targetTemp, DB_PATH);
    const restored = openDatabase(DB_PATH);
    try { if (!integrityCheck(restored)) throw new Error('RESTORED_DATABASE_INTEGRITY_FAILED'); }
    finally { restored.close(); }
    process.stdout.write('Restore complete. Previous database retained beside the active file.\n');
    return;
  }
  if (command === 'import-legacy') {
    const result = importLegacy(option('--source') || path.join(DATA_DIR, 'solara.db'), option('--owner'), process.argv.includes('--dry-run'));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  throw new Error('UNKNOWN_COMMAND');
}

if (require.main === module) {
  main().catch(error => { process.stderr.write('Command failed: ' + error.message + '\n'); process.exitCode = 1; });
}

module.exports = { main, consistentBackup, integrityCheck, importLegacy, safeSong };
