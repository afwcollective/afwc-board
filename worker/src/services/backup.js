/**
 * THE BACKUP STORY — PORT-CLOUDFLARE.md §8, rebuilt for a world with no R2.
 *
 * Through P5 there were two copies of the database: one a leader downloaded
 * from /admin/backup, and one a monthly Cron Trigger wrote into R2 under
 * backups/YYYY-MM/. The bucket is gone (worker/migrations/0003_file_store.sql
 * explains why: enabling R2 requires a payment method on file, and a board
 * handed on with a shared mailbox cannot inherit one), and with it the second
 * copy. So the honest sentence, which the /admin/backup page now says out loud:
 *
 *     THE LEADER'S DOWNLOAD IS THE BACKUP.
 *
 * There is no longer any off-site copy this app makes for itself. Cloudflare
 * keeps D1 durable and replicated, which protects against hardware; it does not
 * protect against somebody deleting the wrong thing, or against the account
 * itself going away. The only thing that does is a file on somebody's laptop,
 * and the only way one gets there is a leader clicking Download. The monthly
 * cron survives as a REMINDER rather than a copier — it refreshes the integrity
 * report and stamps settings.last_snapshot_at so the dashboard's staleness nag
 * has something honest to compare against.
 *
 * WHAT A BACKUP IS. A from-scratch SQL dump: every application table read
 * through the normal D1 query interface and written out as plain INSERT
 * statements. Restoring is `sqlite3 fresh.db < worker/migrations/*.sql` then
 * this file. That has not changed. What is new is that THE FILES ARE IN THE
 * DATABASE NOW, so a database dump can finally be a complete backup — draft
 * originals, page images, event and chat attachments and all — where the R2
 * version could only ever be half of one.
 *
 * -------------------------------------------------------------- CPU BUDGET --
 *
 * That completeness has a price, and it is the only genuinely hard engineering
 * decision in this file, so here are the measurements rather than a hand-wave.
 *
 * D1 reads are network I/O and do not count against a Worker's CPU-time limit;
 * only the SYNCHRONOUS work of turning rows into escaped SQL text does. For
 * text rows that is cheap — the whole of this app's non-file data measures
 * around a millisecond. For BLOB rows it is not: a blob has to become an X'…'
 * hex literal, which is two output characters per input byte.
 *
 * MEASURED, with the encoder below — a 256-entry code-point table into a
 * Uint16Array, then String.fromCharCode in 32 K windows, with the D1 row handed
 * through uncopied (see asBytes). Per megabyte of blob:
 *
 *     plain Node (V8, same code, best of eight)      ~5.7 ms
 *     workerd, `wrangler dev --local`, per 1 MB part  7–31 ms across runs
 *
 * THAT SPREAD IS NOT NOISE IN THE ENCODER, IT IS THE CLOCK. workerd advances
 * `performance.now()` only at I/O boundaries, so a measurement taken around a
 * purely synchronous stretch inside a request is coarse and run-dependent: the
 * same part measured 8 ms in one run and 29 ms in the next, with identical
 * bytes and identical wall time. Treat the top of that range as the number and
 * the bottom as luck.
 *
 * The free plan gives a request about 10 MS OF CPU IN TOTAL. Sized against the
 * pessimistic end, that is roughly a THIRD of a megabyte per request, and every
 * decision in this file falls out of that one fact:
 *
 *   · A SMALL STORE GOES IN THE MAIN DUMP. If everything the board is holding
 *     fits in INLINE_BLOB_BUDGET_BYTES (128 KB ≈ 3.7 ms), the download is one
 *     file and it contains everything. For this group's actual usage — mostly
 *     sub-megabyte prose drafts and a few small images — that is the normal
 *     case, and one file that restores the whole board is worth a lot.
 *
 *   · A LARGER STORE IS PAGINATED, NOT SILENTLY DROPPED. Past that, the main
 *     dump carries every table INCLUDING stored_files (that metadata is text,
 *     costs nothing, and is exactly what somebody checking a restore needs) but
 *     not file_chunks. It says so in a comment block nobody can miss, lists
 *     every file with its size, and carries the SQL to verify a restore. The
 *     bytes come down as numbered parts, PART_BLOB_BYTES of blob each, from
 *     /admin/backup/files.sql?part=N. Restore is migrations, then the main
 *     dump, then every part — the page and the comment block both spell it out.
 *
 *   · A FILE BIGGER THAN A PART CANNOT BE PAGINATED FURTHER, AND WE SAY SO.
 *     Parts are planned in CHUNK ROWS and a chunk row cannot be split across
 *     two valid SQL files, so a file large enough to have full chunk rows
 *     (filestore's CHUNK_BYTES, 1,000,000) produces a part measuring 8–30 ms
 *     — up to three times the free-plan budget. Such a part is FLAGGED as
 *     `oversize` in the plan, rendered with a warning on /admin/backup, in the
 *     comment block, and pointed at the tool that has no CPU limit at all:
 *
 *         npx wrangler d1 export afwc-board --remote --output afwc-full.sql
 *
 *     That is Cloudflare's own server-side export; it produces a complete dump,
 *     blobs included, without a Worker being involved. The README documents it
 *     as the developer-grade full backup. The in-app download stays the
 *     leader-grade one, and it is complete for the board this app is for.
 *
 * Three alternatives were considered and rejected in the open: dropping blobs
 * entirely with only a manifest (a "backup" that cannot restore the thing the
 * board exists to hold is not a backup); letting a part end mid-INSERT so parts
 * could be any size (works if you `cat` them in order, syntax error if you
 * don't — too sharp an edge to hand a volunteer); and reassembling split blobs
 * in SQL with `||` (SQLite coerces the operands to TEXT, and betting a backup
 * on how a particular SQLite build handles invalid UTF-8 is not a bet worth
 * making).
 *
 * Nothing here is trusted from the measurements above: every download reports the
 * cost of what it actually built on an X-Backup-Cpu-Ms header, so the first
 * real production download tells the truth about production.
 */

