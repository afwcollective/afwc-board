/**
 * THE RETENTION POLICY — how long this board keeps the files people share.
 *
 * WHY THERE IS ONE NOW. Through P5 the answer was "forever", because R2's free
 * tier is 10 GB and nobody was going to reach it. The file store is D1 now
 * (worker/migrations/0003_file_store.sql: R2 needs a card on file, D1's 5 GB
 * free tier does not), and the same database that holds the bytes also holds
 * every member, post, meeting and comment. A file store that only ever grows
 * would eventually make the board itself the thing that runs out of room, and
 * it would do it silently, years from now, to whoever is holding the mailbox
 * by then. So it does not only grow.
 *
 * THE RULE, in the words the site uses: shared files are kept for a year, then
 * cleaned up automatically. The year is settings.file_retention_days, editable
 * by a leader on /admin (clamped to MIN_DAYS..MAX_DAYS), and the sweep runs
 * from the daily Cron Trigger — see worker/src/scheduled.js.
 *
 * WHAT EXPIRY MEANS, PER SCOPE. This is the part worth being deliberate about,
 * because "delete the file" is a different event depending on what the file was:
 *
 *   drafts   A draft IS its file. A page-turner with no pages is not a draft
 *            with a broken image, it is a dead link in the library. So when a
 *            draft's files age out THE DRAFT IS SOFT-DELETED TOO, by exactly
 *            the route POST /drafts/:id/delete takes — drafts.deleted_at set,
 *            its board thread soft-deleted with it — with deleted_by left NULL,
 *            which is the honest record: nobody removed it, it aged out. Every
 *            existing behaviour follows from that one flag with no special
 *            casing: the library stops listing it, the reader answers "That
 *            draft is not here", the comment rows survive untouched, and a
 *            leader with `wrangler d1 execute` can clear deleted_at exactly as
 *            they could for any other soft delete (though what comes back is
 *            the record, not the pages — those bytes are gone).
 *
 *            status and error_msg are DELIBERATELY NOT TOUCHED. 'failed' means
 *            "conversion did not work" and members read the sentence attached
 *            to it; repurposing it to mean "this got old" would put a wrong
 *            explanation in front of the one person who might still care.
 *
 *   chat     A message is a record of a conversation and does not stop having
 *            happened. The message stays exactly where it is, the attachment
 *            ROW stays with it, and only the bytes go: the stream route 404s
 *            through the same branch it always used for a missing file, and the
 *            chip in views/chat/messages.ejs renders a quiet "expired" state so
 *            nobody has to click a dead link to find out.
 *
 *   events   Same shape as chat. The meeting, its address and its details are
 *            the record; the flyer was an attachment to it. The event stays,
 *            the row stays, the link on the front page becomes a dimmed
 *            "expired" label.
 *
 * IDEMPOTENT AND BOUNDED. The sweep reads a page of expired rows at a time and
 * stops after MAX_BATCHES of them, so one day's cron invocation can never turn
 * into an unbounded job — whatever it does not get to is still expired tomorrow.
 * Deleting a stored_files row cascades to its chunks, so there is no second
 * pass and no orphan case to sweep later.
 *
 * DIVERGENCE FROM EXPRESS, ON PURPOSE. The Express/SQLite app in src/ keeps
 * uploaded files forever — it stores them on a disk whose size is the operator's
 * problem, and it has no cron. That divergence is documented in README.md and is
 * acceptable now that the self-hosted stack is the appendix rather than the
 * shipping product. The shared views read the Worker-only "expired" flags behind
 * typeof guards so Express renders byte-identically; see
 * worker/build/view-parity.mjs.
 */

import { getSetting, stmt } from '../db.js';
import * as filestore from './filestore.js';

/** The default the migration seeds, and what the copy on the site promises. */
export const DEFAULT_DAYS = 365;

/**
 * The bounds a leader may set from /admin. 30 days is short enough to be a
 * deliberate choice and long enough that nobody loses a draft between two
 * meetings; 3650 is ten years, which is "effectively forever" said out loud
 * rather than an unbounded text box.
 */
