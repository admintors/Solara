'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'solara-multiuser.db');
let defaultDb = null;

function applyMigrations(database, migrationDir = path.join(__dirname, 'migrations')) {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const files = fs.readdirSync(migrationDir).filter(name => /^\d+[-_].+\.sql$/.test(name)).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const existing = database.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(file);
    if (existing) {
      if (existing.checksum !== checksum) throw new Error('Migration checksum mismatch: ' + file);
      continue;
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(sql);
      database.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?,?,?)').run(file, checksum, Date.now());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function openDatabase(dbPath = DB_PATH, options = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(dbPath, options.readOnly ? { readOnly: true } : undefined);
  if (!options.readOnly) {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    applyMigrations(database, options.migrationDir);
    try { fs.chmodSync(dbPath, 0o600); } catch {}
  } else {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }
  return database;
}

function getDb() {
  if (!defaultDb) defaultDb = openDatabase();
  return defaultDb;
}

function closeDb() {
  if (defaultDb) {
    defaultDb.close();
    defaultDb = null;
  }
}

function transaction(fn, database = getDb()) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = fn(database);
    database.exec('COMMIT');
    return value;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function json(value) {
  return JSON.stringify(value);
}

module.exports = { DATA_DIR, DB_PATH, openDatabase, getDb, closeDb, applyMigrations, transaction, json };
