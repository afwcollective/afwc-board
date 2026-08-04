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
 *
 * Foreign keys are switched OFF for the duration of the run and back ON after,
 * because SQLite cannot ALTER a CHECK constraint: widening one (003 did it to
 * users.role) means rebuilding the table — create/copy/drop/rename — and the
 * DROP would otherwise cascade through every REFERENCES users(id) in the
 * schema. `PRAGMA foreign_keys` is a silent no-op inside a transaction, so the
 * toggle has to live out here rather than in the migration file. Each
 * migration's transaction then runs PRAGMA foreign_key_check before COMMIT: a
 * rebuild that orphaned a row rolls back instead of shipping.
 */
function migrate() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let version = db.pragma('user_version', { simple: true });
  const pending = files.filter((f) => {
    const n = Number(f.slice(0, 3));
    return Number.isFinite(n) && n > version;
  });
  if (!pending.length) return version;

  db.pragma('foreign_keys = OFF');
  try {
    for (const file of pending) {
      const n = Number(file.slice(0, 3));
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      db.exec('BEGIN');
      try {
        db.exec(sql);
        const violations = db.pragma('foreign_key_check');
        if (violations.length) {
          throw new Error(
            `foreign key check failed (${violations.length} orphaned row(s), first in "${violations[0].table}")`
          );
        }
        db.pragma(`user_version = ${n}`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
      version = n;
      console.log(`[afwc] migration applied: ${file}`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return version;
}

/* ---------- role bootstrap + expiry sweep (run once at boot) ---------- */

const nowIso = () => new Date().toISOString();

/**
 * Demote every leader whose time-boxed term has run out. loadUser does the same
 * check per-request for the one user making the request; this catches everyone
 * else so the members table and counts are honest the moment the app starts.
 * Architects are never expired — the tier is permanent by construction.
 */
function sweepExpiredRoles() {
  return db
    .prepare(
      `UPDATE users SET role = 'member', role_expires_at = NULL
        WHERE role = 'leader' AND role_expires_at IS NOT NULL AND role_expires_at <= ?`
    )
    .run(nowIso()).changes;
}

/**
 * There is always exactly one architect — every leader-management guard in the
 * app leans on that instead of a "last active leader" head-count. A database
 * that predates roles (or one whose architect row was hand-edited away) gets
 * the oldest active leader promoted, by id, which is the /setup account on any
 * board that ran /setup. Idempotent: a second boot finds an architect and
 * returns null without logging.
 *
 * This is deliberately NOT in the migration — a migration that guesses at who
 * should own the board is a migration you can't re-run or reason about.
 */
function ensureArchitect() {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'architect' LIMIT 1").get();
  if (existing) return null;

  const heir = db
    .prepare("SELECT id, username, display_name FROM users WHERE role = 'leader' AND is_active = 1 ORDER BY id ASC LIMIT 1")
    .get();
  if (!heir) return null; // fresh board — /setup mints the architect directly

  db.prepare("UPDATE users SET role = 'architect', role_expires_at = NULL WHERE id = ?").run(heir.id);
  console.log(
    `[afwc] no architect found — promoted the oldest active leader: ${heir.display_name} (@${heir.username}, id ${heir.id})`
  );
  return heir;
}

/** Boot-time role housekeeping. Order matters: expire first, then find an heir. */
function bootstrapRoles() {
  const expired = sweepExpiredRoles();
  if (expired) console.log(`[afwc] ${expired} temporary leader(s) expired and were demoted to member`);
  return { expired, promoted: ensureArchitect() };
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

module.exports = {
  db,
  migrate,
  bootstrapRoles,
  sweepExpiredRoles,
  ensureArchitect,
  getSetting,
  setSetting,
};
