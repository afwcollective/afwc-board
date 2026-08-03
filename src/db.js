'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Runs every migration file whose numeric prefix is greater than the current
 * PRAGMA user_version, in order, each inside a transaction. Adding a migration
 * = dropping `00N_name.sql` into src/migrations/. Never edit a shipped one.
 */
function migrate() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let version = db.pragma('user_version', { simple: true });

  for (const file of files) {
    const n = Number(file.slice(0, 3));
    if (!Number.isFinite(n) || n <= version) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${n}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
    version = n;
    console.log(`[afwc] migration applied: ${file}`);
  }
  return version;
}

/* ---------- tiny settings helpers (key/value table) ---------- */

const getSettingStmt = () => db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = () =>
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

function getSetting(key, fallback = null) {
  const row = getSettingStmt().get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  setSettingStmt().run(key, String(value));
}

module.exports = { db, migrate, getSetting, setSetting };
