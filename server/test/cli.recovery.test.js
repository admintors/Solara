'use strict';

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let directory, dataDirectory, dbPath, owner, secondOwner;
let cli, openDatabase, createInitialAdmin, createUser, hashPassword;

describe('migration and backup recovery', () => {
  before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solara-recovery-'));
    dataDirectory = path.join(directory, 'data');
    fs.mkdirSync(dataDirectory, { recursive: true });
    dbPath = path.join(dataDirectory, 'solara-multiuser.db');
    process.env.APP_ENV = 'test';
    process.env.NODE_ENV = 'test';
    process.env.DATA_DIR = dataDirectory;
    process.env.DB_PATH = dbPath;
    ({ openDatabase } = require('../db'));
    ({ createInitialAdmin, createUser } = require('../services/accounts'));
    ({ hashPassword } = require('../security/passwords'));
    cli = require('../cli');
    const db = openDatabase(dbPath);
    const hash = await hashPassword('secure-test-password-2026');
    owner = createInitialAdmin(db, { username: 'legacy-owner', displayName: 'Legacy Owner', passwordHash: hash });
    secondOwner = createUser(db, { username: 'other-owner', displayName: 'Other Owner', passwordHash: hash });
    db.close();
  });
  after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

  it('imports a legacy database once for the explicit owner and restores legacy playback', () => {
    const legacyPath = path.join(dataDirectory, 'solara.db');
    const old = new DatabaseSync(legacyPath);
    old.exec('CREATE TABLE playback_store(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE favorites_store(key TEXT PRIMARY KEY,value TEXT);');
    const song = { id: 'old-track-1', source: 'netease', name: 'legacy song', artist: 'legacy artist' };
    old.prepare('INSERT INTO playback_store(key,value) VALUES(?,?)').run('playlistSongs', JSON.stringify([song]));
    old.prepare('INSERT INTO playback_store(key,value) VALUES(?,?)').run('currentSong', JSON.stringify(song));
    old.prepare('INSERT INTO playback_store(key,value) VALUES(?,?)').run('currentPlaybackTime', '42');
    old.prepare('INSERT INTO playback_store(key,value) VALUES(?,?)').run('currentList', 'playlist');
    old.prepare('INSERT INTO favorites_store(key,value) VALUES(?,?)').run('favoriteSongs', JSON.stringify([song]));
    old.close();

    const dry = cli.importLegacy(legacyPath, 'legacy-owner', true, dbPath);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.report.restoredPlayback, true);
    const imported = cli.importLegacy(legacyPath, 'legacy-owner', false, dbPath);
    assert.equal(imported.report.importedQueue, 1);
    assert.equal(imported.report.importedFavorites, 1);
    assert.equal(imported.report.restoredPlayback, true);
    const db = openDatabase(dbPath);
    const state = db.prepare("SELECT state_json FROM playback_states WHERE user_id=? AND device_id='legacy-import'").get(owner.id);
    assert.equal(JSON.parse(state.state_json).positionMs, 42000);
    assert.throws(() => cli.importLegacy(legacyPath, 'other-owner', false, dbPath), /LEGACY_SOURCE_ALREADY_ASSIGNED/);
    const queueId = db.prepare("SELECT id FROM playlists WHERE user_id=? AND kind='queue'").get(owner.id).id;
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playlist_items WHERE playlist_id=?').get(queueId).count, 1);
    db.close();
    const repeated = cli.importLegacy(legacyPath, 'legacy-owner', false, dbPath);
    assert.equal(repeated.alreadyImported, true);
  });

  it('imports a versioned user export idempotently without trusting its owner fields', () => {
    const importPath = path.join(dataDirectory, 'user-export.json');
    const payload = {
      formatVersion: 2,
      userId: 'forged-owner',
      playlists: [
        { kind: 'queue', name: '播放队列', items: [{ id: 'offline-track', source: 'kuwo', name: 'offline song' }] },
        { kind: 'custom', name: 'Imported list', items: [{ id: 'named-track', source: 'bilibili', name: 'named song' }] },
      ],
      favorites: { items: [{ song: { id: 'offline-favorite', source: 'netease', name: 'favorite' } }] },
      settings: { searchSource: 'kuwo', radarSettings: { genres: ['热歌'] } },
    };
    fs.writeFileSync(importPath, JSON.stringify(payload));
    const dry = cli.importUserFile(importPath, 'legacy-owner', true, dbPath);
    assert.equal(dry.dryRun, true);
    const imported = cli.importUserFile(importPath, 'legacy-owner', false, dbPath);
    assert.equal(imported.report.importedQueue, 1);
    assert.equal(imported.report.importedFavorites, 1);
    assert.equal(imported.report.importedPlaylists, 1);
    assert.equal(cli.importUserFile(importPath, 'legacy-owner', false, dbPath).alreadyImported, true);
    const db = openDatabase(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM favorites WHERE user_id=? AND track_id='offline-favorite'").get(owner.id).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM playlists WHERE user_id=? AND kind='custom' AND name='Imported list'").get(owner.id).count, 1);
    db.close();
  });

  it('recovers an active administrator with a hidden-input password operation', async () => {
    const result = await cli.resetAdminPassword('legacy-owner', 'recovered-admin-password-2026', dbPath);
    assert.equal(result.username, 'legacy-owner');
    const db = openDatabase(dbPath);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(owner.id).count, 0);
    db.close();
  });

  it('backs up committed WAL data and restores without losing a pre-restore copy', () => {
    const backupPath = path.join(dataDirectory, 'backups', 'verified-backup.db');
    const db = openDatabase(dbPath);
    const original = db.prepare('SELECT settings_json FROM user_settings WHERE user_id=?').get(owner.id).settings_json;
    cli.consistentBackup(dbPath, backupPath);
    db.prepare('UPDATE user_settings SET settings_json=? WHERE user_id=?').run('{"searchSource":"kuwo"}', owner.id);
    db.close();

    const result = cli.restoreBackup(backupPath, dbPath);
    assert.equal(result.restored, dbPath);
    assert.ok(result.previous && fs.existsSync(result.previous));
    const restored = openDatabase(dbPath);
    const after = restored.prepare('SELECT settings_json FROM user_settings WHERE user_id=?').get(owner.id).settings_json;
    assert.equal(after, original);
    assert.equal(cli.integrityCheck(restored), true);
    restored.close();
  });
});
