/**
 * THE FILE STORE — every byte this app keeps that is not text, in D1.
 *
 * This module replaces the storage half of all three R2 modules
 * (worker/src/services/{events,chat,drafts}/attachments.js). Those three files
 * still exist and still own everything they were the authority on — extension
 * allowlists, size caps, magic-byte sniffing, stored-name generation, the
 * complaint sentences a member reads — and now call in here for the actual
 * bytes. See worker/migrations/0003_file_store.sql for why the bytes moved
 * (short version: R2 wants a card on file, D1's 5 GB free tier does not, and a
 * board handed down with a shared mailbox cannot inherit somebody's Visa).
 *
 * ============================================================== THE PATTERN ==
 *
 * The four rules written at the top of the events module were about R2. They
 * are the same four rules; here is what each one MEANS now that the store is a
 * table:
 *
 * 1. KEYS ARE BUILT, NEVER ACCEPTED. An object key became a triple —
 *    (scope, ref_id, stored_name) — and it is still composed, never received.
 *    The three wrapper modules each own the shape of their own stored_name and
 *    re-test it (SAFE_STORED_NAME / SAFE_REL) before anything reaches this
 *    file; `fileKey()` below is the second, generic gate: a scope from a fixed
 *    set, a positive integer ref, a plausible name. A hand-edited row still
 *    cannot name somebody else's bytes, and the reason is now structural — the
 *    UNIQUE index is the namespace, and there is no path syntax left to walk.
 *
 * 2. THE STORE IS NEVER PUBLIC. It never was, and now it CANNOT be: rows in a
 *    private database have no URL at all. Every byte still leaves through a
 *    Worker route that re-checks authorization first (reader.js, events.js,
 *    chat.js), every one of those routes is requireMember or stricter, and the
 *    chat stream still answers 404 — never 403 — to a non-participant so a DM's
 *    attachment does not even admit it exists.
 *
 * 3. VALIDATE BEFORE YOU WRITE. Unchanged, and unchanged on purpose: the
 *    callers still check extension → size → magic bytes on the bytes in hand,
 *    for every file in a submit, before the first `put()`. What is new is that
 *    the WRITE ITSELF is now all-or-nothing rather than best-effort: a file is
 *    a metadata row plus N chunk rows, the chunks go in as D1 batches, and if
 *    any of it fails the metadata row is deleted and ON DELETE CASCADE takes
 *    whatever chunks landed with it. There is no such thing as a half-written
 *    file that something else can find.
 *
 * 4. ROWS OWN THE BYTES. Rule 4 used to be an agreement between two systems —
 *    a D1 row was supposed to name an R2 object, and a sweep existed in case
 *    they ever disagreed. Now it is a foreign key. A file with no stored_files
 *    row is not merely unreachable, it does not exist; deleting the row deletes
 *    the bytes in the same statement. The one thing that did NOT change: a
 *    parent row (a draft, a chat message, an event) whose file is gone answers
 *    404 rather than exploding, which is what the old fs.existsSync check did
 *    and what the retention sweep now relies on.
 *
 * ============================================================== CHUNKING =====
 *
 * SQLite has a per-row ceiling and D1 publishes it as 2 MB, so a file cannot be
 * one row. CHUNK_BYTES is 1,000,000 — half the ceiling, leaving the rest of the
 * row and the query envelope plenty of room, and a round number so "how many
 * rows is this file" is answerable in your head. Chunks are 0-based and
 * contiguous; every one is exactly CHUNK_BYTES except the last.
 *
 * A RANGE READ NEVER LOADS THE FILE, OR EVEN A WHOLE CHUNK. `stream()` turns a
 * byte range into a closed interval of chunk numbers by arithmetic, asks for
 * exactly those rows, and asks SQLite to `substr()` the edges — so pdf.js
 * wanting bytes 5,000,000–5,032,767 of a 10 MB draft moves 32 KB, not the
 * megabyte-long row that range happens to sit inside. A full read is the same
 * machinery with wider edges: the body is a ReadableStream pulling one chunk at
 * a time, so a 10 MB download never materialises 10 MB in the isolate.
 *
 * CPU. Chunk rows are network I/O, which does not count against a Worker's
 * ~10 ms CPU budget, and with the slicing pushed into SQLite there is barely any
 * synchronous work left in a read at all. Measured on the local dev stack: a
 * 32 KB ranged read of a 10 MB draft, ~6 ms wall; a full read of a 4 KB draft,
 * ~4 ms; a full 10 MB download, ~270 ms wall, essentially all of it moving
 * bytes. The one genuinely CPU-hungry thing anyone does with these bytes is
 * hex-encoding them for a SQL backup, which is why that lives in
 * worker/src/services/backup.js behind a measured budget rather than here.
 */

