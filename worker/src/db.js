/**
 * The D1 access layer — the Worker's answer to src/db.js.
 *
 * WHAT CHANGED FROM better-sqlite3, and the rules that follow from it:
 *
 *  1. Everything is async. `db.prepare(...).get()` becomes
 *     `await one(db, sql, ...args)`. There is no synchronous escape hatch.
 *
 *  2. Bind parameters are POSITIONAL ONLY. D1's .bind() does not implement
 *     SQLite's named-parameter syntax, so every `@name` in the Express SQL was
 *     rewritten as `?` with the arguments listed in order. Where the original
 *     reused a name twice in one statement (upcomingSpecial's @excludeId,
 *     hasUpcoming's @uid) the value is simply bound twice.
 *
 *  3. There are no interactive transactions. `db.transaction(fn)` becomes
 *     `db.batch([stmt, stmt, ...])`, which D1 runs as one atomic unit. Anything
 *     that needs a value from statement N to build statement N+1 has to be
 *     restructured rather than batched — see hosts.unassign for the simple case
 *     and PORT-CLOUDFLARE.md §3 for the ingest case that P4 inherits.
 *
 *  4. Migrations are `wrangler d1 migrations apply`, not a boot-time runner.
 *     src/db.js's migrate() has no counterpart here: a Worker has no boot, and
 *     running DDL on a request path would be a footgun. The consequence worth
 *     knowing is that bootstrapRoles() — the boot-time expiry sweep plus
 *     "promote the oldest leader if there is no architect" — has nowhere to
 *     live either. The per-request half of it survives intact in loadUser
 *     (worker/src/auth/middleware.js), which demotes an expired leader the
 *     moment they touch the app; the app-wide sweep becomes a Cron Trigger in
 *     P5, where the rest of the scheduled work lands.
 */

/* ---------------- tiny query helpers ---------------- */

/** One row, or null. */
export async function one(db, sql, ...args) {
  const st = db.prepare(sql);
  return (args.length ? st.bind(...args) : st).first();
}

/** All rows, as a plain array (D1 wraps them in { results }). */
export async function all(db, sql, ...args) {
  const st = db.prepare(sql);
  const res = await (args.length ? st.bind(...args) : st).all();
  return res.results || [];
}

/** Execute; returns D1's meta ({ changes, last_row_id, ... }). */
export async function run(db, sql, ...args) {
  const st = db.prepare(sql);
  const res = await (args.length ? st.bind(...args) : st).run();
  return res.meta || {};
}

/** A single scalar from `SELECT <expr> AS v ...`. */
export async function scalar(db, sql, ...args) {
  const row = await one(db, sql, ...args);
  return row ? row.v : null;
}

/** Build a bound statement for db.batch([...]). */
export function stmt(db, sql, ...args) {
  const st = db.prepare(sql);
  return args.length ? st.bind(...args) : st;
}

/* ---------------- settings (key/value table) ---------------- */

export async function getSetting(db, key, fallback = null) {
  const row = await one(db, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

export async function setSetting(db, key, value) {
  await run(
    db,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    String(value)
  );
}

/* ---------------- role expiry sweep ---------------- */

/**
 * Demote every leader whose time-boxed term has run out. loadUser does the same
 * check per-request for the one user making the request; this catches everyone
 * else so the members table and counts are honest. On Node this ran at boot; on
 * Workers it belongs to the P5 Cron Trigger. It lives here so both callers find
 * it in the same place src/db.js kept it.
 *
 * Architects are never expired — the tier is permanent by construction.
 */
export async function sweepExpiredRoles(db) {
  const meta = await run(
    db,
    `UPDATE users SET role = 'member', role_expires_at = NULL
      WHERE role = 'leader' AND role_expires_at IS NOT NULL AND role_expires_at <= ?`,
    new Date().toISOString()
  );
  return meta.changes || 0;
}

/** True while the users table is empty — enables /setup and the first-run card. */
export async function noUsersYet(db) {
  const row = await one(db, 'SELECT COUNT(*) AS n FROM users');
  return !row || row.n === 0;
}

/* ---------------- stale-processing draft sweep (P5) ---------------- */

/**
 * A draft that never reached POST /:id/finalize — JS off, tab closed, laptop
 * shut mid-upload (worker/src/routes/drafts.js, "WHAT CHANGED") — stays
 * 'processing' forever unless something notices. src/services/ingest/index.js
 * ran this as sweepStaleProcessing() at Node boot; a Worker has no boot, so it
 * runs from the 15-minute Cron Trigger instead (worker/src/scheduled.js). The
 * SQL, the ten-minute threshold and the message are copied verbatim — a
 * member who sees this sentence should see the same one on either stack.
 */
export async function sweepStaleProcessingDrafts(db) {
  const meta = await run(
    db,
    `UPDATE drafts
        SET status = 'failed',
            error_msg = 'Upload interrupted — please re-upload.',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status = 'processing'
        AND COALESCE(updated_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')`
  );
  return meta.changes || 0;
}