import { all, one } from '../db.js';

/** Rows fetched (and stringified) per D1 round trip, for text tables. */
export const BATCH_ROWS = 200;

/**
 * How much blob the MAIN dump will carry inline. 128 KB ≈ 3.7 ms at the
 * pessimistic measured rate, leaving the rest of the ~10 ms request budget for
 * the other tables, the session lookup and the response. Below this, a backup
 * is one file — which is the case that matters, because it is the one this
 * board will actually be in.
 */
export const INLINE_BLOB_BUDGET_BYTES = 128 * 1024;

/**
 * How much blob ONE PART carries: 256 KB ≈ 7.4 ms at the measured rate, which
 * fits the free plan's ~10 ms with something left for the rest of the request.
 * Deliberately far below filestore's CHUNK_BYTES — a part made of ordinary
 * small files is comfortably inside the budget, and a chunk row too big to fit
 * is flagged rather than pretended about. See the header's third bullet.
 */
export const PART_BLOB_BYTES = 256 * 1024;

/** The table whose rows are blobs. Everything else here is text. */
const BLOB_TABLE = 'file_chunks';

/* ---------------------------------------------------------- SQL escaping -- */

/** Two-character hex code points for every byte value, as one flat table. */
const HEX_CODES = new Uint16Array(512);
for (let i = 0; i < 256; i += 1) {
  const pair = i.toString(16).padStart(2, '0');
  HEX_CODES[i * 2] = pair.charCodeAt(0);
  HEX_CODES[i * 2 + 1] = pair.charCodeAt(1);
}

/** Characters per String.fromCharCode call. Larger blows the argument limit. */
const FROM_CHAR_WINDOW = 32768;

/** Bytes → the hex body of an X'…' literal. See CPU BUDGET in the header. */
function hexOf(bytes) {
  const n = bytes.length;
  const codes = new Uint16Array(n * 2);
  for (let i = 0, j = 0; i < n; i += 1) {
    const at = bytes[i] * 2;
    codes[j] = HEX_CODES[at];
    codes[j + 1] = HEX_CODES[at + 1];
    j += 2;
  }
  const parts = [];
  for (let i = 0; i < codes.length; i += FROM_CHAR_WINDOW) {
    parts.push(String.fromCharCode.apply(null, codes.subarray(i, Math.min(i + FROM_CHAR_WINDOW, codes.length))));
  }
  return parts.join('');
}