import { all, one, run, stmt } from '../db.js';

/**
 * Bytes per chunk row. See CHUNKING above. Changing this number is safe for NEW
 * files and meaningless for old ones — nothing reads it back out of the
 * database, because a chunk's length is whatever the row holds and the last
 * chunk of any file is short by definition.
 */
export const CHUNK_BYTES = 1000000;

/** The three kinds of thing this app stores. Matches the CHECK in 0003. */
export const SCOPES = new Set(['drafts', 'events', 'chat']);

/**
 * How many chunk rows go into one D1 batch. Two, i.e. ~2 MB of BLOB per
 * round trip: enough that a 10 MB file is five batches rather than ten, small
 * enough that no single request carries an alarming payload. A batch is atomic
 * on D1's side; ACROSS batches, atomicity is the caller's rollback (delete the
 * metadata row, cascade takes the chunks) — see `put()`.
 */
const CHUNKS_PER_BATCH = 2;

/**
 * A stored_name this module will accept from a caller. Deliberately loose: the
 * three wrapper modules each apply their OWN, much stricter, pattern first
 * (rule 1), and duplicating those here would mean one edit could quietly widen
 * another. What this refuses is the class of thing no caller in this app could
 * ever produce — an empty name, a novel-length one, or anything carrying a NUL
 * or a control character.
 */
const PLAUSIBLE_NAME = /^[^\u0000-\u001f\u007f]{1,255}$/;

/* ------------------------------------------------------------------ keys -- */

/**
 * The one place a file's address is composed. Returns the triple, or null when
 * any part is not something this app could have produced — the caller then 404s
 * (or refuses to write) rather than asking the database a question built out of
 * user input.
 */
