/**
 * The Cron Trigger dispatcher — the Worker's answer to everything src/app.js
 * ran once at Node boot (sweepExpiredRoles, the ingest sweep) plus a
 * setInterval (the rate-limit bucket cleanup, on Node an in-memory Map that
 * needed no cleanup at all). A Worker has no boot and no long-lived process,
 * so all of that housekeeping moves here, fired on the schedule declared in
 * worker/wrangler.toml's [triggers], and wired into the default export
 * alongside `fetch` in worker/src/index.js.
 *
 * THREE SCHEDULES, THREE JOBS — the exact cron expressions live in
 * wrangler.toml's [triggers] (a block comment can't repeat one of them
 * here without prematurely closing itself, so this file just names the
 * expressions in words and the JOBS table a few lines down has the literal
 * strings):
 *
 *   every 15 minutes   sweeps: stale-processing drafts, expired sessions,
 *                      expired leader roles, elapsed rate-limit rows. All
 *                      four are cheap, idempotent DELETE/UPDATE statements
 *                      that were previously either boot-time-only (drafts,
 *                      roles) or never swept at all on this stack until now
 *                      (sessions already had sweepExpired, just nothing was
 *                      calling it; rate_limits gained a P5 use beyond
 *                      login/reset in this same phase).
 *
 *   daily, 09:00 UTC   integrity report — observability, not deletion. See
 *                      dailyIntegrityReport() below for what it checks and
 *                      why there is no orphaned-R2 sweep here.
 *
 *   1st of the month,  monthly D1 → R2 snapshot (worker/src/services/backup.js),
 *   09:00 UTC          the belt-and-braces copy PORT-CLOUDFLARE.md §8 promises
 *                      independent of any leader remembering to click Download.
 *
 * Each job is wrapped in its own try/catch so one failing sweep (a locked
 * table, a transient D1 error) cannot take the others down with it — the same
 * reasoning src/services/ingest/index.js's sweepStaleProcessing used for
 * not letting a sweep failure become an unhandled rejection at boot.
 */

import { one, getSetting, setSetting, sweepExpiredRoles, sweepStaleProcessingDrafts } from './db.js';
import * as sessions from './auth/sessions.js';
import * as ratelimit from './util/ratelimit.js';
import * as backup from './services/backup.js';

/* ---------------------------------------------------------- every 15 min -- */

async function fifteenMinuteSweep(env) {
  const db = env.DB;
  const results = await Promise.allSettled([
    sweepStaleProcessingDrafts(db),
    sessions.sweepExpired(db),
    sweepExpiredRoles(db),
    ratelimit.sweepExpired(db),
  ]);
  const [drafts, sess, roles, limits] = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const label = ['stale-processing drafts', 'expired sessions', 'expired leader roles', 'elapsed rate limits'][i];
      console.error(`[afwc] cron 15m: ${label} sweep failed:`, r.reason);
    }
  });
  console.log(
    `[afwc] cron 15m: drafts=${drafts ?? 'ERR'} sessions=${sess ?? 'ERR'} roles=${roles ?? 'ERR'} rate_limits=${limits ?? 'ERR'}`
  );
}

/* -------------------------------------------------------------- daily -- */

/**
 * Observability, not deletion. Chat messages soft-delete (deleted_at /
 * deleted_by), and — per the P3 report — their attachments are kept
 * deliberately: a removed message still occupies its slot in the transcript,
 * and nothing in the app ever hard-deletes a chat_messages row (the CASCADE
 * on chat_attachments exists for the schema's sake, not because any route
 * triggers it), so there is no orphaned-R2 case to sweep. What IS worth
 * knowing, without anyone clicking anything to find out:
 *
 *   - how many attachments belong to a message a leader has removed (they are
 *     still served — /admin/help documents that as the moderation model — but
 *     a leader auditing storage should be able to see the number);
 *   - whether #general has ever drifted to more than one row. It is supposed
 *     to be exactly one, ensured lazily by the chat router (see
 *     worker/src/routes/chat.js's header) — this is the tripwire that would
 *     catch a bug in that idempotence, not a thing anyone is expected to fix
 *     by hand.
 *
 * The result is written to a settings row rather than logged-and-forgotten so
 * a future admin surface (or a developer with `wrangler d1 execute`) can read
 * the last run without waiting for the next `wrangler tail` session.
 */
async function dailyIntegrityReport(env) {
  const db = env.DB;
  const [orphanRow, generalRow] = await Promise.all([
    one(
      db,
      `SELECT COUNT(*) AS n
         FROM chat_attachments a
         JOIN chat_messages m ON m.id = a.message_id
        WHERE m.deleted_at IS NOT NULL`
    ),
    one(db, `SELECT COUNT(*) AS n FROM chat_channels WHERE kind = 'general'`),
  ]);

  const report = {
    generated_at: new Date().toISOString(),
    soft_deleted_message_attachments: orphanRow ? Number(orphanRow.n) : 0,
    general_channel_count: generalRow ? Number(generalRow.n) : 0,
    general_channel_ok: (generalRow ? Number(generalRow.n) : 0) === 1,
  };
  await setSetting(db, 'integrity_report', JSON.stringify(report));
  console.log('[afwc] cron daily integrity report:', report);
  return report;
}

/* ------------------------------------------------------------- monthly -- */

async function monthlySnapshot(env) {
  const db = env.DB;
  const now = new Date();
  const monthKey = now.toISOString().slice(0, 7); // YYYY-MM

  const snapshot = await backup.buildSnapshot(db);
  const result = await backup.writeSnapshotToR2(env, monthKey, snapshot);

  await setSetting(db, 'last_snapshot_at', now.toISOString());
  await setSetting(db, 'last_snapshot_month', monthKey);

  console.log(
    `[afwc] cron monthly snapshot: ${result.keys.length} object(s) under ${result.prefix}, ` +
      `${snapshot.totalRows} row(s) across ${snapshot.tables.length} table(s), ` +
      `cpu~${snapshot.cpuMs.toFixed(2)}ms`
  );
  return result;
}

/* ---------------------------------------------------------- dispatch -- */

const JOBS = {
  '*/15 * * * *': fifteenMinuteSweep,
  '0 9 * * *': dailyIntegrityReport,
  '0 9 1 * *': monthlySnapshot,
};

/**
 * The Worker's `scheduled` export (see worker/src/index.js). `event.cron` is
 * the exact cron expression from wrangler.toml that fired — matched by
 * string, not parsed, because there are only three of them and a lookup table
 * is both simpler and harder to get subtly wrong than a cron-matching
 * library. `ctx.waitUntil` keeps the invocation alive until the job settles,
 * exactly as it would for background work kicked off from a `fetch` handler.
 */
export async function scheduled(event, env, ctx) {
  const job = JOBS[event.cron];
  if (!job) {
    console.warn(`[afwc] scheduled event fired for unrecognized cron "${event.cron}" — no job wired to it`);
    return;
  }
  ctx.waitUntil(
    job(env).catch((err) => {
      console.error(`[afwc] cron job for "${event.cron}" failed:`, err);
    })
  );
}
