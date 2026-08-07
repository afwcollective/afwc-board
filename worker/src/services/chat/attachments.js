/**
 * Chat attachments on R2 — the second application of THE R2 PATTERN written
 * down at the top of worker/src/services/events/attachments.js. The four rules,
 * and how this module keeps them:
 *
 * 1. KEYS ARE BUILT, NEVER ACCEPTED. `key(channelId, messageId, storedName)` is
 *    the only place a chat object key is composed, out of two validated
 *    integers and a stored_name THIS module generated. A stored_name read back
 *    from D1 is re-tested against SAFE_STORED_NAME before it is used, so a
 *    hand-edited row cannot walk the bucket. Shape:
 *        chat/<channelId>/<messageId>/<stored_name>
 *    — the same three-level tree src/routes/chat.js kept on disk under
 *    uploads/chat/, minus the uploads/ segment a bucket has no use for.
 *
 * 2. THE BUCKET IS NEVER PUBLIC. Every byte leaves through
 *    GET /chat/files/:id, which RE-DERIVES channel access from the message's
 *    channel on each request and answers 404 — never 403 — to anyone who is not
 *    a participant. A URL copied out of a DM is dead the moment it reaches a
 *    third party, and it does not even admit the file exists.
 *
 * 3. VALIDATE BEFORE YOU PUT. Extension → size → magic bytes (or a fatal UTF-8
 *    decode for the two formats that have no signature), all on the bytes in
 *    hand, and the caller writes NOTHING to R2 until every file in the message
 *    has passed. multer's declarative caps — 3 files, 10 MB each — become the
 *    explicit checks in `limitError()` because there is no streaming parser
 *    here to enforce them for us; the complaint sentences are multer's, kept
 *    word for word because members read them.
 *
 * 4. D1 ROWS OWN THE OBJECTS. The message row is written first (its id names
 *    the folder, exactly as it named the directory before), then the objects,
 *    then the attachment rows. If anything in that tail fails, the caller
 *    unlinks whatever landed and hard-deletes the message — attachments
 *    cascade — so an object nobody can name never survives a failed send. A
 *    row whose object is missing answers 404 rather than exploding, which is
 *    what the fs.existsSync check did.
 *
 * This is deliberately a separate copy of the idea rather than a generalization
 * of the events module: the two answer different questions (what may a LEADER
 * attach to an event vs. what may ANY MEMBER drop in a conversation) over
 * different allowlists, and folding them together would mean one edit could
 * quietly widen the other.
 */

/** multer's `limits` from src/routes/chat.js, as explicit numbers. */
export const MAX_FILES = 3;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Extension allowlist, character for character the object src/routes/chat.js
 * declares. `mime` is what the stream route labels the bytes with on the way
 * out; `inline` decides Content-Disposition (an image or a PDF opens in place,
 * everything else is offered as a download); `image` drives the thumbnail in
 * views/chat/messages.ejs.
 */
export const ALLOWED = {
  '.jpg': { mime: 'image/jpeg', inline: true, image: true },
  '.jpeg': { mime: 'image/jpeg', inline: true, image: true },
  '.png': { mime: 'image/png', inline: true, image: true },
  '.webp': { mime: 'image/webp', inline: true, image: true },
  '.gif': { mime: 'image/gif', inline: true, image: true },
  '.pdf': { mime: 'application/pdf', inline: true },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.txt': { mime: 'text/plain; charset=utf-8' },
  '.md': { mime: 'text/plain; charset=utf-8' },
  '.zip': { mime: 'application/zip' },
};

/** Only ever what makeStoredName produces: 20 hex characters and our extension. */
const SAFE_STORED_NAME = /^[0-9a-f]{20}(\.[a-z0-9]{1,8})?$/;

const startsWith = (buf, bytes) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

const latin1 = (buf, from, to) =>
  Array.from(buf.subarray(from, to), (b) => String.fromCharCode(b)).join('');