export function fileKey(scope, refId, storedName) {
  if (!SCOPES.has(scope)) return null;
  const id = Number(refId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const name = String(storedName || '');
  if (!PLAUSIBLE_NAME.test(name)) return null;
  return { scope, refId: id, storedName: name };
}

/* ------------------------------------------------------------ byte helpers */

/**
 * D1 hands a BLOB column back as an Array of numbers on some runtimes and an
 * ArrayBuffer or a typed array on others. One normaliser rather than an
 * assumption, because the difference only ever shows up as corrupted bytes a
 * long way downstream.
 */
function toBytes(value) {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(0);
}

/** An ArrayBuffer holding exactly `bytes[from, to)` — what D1 binds a BLOB from. */
function bufferSlice(bytes, from, to) {
  return bytes.buffer.slice(bytes.byteOffset + from, bytes.byteOffset + to);
}

/* ---------------------------------------------------------------- lookups -- */

const META_COLUMNS = 'id, scope, ref_id, stored_name, mime, size, created_at';

/** The metadata row behind one address, or null. */
export async function meta(db, scope, refId, storedName) {
  const key = fileKey(scope, refId, storedName);
  if (!key) return null;
  return one(
    db,
    `SELECT ${META_COLUMNS} FROM stored_files WHERE scope = ? AND ref_id = ? AND stored_name = ?`,
    key.scope,
    key.refId,
    key.storedName
  );
}

/** The metadata row behind one file id, or null. */
export async function metaById(db, fileId) {
  const id = Number(fileId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return one(db, `SELECT ${META_COLUMNS} FROM stored_files WHERE id = ?`, id);
}

/* ------------------------------------------------------------------ write -- */

/**
 * Writes one already-validated file and returns its metadata row.
 *
 * ALL-OR-NOTHING (rule 3). The metadata row goes in first — its id is what the
 * chunks hang off, exactly as a draft's id used to name its folder — then the
 * chunks, CHUNKS_PER_BATCH at a time. If anything after the metadata insert
 * throws, the metadata row is deleted and ON DELETE CASCADE removes whatever
 * chunks made it, so the failure leaves nothing behind for anything else to
 * find. The error is re-thrown, because every caller already has a
 * "we could not store that" path and a rollback is not a success.
 *
 * Re-putting the same address REPLACES it, which is what R2's put did. No
 * caller in this app relies on that — every stored_name is either freshly
 * random or freshly numbered under a freshly created id — but a store whose
 * write silently failed on a UNIQUE constraint would be a much worse surprise
 * than one that overwrites.
 */
export async function put(db, scope, refId, storedName, mime, bytes) {
  const key = fileKey(scope, refId, storedName);
  if (!key) throw new Error(`refusing to store an unsafe file address: ${scope}/${refId}/${storedName}`);

  const data = toBytes(bytes);
  const size = data.byteLength;
  const chunkCount = Math.ceil(size / CHUNK_BYTES);

  const created = await db.batch([
    stmt(
      db,
      'DELETE FROM stored_files WHERE scope = ? AND ref_id = ? AND stored_name = ?',
      key.scope,
      key.refId,
      key.storedName
    ),
    stmt(
      db,
      'INSERT INTO stored_files (scope, ref_id, stored_name, mime, size) VALUES (?, ?, ?, ?, ?)',
      key.scope,
      key.refId,
      key.storedName,
      mime || 'application/octet-stream',
      size
    ),
  ]);
  const fileId = Number(created[1].meta.last_row_id);

  try {
    for (let first = 0; first < chunkCount; first += CHUNKS_PER_BATCH) {
      const batch = [];
      for (let n = first; n < Math.min(first + CHUNKS_PER_BATCH, chunkCount); n += 1) {
        const from = n * CHUNK_BYTES;
        const to = Math.min(from + CHUNK_BYTES, size);
        batch.push(
          stmt(
            db,
            'INSERT INTO file_chunks (file_id, chunk_no, data) VALUES (?, ?, ?)',
            fileId,
            n,
            bufferSlice(data, from, to)
          )
        );
      }
      await db.batch(batch);
    }
  } catch (err) {
    // Rule 3's rollback: one DELETE, and the cascade does the rest.
    try {
      await run(db, 'DELETE FROM stored_files WHERE id = ?', fileId);
    } catch (cleanupErr) {
      console.error('[afwc] filestore rollback failed:', cleanupErr);
    }
    throw err;
  }

  if (chunkCount > 1) {
    console.log(
      `[afwc] filestore put: ${key.scope}/${key.refId}/${key.storedName} id=${fileId} ${size}B in ${chunkCount} chunks`
    );
  }

  return { id: fileId, scope: key.scope, ref_id: key.refId, stored_name: key.storedName, mime, size };
}

/* ------------------------------------------------------------------ reads -- */

/**
 * Part of one chunk's bytes — `len` bytes from `from` (0-based), or everything
 * from `from` when `len` is null. Empty if the row has gone missing.
 *
 * THE SLICING HAPPENS IN SQLITE, not here, and that is the point. `substr()` on
 * a BLOB is byte-addressed (1-based), so a reader asking for 32 KB out of the
 * middle of a 10 MB PDF moves 32 KB across the D1 boundary instead of the whole
 * megabyte-long chunk row it happens to live in. Measured on the local dev
 * stack, that took a 32 KB ranged read of a 10 MB draft from ~31 ms to ~6 ms,
 * and a 21-byte read straddling a chunk boundary from ~53 ms to ~6 ms —
 * D1 time is I/O rather than CPU, so it never threatened the budget, but it is
 * latency a reader feels on every page turn, and pdf.js turns pages a lot.
 */
async function chunkSlice(db, fileId, chunkNo, from, len) {
  const row = len === null
    ? await one(
        db,
        'SELECT substr(data, ?) AS d FROM file_chunks WHERE file_id = ? AND chunk_no = ?',
        from + 1,
        fileId,
        chunkNo
      )
    : await one(
        db,
        'SELECT substr(data, ?, ?) AS d FROM file_chunks WHERE file_id = ? AND chunk_no = ?',
        from + 1,
        len,
        fileId,
        chunkNo
      );
  return row ? toBytes(row.d) : new Uint8Array(0);
}

/**
 * Below this many bytes, a response body is a Uint8Array rather than a stream.
 *
 * WHY IT MATTERS, and it is not about memory. workerd will not send a
 * Content-Length alongside a ReadableStream — it cannot know the length in
 * advance, so it drops the header the route set and uses chunked transfer
 * encoding instead. That was already true of the R2 version (an R2 object's
 * body is a stream too), and it is the one place where a materialised body is
 * strictly better: pdf.js sizes a document from the Content-Length of its first
 * response, and a ranged read is a few tens of kilobytes.
 *
 * CHUNK_BYTES is the threshold because a body that fits in one chunk row is one
 * already-in-hand allocation — materialising it costs nothing that reading it
 * did not already cost. Anything larger streams, and a 10 MB download still
 * never puts 10 MB in the isolate.
 */
const MATERIALIZE_MAX = CHUNK_BYTES;

/**
 * A ReadableStream over chunks `from`..`to` (inclusive), with the first and
 * last trimmed to the requested byte offsets. One chunk row is fetched per
 * pull, so the isolate never holds more than CHUNK_BYTES of the file at once
 * however large the file or the range is.
 */
function chunkStream(db, fileId, from, to, sliceStart, sliceEndExclusive) {
  let n = from;
  return new ReadableStream({
    async pull(controller) {
      if (n > to) {
        controller.close();
        return;
      }
      const current = n;
      n += 1;
      const start = current === from ? sliceStart : 0;
      // The LAST chunk of the range is trimmed to the requested end; every
      // other one runs to its own end, whatever that turns out to be (the final
      // chunk of a file is short).
      const len = current === to ? Math.max(0, sliceEndExclusive - start) : null;
      const bytes = await chunkSlice(db, fileId, current, start, len);
      if (bytes.byteLength) controller.enqueue(bytes);
      if (current === to) controller.close();
    },
  });
}

/**
 * THE RANGE SEMANTICS, character for character what
 * worker/src/routes/reader.js's PDF route did against R2 and what
 * src/routes/reader.js does against a filesystem on the Express stack. pdf.js
 * is the client and its expectations are not negotiable, so this is a port of
 * the parsing rather than a fresh implementation of RFC 7233:
 *
 *   · a header that is not `bytes=<digits?>-<digits?>` DOES NOT MATCH and is
 *     ignored entirely — a garbage unit (`items=0-99`) gets a plain 200, not a
 *     416, exactly as before;
 *   · `bytes=-` (both halves empty) is 416 with `Content-Range: bytes * /size`;
 *   · `bytes=-N` is the LAST N bytes, floored at 0;
 *   · an end past the last byte is CLAMPED, not refused;
 *   · a start at or past the end of the file is 416, likewise with
 *     `bytes * /size`.
 */
function parseRange(rangeHeader, size) {
  const match = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return null;

  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);

  if (start === null && end === null) return { unsatisfiable: true };
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { unsatisfiable: true };
  }
  return { start, end };
}