export const MIN_DAYS = 30;
export const MAX_DAYS = 3650;

/** Expired rows read (and deleted) per D1 round trip. */
const BATCH_ROWS = 200;

/** Ceiling on one invocation's work. See IDEMPOTENT AND BOUNDED above. */
const MAX_BATCHES = 25;

/** Soft-delete statements per D1 batch. */
const DRAFTS_PER_BATCH = 50;

/** A leader-supplied number, as a day count this module will act on. */
export function clampDays(value, fallback = DEFAULT_DAYS) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
}

/** The configured retention window, clamped — the setting is the only input. */
export async function retentionDays(db) {
  return clampDays(await getSetting(db, 'file_retention_days', String(DEFAULT_DAYS)));
}

/**
 * Soft-deletes the drafts whose files have gone, and their board threads with
 * them — the same two statements POST /drafts/:id/delete runs, minus the person
 * doing it. Returns how many drafts actually flipped (a draft a member had
 * already removed is left alone by the `deleted_at IS NULL` guard).
 */
async function softDeleteDrafts(db, draftIds) {
  let changed = 0;
  for (let i = 0; i < draftIds.length; i += DRAFTS_PER_BATCH) {
    const slice = draftIds.slice(i, i + DRAFTS_PER_BATCH);
    const statements = [];
    for (const id of slice) {
      statements.push(
        stmt(
          db,
          `UPDATE drafts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = NULL
            WHERE id = ? AND deleted_at IS NULL`,
          id
        ),
        stmt(
          db,
          `UPDATE threads SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = NULL
            WHERE draft_id = ? AND deleted_at IS NULL`,
          id
        )
      );
    }
    const results = await db.batch(statements);
    results.forEach((res, n) => {
      if (n % 2 === 0) changed += (res.meta && res.meta.changes) || 0;
    });
  }
  return changed;
}

/**
 * One pass of the policy. Returns a report the cron logs and the daily
 * integrity row records, so "what did the sweep do last night" is answerable
 * without waiting for a `wrangler tail` session.
 */
export async function sweepExpiredFiles(env, options = {}) {
  const db = env.DB;
  const now = options.now instanceof Date ? options.now : new Date();
  const days = options.days === undefined ? await retentionDays(db) : clampDays(options.days);
  const cutoff = new Date(now.getTime() - days * 86400e3).toISOString();

  const byScope = { drafts: 0, events: 0, chat: 0 };
  const draftIds = new Set();
  let files = 0;
  let bytes = 0;
  let truncated = true;

  for (let pass = 0; pass < MAX_BATCHES; pass += 1) {
    const rows = await filestore.expiredBefore(db, cutoff, BATCH_ROWS);
    if (!rows.length) {
      truncated = false;
      break;
    }
    for (const row of rows) {
      byScope[row.scope] = (byScope[row.scope] || 0) + 1;
      bytes += Number(row.size) || 0;
      if (row.scope === 'drafts') draftIds.add(Number(row.ref_id));
    }
    /*
     * `rows.length`, not what removeIds() reports back. D1's meta.changes for a
     * DELETE counts the rows the statement WROTE, cascaded chunk rows included —
     * so a five-file sweep came back as "10 files removed" the first time this
     * ran. The count that means something to a leader is files.
     */
    await filestore.removeIds(db, rows.map((r) => r.id));
    files += rows.length;
    if (rows.length < BATCH_ROWS) {
      truncated = false;
      break;
    }
  }

  const draftsSoftDeleted = draftIds.size ? await softDeleteDrafts(db, [...draftIds]) : 0;

  return {
    ran_at: now.toISOString(),
    retention_days: days,
    cutoff,
    files_removed: files,
    bytes_removed: bytes,
    by_scope: byScope,
    drafts_soft_deleted: draftsSoftDeleted,
    // True when the batch ceiling stopped the sweep early — whatever is left is
    // still expired tomorrow, so this is information, not a failure.
    more_remaining: truncated,
  };
}
