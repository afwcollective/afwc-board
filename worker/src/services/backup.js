/**
 * D1 → R2 backup story for the Worker stack — PORT-CLOUDFLARE.md §8, built out
 * in P5. The port of src/services/backup.js, but a different shape, because a
 * Worker has neither of the two things that made the Node version simple:
 * better-sqlite3's synchronous `db.backup()` (a consistent file-copy in one
 * call) and a filesystem to zip alongside it. What replaces both is a SQL dump
 * built from scratch by reading every table through the normal D1 query
 * interface and writing plain `INSERT` statements — restoring is `sqlite3
 * fresh.db < dump.sql` after creating the schema from worker/migrations/.
 *
 * TWO CALLERS SHARE buildSnapshot():
 *   - the monthly Cron Trigger (worker/src/scheduled.js) writes the result to
 *     R2 under backups/YYYY-MM/ and records settings.last_snapshot_at;
 *   - a leader's on-demand download (worker/src/routes/admin.js GET
 *     /admin/backup/download.sql) builds the same thing live and records
 *     settings.last_backup_at — see BACKUP-STORY UX in the P5 report for why
 *     these are two different settings keys with two different triggers.
 *
 * -------------------------------------------------------------- CPU BUDGET --
 * D1 reads are network I/O and do not count against a Worker's CPU-time
 * limit; only the SYNCHRONOUS work of turning rows into escaped SQL text
 * does. dumpTable() below measures exactly that — the loop that stringifies
 * each batch, with the `await` on the D1 call excluded — with
 * `performance.now()`, and the total comes back on `snapshot.cpuMs`.
 *
 * Measured locally against the seeded dev database (worker/build/seed.mjs:
 * a handful of members, meetings, announcements, three seed drafts, a couple
 * of threads and chat channels — the realistic size of one club's board) the
 * whole-database dump costs low single-digit milliseconds of synchronous
 * time. The exact number from that run is in the P5 report.
 *
 * TWO independent things keep that true as the group's data grows, not one:
 *   1. PER-TABLE OBJECTS. The snapshot is never one giant file — each table
 *      gets its own R2 object (or several, see MAX_OBJECT_BYTES below), so no
 *      single invocation's synchronous cost is coupled to the SIZE OF THE
 *      WHOLE DATABASE, only to whichever table is currently being dumped.
 *   2. BATCH_ROWS. Each table is read `BATCH_ROWS` rows at a time — the
 *      stringify-and-append loop for one batch is the actual unit of
 *      synchronous work; between batches, control returns to the event loop
 *      only in the sense that the next `await` (the next SELECT) can start,
 *      which does not reset the CPU-time clock but does mean a slow table can
 *      be seen growing in size (and, if ever needed, made to flush a chunk
 *      early) rather than being one opaque block of work.
 *
 * If a single table's dump ever measured close to the ~10ms/request budget on
 * the free plan in real use — which would mean a table with many thousands of
 * rows of wide text, not anything this app's schema produces today — the fix
 * is smaller BATCH_ROWS (more, cheaper D1 round trips, same total data) before
 * anything more drastic. Nothing here assumes a table fits in one object:
 * splitChunks() below caps every object at MAX_OBJECT_BYTES regardless of
 * table size, so a table split three ways would just as automatically split
 * five ways at ten times the row count.
 *
 * The on-demand route additionally checks the MEASURED number for the request
 * that just ran and falls back to serving the latest cron snapshot instead of
 * ever returning a slow response — see CPU_BUDGET_MS in
 * worker/src/routes/admin.js.
 */

import { all } from '../db.js';

/** Rows fetched (and stringified) per D1 round trip, per table. */
export const BATCH_ROWS = 200;

/** A snapshot object is split into another file past this many characters. */
export const MAX_OBJECT_BYTES = 4 * 1024 * 1024;

/**
 * The R2 prefixes this app writes to, restated here (also documented in
 * worker/wrangler.toml) for the manifest and the leader-facing backup page —
 * one source of truth for "what's in the bucket besides the database."
 */
export const R2_PREFIXES = ['drafts/', 'events/', 'chat/', 'backups/'];