/**
 * Reads a stored file, honouring an optional Range header.
 *
 * `target` is either an address — `{ scope, refId, storedName }` — or
 * `{ fileId }`. Returns null when the file is not there, so every caller keeps
 * its own 404 sentence; otherwise:
 *
 *     { status, headers, body, meta }
 *
 * `headers` carries ONLY the two headers whose value this module computes
 * (Content-Length, Content-Range). Content-Type, Content-Disposition,
 * Accept-Ranges and the no-store/X-Robots-Tag pair stay with the route that
 * owns the URL, which is where they have always been — that is what keeps the
 * public contract of each of these routes byte-identical to the R2 version.
 * `body` is null for 416.
 */
export async function stream(db, target, options = {}) {
  const row = target && target.fileId !== undefined
    ? await metaById(db, target.fileId)
    : await meta(db, target.scope, target.refId, target.storedName);
  if (!row) return null;

  const size = Number(row.size) || 0;
  const parsed = parseRange(options.range, size);

  if (parsed && parsed.unsatisfiable) {
    return { status: 416, headers: { 'Content-Range': `bytes */${size}` }, body: null, meta: row };
  }

  const start = parsed ? parsed.start : 0;
  const end = parsed ? parsed.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;

  // Built in the order the R2 version emitted them, so a `curl -D-` diff
  // against the P4 verification run shows nothing moved.
  const headers = {};
  if (parsed) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = String(length);

  if (length <= 0) {
    return { status: parsed ? 206 : 200, headers, body: null, meta: row };
  }

  // Chunk arithmetic — the whole point of rule "a range read never loads the
  // file". Only the rows in [firstChunk, lastChunk] are ever asked for.
  const firstChunk = Math.floor(start / CHUNK_BYTES);
  const lastChunk = Math.floor(end / CHUNK_BYTES);
  const sliceStart = start - firstChunk * CHUNK_BYTES;
  const sliceEndExclusive = end - lastChunk * CHUNK_BYTES + 1;

  const totalChunks = Math.ceil(size / CHUNK_BYTES);
  if (totalChunks > 1) {
    console.log(
      `[afwc] filestore stream: id=${row.id} ${row.scope}/${row.ref_id}/${row.stored_name} ` +
        `bytes ${start}-${end}/${size} → chunks ${firstChunk}..${lastChunk} of ${totalChunks}`
    );
  }

  const stream = chunkStream(db, row.id, firstChunk, lastChunk, sliceStart, sliceEndExclusive);
  const body = length <= MATERIALIZE_MAX ? await drain(stream, length) : stream;

  return { status: parsed ? 206 : 200, headers, body, meta: row };
}