/** node:path.extname, for a filename that never touches a filesystem. */
export function extname(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/**
 * The extension is a hint; these bytes are the check — same contract, same
 * sentences as sniff() in src/routes/chat.js. Returns null when the file is
 * what it claims. Formats with no magic number of their own (.txt/.md) are
 * validated as UTF-8 text instead, with a FATAL decoder so a mislabelled binary
 * is refused rather than mangled; .zip is allowed on its PK signature, which
 * .docx shares because every OOXML file is a zip.
 *
 * `bytes` is the whole file (the UTF-8 branch needs all of it); the signature
 * branches only ever look at the head.
 */
export function sniff(ext, bytes) {
  const head = bytes.subarray(0, 16);
  if (ext === '.jpg' || ext === '.jpeg') {
    return startsWith(head, [0xff, 0xd8, 0xff]) ? null : 'is not a real JPEG.';
  }
  if (ext === '.png') {
    return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? null
      : 'is not a real PNG.';
  }
  if (ext === '.gif') {
    const tag = latin1(head, 0, 6);
    return tag === 'GIF87a' || tag === 'GIF89a' ? null : 'is not a real GIF.';
  }
  if (ext === '.webp') {
    const ok =
      startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
      head.length >= 12 &&
      latin1(head, 8, 12) === 'WEBP';
    return ok ? null : 'is not a real WebP image.';
  }
  if (ext === '.pdf') {
    return startsWith(head, [0x25, 0x50, 0x44, 0x46])
      ? null
      : 'is not a real PDF (its contents do not start with %PDF).';
  }
  if (ext === '.docx') {
    return startsWith(head, [0x50, 0x4b])
      ? null
      : 'is not a real Word file (its contents are not a .docx).';
  }
  if (ext === '.zip') {
    return startsWith(head, [0x50, 0x4b]) ? null : 'is not a real zip archive.';
  }
  if (ext === '.txt' || ext === '.md') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return null;
    } catch {
      return 'is not plain UTF-8 text.';
    }
  }
  return 'is not a file type chat accepts.';
}

/**
 * multer's limits, as a check the route can run itself. Same order and the same
 * two sentences multer's LIMIT_FILE_COUNT and LIMIT_FILE_SIZE mapped to in
 * src/routes/chat.js handleUpload(). Returns null when the batch is fine.
 */
export function limitError(files) {
  const list = files || [];
  if (list.length > MAX_FILES) return `Up to ${MAX_FILES} files per message.`;
  if (list.some((f) => f.size > MAX_FILE_BYTES)) {
    return `Attachments max out at ${MAX_FILE_BYTES / 1024 / 1024} MB each.`;
  }
  return null;
}

/** A collision-proof stored name: 10 random bytes as hex, plus our extension. */
export function makeStoredName(ext) {
  const clean = /^\.[a-z0-9]{1,8}$/.test(String(ext || '')) ? ext : '';
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  return `${rand}${clean}`;
}

/**
 * The one place a chat object key is composed. Returns null when any part is
 * not something this module could have produced — the caller then 404s rather
 * than asking R2 a question built out of user input.
 */
export function key(channelId, messageId, storedName) {
  const channel = Number(channelId);
  const message = Number(messageId);
  if (!Number.isInteger(channel) || channel <= 0) return null;
  if (!Number.isInteger(message) || message <= 0) return null;
  const name = String(storedName || '');
  if (!SAFE_STORED_NAME.test(name)) return null;
  return `chat/${channel}/${message}/${name}`;
}

/**
 * Writes one already-validated file and returns the row shape the caller
 * inserts into chat_attachments. The caller owns the database write, so a
 * failed insert can never leave a half-attached file behind (it unlinks).
 */
export async function store(env, channelId, messageId, file, bytes, ext) {
  const stored_name = makeStoredName(ext);
  const objectKey = key(channelId, messageId, stored_name);
  const mime = ALLOWED[ext].mime;
  await env.FILES.put(objectKey, bytes, {
    httpMetadata: { contentType: mime, cacheControl: 'private, no-store, max-age=0' },
  });
  return {
    message_id: messageId,
    original_name: String(file.name || '').slice(0, 200),
    stored_name,
    mime,
    size: bytes.byteLength,
  };
}

/** The object behind one attachment row, or null. Used by the stream route. */
export function get(env, channelId, messageId, storedName) {
  const objectKey = key(channelId, messageId, storedName);
  if (!objectKey) return null;
  return env.FILES.get(objectKey);
}

/** Best-effort byte removal for one attachment row. */
export async function unlinkStored(env, channelId, messageId, storedName) {
  const objectKey = key(channelId, messageId, storedName);
  if (!objectKey) return;
  try {
    await env.FILES.delete(objectKey);
  } catch (err) {
    console.error('[afwc] chat attachment delete failed:', err);
  }
}
