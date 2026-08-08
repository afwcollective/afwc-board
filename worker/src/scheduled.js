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
 *   daily, 09:00 UTC   TWO jobs, in one invocation. The RETENTION SWEEP
 *                      (worker/src/services/retention.js) — the one scheduled
 *                      job in this app that deletes anything a member can see,
 *                      and the reason its policy is written down at length in
 *                      that file rather than here. Then the integrity report,
 *                      which is observability and deletes nothing; it records
 *                      what the sweep did so a leader can read last night's
 *                      run without waiting for `wrangler tail`.
 *
 *   1st of the month,  the backup MARKER. This used to write a D1 → R2
 *   09:00 UTC          snapshot. There is no bucket any more — see
 *                      worker/src/services/backup.js — so there is no second
 *                      copy for a cron to make, and pretending otherwise
 *                      would be the most dangerous kind of comment to leave
 *                      in a codebase. What survives is the honest half: a
 *                      timestamp and a refreshed integrity report, so
 *                      /admin/backup can say "the last check was on the 1st"
 *                      while telling a leader plainly that THEIR download is
 *                      the backup.
 *
 * Each job is wrapped in its own try/catch so one failing sweep (a locked
 * table, a transient D1 error) cannot take the others down with it — the same
 * reasoning src/services/ingest/index.js's sweepStaleProcessing used for
 * not letting a sweep failure become an unhandled rejection at boot.
 */

import { one, getSetting, setSetting, sweepExpiredRoles, sweepStaleProcessingDrafts } from './db.js';
import * as sessions from './auth/sessions.js';
import * as ratelimit from './util/ratelimit.js';
import * as filestore from './services/filestore.js';
import * as retention from './services/retention.js';

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
 * triggers it). What IS worth knowing, without anyone clicking anything to
 * find out:
 *
 *   - how many attachments belong to a message a leader has removed (they are
 *     still served — /admin/help documents that as the moderation model — but
 *     a leader auditing storage should be able to see the number);
 *   - whether #general has ever drifted to more than one row. It is supposed
 *     to be exactly one, ensured lazily by the chat router (see
 *     worker/src/routes/chat.js's header) — this is the tripwire that would
 *     catch a bug in that idempotence, not a thing anyone is expected to fix
 *     by hand;
 *   - how much the file store is holding, and what last night's retention
 *     sweep took out of it. The bytes live in D1 now, so "how big is the file
 *     store" and "how close is this board to the 5 GB free tier" became the
 *     same question, and it should be answerable without a query.
 *
 * The result is written to a settings row rather than logged-and-forgotten so
 * a future admin surface (or a developer with `wrangler d1 execute`) can read
 * the last run without waiting for the next `wrangler tail` session.
 */
async function integrityReport(env, extra = {}) {
  const db = env.DB;
  const [orphanRow, generalRow, storeUsage] = await Promise.all([
    one(
      db,
      `SELECT COUNT(*) AS n
         FROM chat_attachments a
         JOIN chat_messages m ON m.id = a.message_id
        WHERE m.deleted_at IS NOT NULL`
    ),
    one(db, `SELECT COUNT(*) AS n FROM chat_channels WHERE kind = 'general'`),
    filestore.usage(db),
  ]);

  const report = {
    generated_at: new Date().toISOString(),
    soft_deleted_message_attachments: orphanRow ? Number(orphanRow.n) : 0,
    general_channel_count: generalRow ? Number(generalRow.n) : 0,
    general_channel_ok: (generalRow ? Number(generalRow.n) : 0) === 1,
    stored_files: storeUsage.files,
    stored_bytes: storeUsage.bytes,
    ...extra,
  };
  await setSetting(db, 'integrity_report', JSON.stringify(report));
  console.log('[afwc] cron integrity report:', report);
  return report;
}

/**
 * The daily job: sweep first, then report on a database that already reflects
 * the sweep. Both are wrapped so a failing sweep still leaves a report behind
 * saying so — a silent morning is the one outcome that would be hard to notice.
 */
async function dailyMaintenance(env) {
  let sweep = null;
  try {
    sweep = await retention.sweepExpiredFiles(env);
    console.log(
      `[afwc] cron daily retention: kept ${sweep.retention_days}d, removed ${sweep.files_removed} file(s) ` +
        `(${sweep.bytes_removed} bytes; drafts=${sweep.by_scope.drafts} events=${sweep.by_scope.events} ` +
        `chat=${sweep.by_scope.chat}), soft-deleted ${sweep.drafts_soft_deleted} draft(s)` +
        (sweep.more_remaining ? ' — more still expired, next run continues' : '')
    );
  } catch (err) {
    console.error('[afwc] cron daily: retention sweep failed:', err);
  }
  return integrityReport(env, { retention: sweep || { error: 'sweep failed — see logs' } });
}

/* ------------------------------------------------------------- monthly -- */

/**
 * There is no monthly copy any more; there is a monthly CHECK. See the header
 * of worker/src/services/backup.js for why the R2 snapshot went away and why
 * this deliberately does not pretend to replace it: the leader's download from
 * /admin/backup is the backup, and the only thing a robot can honestly do on
 * the 1st of the month is refresh the numbers that page shows and stamp the
 * time it did so.
 */
async function monthlyBackupCheck(env) {
  const db = env.DB;
  const now = new Date();
  const monthKey = now.toISOString().slice(0, 7); // YYYY-MM

  const report = await integrityReport(env, { monthly_check: monthKey });

  await setSetting(db, 'last_snapshot_at', now.toISOString());
  await setSetting(db, 'last_snapshot_month', monthKey);

  console.log(
    `[afwc] cron monthly backup check (${monthKey}): file store holds ${report.stored_files} file(s), ` +
      `${report.stored_bytes} byte(s). No automatic copy is made — the leader download is the backup.`
  );
  return report;
}

/* ---------------------------------------------------------- dispatch -- */

const JOBS = {
  '*/15 * * * *': fifteenMinuteSweep,
  '0 9 * * *': dailyMaintenance,
  '0 9 1 * *': monthlyBackupCheck,
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