/** Collects a chunk stream into one Uint8Array of exactly `length` bytes. */
async function drain(readable, length) {
  const out = new Uint8Array(length);
  const reader = readable.getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, length - at);
    if (take > 0) out.set(value.subarray(0, take), at);
    at += take;
  }
  return out;
}

/* ----------------------------------------------------------------- delete -- */

/**
 * Removes one file. Best-effort by contract — every caller is on a cleanup path
 * where throwing would replace a small problem with a bigger one — so a failure
 * is logged rather than raised, exactly as the R2 unlink helpers did.
 */
export async function remove(db, scope, refId, storedName) {
  const key = fileKey(scope, refId, storedName);
  if (!key) return 0;
  try {
    const res = await run(
      db,
      'DELETE FROM stored_files WHERE scope = ? AND ref_id = ? AND stored_name = ?',
      key.scope,
      key.refId,
      key.storedName
    );
    return res.changes || 0;
  } catch (err) {
    console.error('[afwc] filestore delete failed:', err);
    return 0;
  }
}

/* -------------------------------------------------------------- promotion -- */

/**
 * THE FILE SWAP'S TWO STATEMENTS, for the caller to put in its own batch.
 *
 * A draft whose file is being replaced holds both sets of bytes at once: the
 * live ones under `original.docx` / `pages/0001.png`, and the replacement under
 * the same names behind a prefix (`swap/…` — see
 * worker/src/services/drafts/attachments.js, which owns that shape). Promoting
 * one over the other is not a copy. It is:
 *
 *   1. delete every file under this ref that is NOT prefixed — the old bytes,
 *      chunks and all, by cascade;
 *   2. rename every file that IS prefixed to the name underneath it.
 *
 * Returned as statements rather than run here because they belong in the SAME
 * D1 batch as the row changes that make them true (the new draft_pages, the new
 * drafts.kind). A batch is atomic; two awaited calls are not, and the gap
 * between them is exactly where a reader would find a draft describing bytes
 * that no longer exist. In that order the UNIQUE index is never contended:
 * `swap/original.pdf` becomes `original.pdf` only after the previous
 * `original.pdf` is gone.
 *
 * `LIKE` needs no ESCAPE clause here because the prefix is a constant this
 * module's callers own, not user input — but it is still passed as a bound
 * parameter, so nothing about it is composed into SQL text.
 */