/**
 * D1 hands BLOBs back as an Array of numbers, an ArrayBuffer or a typed-array
 * view, depending on the runtime. hexOf() only needs `.length` and indexed byte
 * access, both of which a plain Array already provides — so an Array is handed
 * straight through rather than copied into a Uint8Array first. That copy is not
 * free at this size: converting a million-element JS array measured as a real
 * fraction of a part's cost when this was first benchmarked, for no benefit.
 */
function asBytes(value) {
  if (Array.isArray(value) || value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value);
}

/**
 * INSERT OR REPLACE, not INSERT, everywhere in this file — a deliberate choice
 * with one concrete reason. worker/migrations/0003_file_store.sql SEEDS a
 * settings row (file_retention_days), so a restore that ran the migrations and
 * then a plain `INSERT INTO settings` would die on the primary key before it
 * reached the rest of the file. More generally: a dump replayed onto a schema
 * that already carries a seeded row, or replayed twice, should converge on the
 * dump's version of reality rather than abort halfway. Verified end to end by
 * the restore drill in this phase's report.
 */
const INSERT = 'INSERT OR REPLACE INTO';

/** A D1 row value, as a literal that can sit inside a hand-written INSERT. */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Array.isArray(v)) {
    return `X'${hexOf(asBytes(v))}'`;
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

/* ------------------------------------------------------- the file store --- */

/** How many files the store holds and how many bytes they add up to. */
export async function fileStoreSummary(db) {
  const row = await one(
    db,
    'SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM stored_files'
  );
  const files = row ? Number(row.files) : 0;
  const bytes = row ? Number(row.bytes) : 0;
  return { files, bytes, fitsInline: bytes <= INLINE_BLOB_BUDGET_BYTES, parts: 0 };
}

/**
 * The download plan for a file store too big to inline: a list of parts, each
 * covering a contiguous run of CHUNK ROWS worth at most PART_BLOB_BYTES.
 *
 * PARTS ARE PLANNED IN CHUNKS, NOT IN FILES, and that is the correction this
 * phase's verification forced. Planning by file meant one 10 MB draft became one
 * 10 MB part, which measured 93 ms of CPU — nine times the budget the whole
 * scheme exists to respect. A chunk row is bounded by filestore's CHUNK_BYTES,
 * so planning in chunks bounds a part no matter how big any single file is.
 *
 * The planning query reads `length(data)`, not `data`: SQLite answers that from
 * the row header without materialising the blob, so building the plan is cheap
 * even for a store far larger than one request could ever dump.
 */
export async function planFileParts(db) {
  const rows = await all(
    db,
    'SELECT file_id, chunk_no, length(data) AS n FROM file_chunks ORDER BY file_id, chunk_no'
  );
  const parts = [];
  let current = null;
  for (const row of rows) {
    const size = Number(row.n) || 0;
    if (!current || (current.bytes > 0 && current.bytes + size > PART_BLOB_BYTES)) {
      current = {
        part: parts.length + 1,
        fromFile: row.file_id,
        fromChunk: row.chunk_no,
        toFile: row.file_id,
        toChunk: row.chunk_no,
        rows: 0,
        bytes: 0,
      };
      parts.push(current);
    }
    current.toFile = row.file_id;
    current.toChunk = row.chunk_no;
    current.rows += 1;
    current.bytes += size;
    // One chunk row that on its own exceeds a part. It still gets a part (it is
    // better to offer it and let the measured header tell the truth than to
    // hide it), but everything downstream labels it — see the header's third
    // bullet and the warning on /admin/backup.
    current.oversize = current.bytes > PART_BLOB_BYTES;
  }
  return parts;
}

/**
 * Dumps the file_chunks rows belonging to ONE part. Rows are read one at a time
 * — each is up to a megabyte, and asking for two hundred of them the way
 * dumpTable() asks for text rows would try to move a couple of hundred
 * megabytes through one response.
 *
 * The stored_files METADATA is not here; it is in the main dump, where it costs
 * nothing (see buildSnapshot). That keeps a part to exactly one job.
 *
 * Text is accumulated in an array and joined once rather than with `+=`. At
 * these sizes — a part is megabytes of hex — repeated concatenation makes V8
 * flatten a growing rope over and over, and the difference is measurable.
 */
export async function dumpFilePart(db, plan) {
  const rows = await all(
    db,
    `SELECT file_id, chunk_no FROM file_chunks
      WHERE (file_id > ? OR (file_id = ? AND chunk_no >= ?))
        AND (file_id < ? OR (file_id = ? AND chunk_no <= ?))
      ORDER BY file_id, chunk_no`,
    plan.fromFile, plan.fromFile, plan.fromChunk,
    plan.toFile, plan.toFile, plan.toChunk
  );

  const out = [
    `-- AFWC Board — file bytes, part ${plan.part}\n` +
      `-- ${rows.length} chunk row(s), ${plan.bytes} byte(s), file ${plan.fromFile} chunk ${plan.fromChunk} ` +
      `through file ${plan.toFile} chunk ${plan.toChunk}\n` +
      `-- Load AFTER the main backup .sql (which carries the stored_files rows these\n` +
      `-- chunks belong to). Parts may be loaded in any order; ALL of them are needed.\n`,
  ];
  let cpuMs = 0;

  for (const { file_id: fileId, chunk_no: chunkNo } of rows) {
    const row = await one(db, 'SELECT data FROM file_chunks WHERE file_id = ? AND chunk_no = ?', fileId, chunkNo);
    if (!row) continue;
    const t0 = performance.now();
    out.push(`${INSERT} "file_chunks" ("file_id", "chunk_no", "data") VALUES (${fileId}, ${chunkNo}, ${sqlLiteral(row.data)});\n`);
    cpuMs += performance.now() - t0;
  }

  const t1 = performance.now();
  const text = out.join('');
  cpuMs += performance.now() - t1;

  return { text, cpuMs, rows: rows.length };
}

/**
 * What a main dump that had to leave the bytes out says instead — so the .sql
 * file itself records exactly what is missing from it and how to check, rather
 * than leaving that on a web page somebody may not have read.
 */
export async function fileManifestComment(db, parts) {
  const rows = await all(
    db,
    `SELECT id, scope, ref_id, stored_name, size, created_at FROM stored_files ORDER BY id`
  );
  const totalBytes = rows.reduce((sum, r) => sum + (Number(r.size) || 0), 0);
  const lines = [
    '-- ============================================================================',
    '--  THE FILE BYTES ARE NOT IN THIS FILE. The stored_files rows below ARE.',
    '--',
    `--  This board is holding ${rows.length} file(s), ${totalBytes} byte(s). Writing bytes out as`,
    '--  SQL costs up to ~30 ms of CPU per megabyte, and a Cloudflare Worker on the',
    '--  free plan gets about 10 ms per request in total — so past a very small store',
    '--  they cannot all be built in one response. They are downloaded as numbered',
    '--  PARTS instead, from the same Backups page you got this file from:',
    '--',
    ...(parts || []).map(
      (p) =>
        `--      /admin/backup/files.sql?part=${p.part}   ${p.rows} chunk(s), ${p.bytes} byte(s)` +
        (p.oversize ? '   ** larger than one request s budget; see below **' : '')
    ),
    ...((parts || []).some((p) => p.oversize)
      ? [
          '--',
          '--  The parts marked ** hold a single file chunk too large to build inside one',
          '--  request. They may time out. For a complete copy that no CPU limit applies',
          '--  to, use Cloudflare s own server-side export from a terminal instead:',
          '--      npx wrangler d1 export afwc-board --remote --output afwc-full.sql',
          '--  See README.md. That file is a full backup on its own; nothing else needed.',
        ]
      : []),
    '--',
    '--  TO RESTORE EVERYTHING: create the schema from worker/migrations/*.sql in',
    '--  order, run THIS file, then run EVERY part file (any order). All of them are',
    '--  required — this file names every file the board holds, so a restore that is',
    '--  missing a part leaves some of them short rather than absent.',
    '--',
    '--  TO CHECK A RESTORE, run this against the restored database. It should',
    '--  return no rows:',
    '--      SELECT s.id, s.scope, s.ref_id, s.stored_name, s.size,',
    '--             COALESCE(SUM(LENGTH(c.data)), 0) AS restored',
    '--        FROM stored_files s LEFT JOIN file_chunks c ON c.file_id = s.id',
    '--       GROUP BY s.id HAVING restored <> s.size;',
    '--',
    '--  What is in this board right now, for checking against:',
    ...rows.map(
      (r) => `--      #${r.id}  ${r.scope}/${r.ref_id}/${r.stored_name}  ${r.size} bytes  ${r.created_at}`
    ),
    '-- ============================================================================',
    '',
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------- the dump --- */

/** Split `text` into chunks no larger than `max`, on line boundaries. */
function splitChunks(text, max) {
  if (text.length <= max) return text ? [text] : [];
  const lines = text.split('\n');
  const chunks = [];
  let buf = '';
  for (const line of lines) {
    if (buf.length + line.length + 1 > max && buf) {
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
 * Returns the table's text, the row count, and the SYNCHRONOUS (CPU-relevant)
 * milliseconds spent turning rows into text.
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
      text += `${INSERT} "${table}" (${colList}) VALUES (${values});\n`;
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
 * The whole database, as per-table text blobs.
 *
 * `options.includeFileBlobs` decides whether file_chunks — the BLOB table, and
 * the only expensive one — is dumped here or paginated into parts; the caller
 * decides that from fileStoreSummary(), not from a guess. stored_files is
 * ALWAYS dumped either way: it is text, it costs nothing, and it is the record
 * of what the board holds, which is exactly what somebody checking a restore
 * needs in front of them.
 */
export async function buildSnapshot(db, options = {}) {
  const includeFileBlobs = !!options.includeFileBlobs;
  const skip = includeFileBlobs ? new Set() : new Set([BLOB_TABLE]);
  const tables = (await listTables(db)).filter((t) => !skip.has(t));

  const objects = []; // { table, part, of, rowCount, text }
  let cpuMs = 0;
  let totalRows = 0;

  for (const table of tables) {
    const { text, rowCount, cpuMs: tableCpuMs } = await dumpTable(db, table);
    cpuMs += tableCpuMs;
    totalRows += rowCount;
    // 4 MB per piece: only ever relevant to how the text is assembled, since
    // there is nowhere to write pieces to any more — the whole thing is one
    // download. Kept because splitting on line boundaries is also what keeps
    // the assembled file readable.
    const chunks = splitChunks(text, 4 * 1024 * 1024);
    if (!chunks.length) chunks.push(text);
    chunks.forEach((chunk, i) => {
      objects.push({ table, part: i + 1, of: chunks.length, rowCount: i === 0 ? rowCount : undefined, text: chunk });
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    tables,
    objects,
    cpuMs,
    totalRows,
    includeFileBlobs,
  };
}

/** One combined .sql file — what the leader's on-demand download streams. */
export function combineSnapshot(snapshot, extra = '') {
  const filesLine = snapshot.includeFileBlobs
    ? '-- Draft, event and chat FILES ARE INCLUDED, as stored_files + file_chunks rows\n' +
      "-- (bytes as X'…' hex literals). This file is a complete backup on its own.\n"
    : '-- Draft, event and chat files are NOT in this file — see the block below.\n';

  const header =
    `-- AFWC Board — database backup\n` +
    `-- Generated ${snapshot.generatedAt}\n` +
    `-- Tables: ${snapshot.tables.join(', ')}\n` +
    `-- Restore: create the schema from worker/migrations/*.sql (in order), then run this file\n` +
    `-- (e.g. cat worker/migrations/*.sql this-file.sql | sqlite3 restored.db).\n` +
    filesLine +
    `\n`;
  return header + (extra || '') + snapshot.objects.map((o) => o.text).join('\n');
}