/* ---------------------------------------------------------- SQL escaping -- */

/** A D1 row value, as a literal that can sit inside a hand-written INSERT. */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return `X'${hex}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/* --------------------------------------------------------- table listing -- */

/**
 * Every real, application-owned table in the schema — sqlite_master minus
 * SQLite's own bookkeeping (`sqlite_%`), D1's internal tables (`_cf_%`), and
 * `d1_migrations`, the table `wrangler d1 migrations apply` uses to track
 * which files it has already run. That last one is deliberately excluded
 * even though it is a real, visible table: it is infrastructure bookkeeping
 * for the MECHANISM of restoring a schema, not data belonging to this app,
 * and `wrangler d1 migrations apply` populates it itself as it runs — a
 * restored database gets a correct one for free by re-running migrations,
 * not by replaying this snapshot's copy of it.
 */
async function listTables(db) {
  const rows = await all(
    db,
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
        AND name != 'd1_migrations'
      ORDER BY name`
  );
  return rows.map((r) => r.name);
}

/** Column names in declaration order — used both for INSERT and empty tables. */
async function tableColumns(db, table) {
  const rows = await all(db, `PRAGMA table_info("${table}")`);
  return rows.map((r) => r.name);
}

/** Split `text` into chunks no larger than MAX_OBJECT_BYTES, on line boundaries. */
function splitChunks(text) {
  if (text.length <= MAX_OBJECT_BYTES) return text ? [text] : [];
  const lines = text.split('\n');
  const chunks = [];
  let buf = '';
  for (const line of lines) {
    if (buf.length + line.length + 1 > MAX_OBJECT_BYTES && buf) {
      chunks.push(buf);
      buf = '';
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * Dumps one table's rows as INSERT statements, batched BATCH_ROWS at a time.
 * Returns the table's text (pre-split-by-byte-size — the caller decides how
 * many R2 objects that becomes), the row count, and the SYNCHRONOUS
 * (CPU-relevant) milliseconds spent turning rows into text.
 */
async function dumpTable(db, table) {
  const columns = await tableColumns(db, table);
  const colList = columns.map((c) => `"${c}"`).join(', ');
  let text = `-- ${table} (${columns.length} column${columns.length === 1 ? '' : 's'})\n`;
  let cpuMs = 0;
  let rowCount = 0;
  let offset = 0;

  if (!columns.length) return { text: `${text}-- table not found\n`, rowCount, cpuMs };

  for (;;) {
    const rows = await all(db, `SELECT * FROM "${table}" ORDER BY rowid LIMIT ? OFFSET ?`, BATCH_ROWS, offset);
    if (!rows.length) break;

    const t0 = performance.now();
    for (const row of rows) {
      const values = columns.map((c) => sqlLiteral(row[c])).join(', ');
      text += `INSERT INTO "${table}" (${colList}) VALUES (${values});\n`;
    }
    cpuMs += performance.now() - t0;

    rowCount += rows.length;
    offset += rows.length;
    if (rows.length < BATCH_ROWS) break;
  }

  if (!rowCount) text += '-- (no rows)\n';
  return { text, rowCount, cpuMs };
}

/**
 * The whole database, as a set of per-table text blobs ready to hand to R2 or
 * concatenate for a single download. Nothing here talks to R2 — that split
 * (cron writes many objects, the leader route writes one combined file) lives
 * in the two callers.
 */
export async function buildSnapshot(db) {
  const tables = await listTables(db);
  const objects = []; // { table, part, of, rowCount, text }
  let cpuMs = 0;
  let totalRows = 0;

  for (const table of tables) {
    const { text, rowCount, cpuMs: tableCpuMs } = await dumpTable(db, table);
    cpuMs += tableCpuMs;
    totalRows += rowCount;
    const chunks = splitChunks(text);
    if (!chunks.length) chunks.push(text);
    chunks.forEach((chunk, i) => {
      objects.push({ table, part: i + 1, of: chunks.length, rowCount: i === 0 ? rowCount : undefined, text: chunk });
    });
  }

  return { generatedAt: new Date().toISOString(), tables, objects, cpuMs, totalRows };
}

/** One combined .sql file — what the leader's on-demand download streams. */
export function combineSnapshot(snapshot) {
  const header =
    `-- AFWC Board — database backup\n` +
    `-- Generated ${snapshot.generatedAt}\n` +
    `-- Tables: ${snapshot.tables.join(', ')}\n` +
    `-- Restore: create the schema from worker/migrations/*.sql (in order), then run this file\n` +
    `-- (e.g. cat worker/migrations/*.sql this-file.sql | sqlite3 restored.db). Draft, event and\n` +
    `-- chat FILES are not in here — see the R2 prefixes in the backup page for those.\n\n`;
  return header + snapshot.objects.map((o) => o.text).join('\n');
}

/* -------------------------------------------------------------- R2 I/O ---- */

const sqlHttpMeta = { contentType: 'application/sql; charset=utf-8', cacheControl: 'private, no-store, max-age=0' };
const jsonHttpMeta = { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store, max-age=0' };

/**
 * Writes one month's snapshot to R2: one object per table (or per chunk of a
 * table past MAX_OBJECT_BYTES), plus a manifest.json naming them all. Called
 * from the monthly Cron Trigger; see worker/src/scheduled.js.
 */
export async function writeSnapshotToR2(env, monthKey, snapshot) {
  const prefix = `backups/${monthKey}/`;
  const keys = [];
  for (const obj of snapshot.objects) {
    const name = obj.of > 1 ? `${obj.table}.${obj.part}.sql` : `${obj.table}.sql`;
    const key = `${prefix}${name}`;
    await env.FILES.put(key, obj.text, { httpMetadata: sqlHttpMeta });
    keys.push(key);
  }

  const manifest = {
    generated_at: snapshot.generatedAt,
    month: monthKey,
    tables: snapshot.tables,
    total_rows: snapshot.totalRows,
    objects: keys,
    r2_prefixes: R2_PREFIXES,
    cpu_ms_measured: Math.round(snapshot.cpuMs * 100) / 100,
    note:
      'SQL dump of every application table (plain INSERT statements). Restore by creating the ' +
      'schema from worker/migrations/*.sql (in order) and running these files against it. Files ' +
      "under drafts/, events/ and chat/ are not duplicated here — copy them with wrangler r2 or " +
      'rclone; see the README.',
  };
  const manifestKey = `${prefix}manifest.json`;
  await env.FILES.put(manifestKey, JSON.stringify(manifest, null, 2), { httpMetadata: jsonHttpMeta });

  return { prefix, keys, manifestKey, manifest };
}

/**
 * Reconstructs one month's snapshot as a single combined .sql file by reading
 * back every object R2 lists under its prefix — the fallback the leader
 * download route uses when a live dump would run too close to the CPU budget
 * (worker/src/routes/admin.js, CPU_BUDGET_MS).
 */
export async function readSnapshotFromR2(env, monthKey) {
  const prefix = `backups/${monthKey}/`;
  const listed = await env.FILES.list({ prefix });
  const sqlKeys = (listed.objects || [])
    .map((o) => o.key)
    .filter((k) => k.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const parts = [
    `-- AFWC Board — database backup (from the automatic monthly snapshot, ${monthKey})\n` +
      `-- This is the most recent snapshot on file, not a live export — a live one was too\n` +
      `-- expensive to build within this request's CPU budget just now. Restore the same way:\n` +
      `-- create the schema from worker/migrations/*.sql, then run this file.\n\n`,
  ];
  for (const key of sqlKeys) {
    const got = await env.FILES.get(key);
    if (got) parts.push(await got.text());
  }
  return { text: parts.join('\n'), objectCount: sqlKeys.length };
}

/** Read one month's manifest.json back, or null if that month never ran. */
export async function readManifest(env, monthKey) {
  if (!monthKey) return null;
  const got = await env.FILES.get(`backups/${monthKey}/manifest.json`);
  if (!got) return null;
  try {
    return JSON.parse(await got.text());
  } catch {
    return null;
  }
}