export function promoteStmts(db, scope, refId, prefix) {
  const key = fileKey(scope, refId, `${prefix}x`);
  if (!key) throw new Error(`refusing to promote an unsafe file address: ${scope}/${refId}/${prefix}`);
  const pattern = `${prefix}%`;
  return [
    stmt(
      db,
      'DELETE FROM stored_files WHERE scope = ? AND ref_id = ? AND stored_name NOT LIKE ?',
      key.scope,
      key.refId,
      pattern
    ),
    stmt(
      db,
      `UPDATE stored_files SET stored_name = substr(stored_name, ?)
        WHERE scope = ? AND ref_id = ? AND stored_name LIKE ?`,
      prefix.length + 1,
      key.scope,
      key.refId,
      pattern
    ),
  ];
}

/**
 * Throws away a staged, unpromoted set — the abandon half of promoteStmts().
 * Best-effort, like every other delete in this module: a swap that failed has
 * already given the member bad news and a cleanup that raises would only make
 * it worse.
 */
export async function removePrefixed(db, scope, refId, prefix) {
  const key = fileKey(scope, refId, `${prefix}x`);
  if (!key) return 0;
  try {
    const res = await run(
      db,
      'DELETE FROM stored_files WHERE scope = ? AND ref_id = ? AND stored_name LIKE ?',
      key.scope,
      key.refId,
      `${prefix}%`
    );
    return res.changes || 0;
  } catch (err) {
    console.error('[afwc] filestore staged delete failed:', err);
    return 0;
  }
}

/** Removes every file belonging to one thing. Same best-effort contract. */
export async function removeAllFor(db, scope, refId) {
  const key = fileKey(scope, refId, 'x');
  if (!key) return 0;
  try {
    const res = await run(db, 'DELETE FROM stored_files WHERE scope = ? AND ref_id = ?', key.scope, key.refId);
    return res.changes || 0;
  } catch (err) {
    console.error('[afwc] filestore bulk delete failed:', err);
    return 0;
  }
}

/* -------------------------------------------------------------- retention -- */

/**
 * Files older than `cutoffIso`, oldest first, at most `limit` of them — the
 * daily retention sweep's input (worker/src/scheduled.js). Returns metadata
 * only; the sweep decides what a given scope's expiry MEANS before anything is
 * deleted.
 */
export function expiredBefore(db, cutoffIso, limit) {
  return all(
    db,
    `SELECT ${META_COLUMNS} FROM stored_files WHERE created_at < ? ORDER BY created_at, id LIMIT ?`,
    cutoffIso,
    Math.max(1, Number(limit) || 200)
  );
}

/** Deletes the given file ids (chunks cascade). Returns how many rows went. */
export async function removeIds(db, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return 0;
  const res = await run(
    db,
    `DELETE FROM stored_files WHERE id IN (${list.map(() => '?').join(', ')})`,
    ...list
  );
  return res.changes || 0;
}

/** How many files and how many bytes the store is holding, by scope and total. */
export async function usage(db) {
  const rows = await all(
    db,
    'SELECT scope, COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM stored_files GROUP BY scope ORDER BY scope'
  );
  const totals = rows.reduce(
    (acc, r) => ({ files: acc.files + Number(r.files), bytes: acc.bytes + Number(r.bytes) }),
    { files: 0, bytes: 0 }
  );
  return { byScope: rows, ...totals };
}
