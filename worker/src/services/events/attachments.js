/**
 * Off-site event attachments on R2 — and THE R2 PATTERN the rest of the port
 * follows (P4's draft originals and page images, P5's backup manifest).
 *
 * Port of src/services/events/attachments.js + src/services/events/paths.js,
 * which between them owned the tmp-file dance, the magic-byte check and the
 * DATA_DIR/uploads/events/<meetingId>/ tree. On Workers there is no disk and no
 * tmp file: the browser's multipart part arrives as a `File`, is read into
 * memory once, checked, and written straight to R2. The two Express modules
 * collapse into this one because half of what paths.js existed for — refusing a
 * name that escapes its directory — is not a thing that can happen to an object
 * key we generate ourselves.
 *
 * ------------------------------------------------------------ THE PATTERN ---
 *
 * 1. KEYS ARE BUILT, NEVER ACCEPTED. `key(meetingId, storedName)` is the only
 *    place a key is composed, from a validated integer id and a stored_name
 *    this module generated. Nothing a leader's file manager called a file ever
 *    reaches R2, and a stored_name read back out of D1 is re-checked against
 *    SAFE_STORED_NAME before it is used, so a tampered row cannot walk the
 *    bucket. Shape:  events/<meetingId>/<stored_name>
 *    (P4: drafts/<draftId>/… — same rule, same helper shape.)
 *
 * 2. THE BUCKET IS NEVER PUBLIC. Every byte leaves through a Worker route that
 *    re-checks authorization first (worker/src/routes/events.js). There is no
 *    signed URL, no bucket binding on a public hostname; a URL is dead the
 *    moment it leaves a session.
 *
 * 3. VALIDATE BEFORE YOU PUT. Extension → size → magic bytes, all on the bytes
 *    in hand, and the caller writes NOTHING to R2 until every file in the
 *    submit has passed. That is what keeps a half-attached event impossible:
 *    the D1 rows and the objects are written in the same, later, step.
 *
 * 4. D1 ROWS OWN THE OBJECTS. An object with no row is unreachable (nothing can
 *    name it) and is cleaned up by the caller on the one path that can create
 *    it — a failed insert after a successful put. A row with no object answers
 *    404 rather than exploding, exactly as the fs.existsSync check did.
 *
 * The sniffing here is deliberately its own small copy of the idea P4 will need
 * for drafts rather than a shared abstraction: this list is four formats long
 * and answers a different question (what may a LEADER attach to an event), and
 * coupling the two would mean one edit could quietly widen the other.
 */

export const MAX_FILES = 5;
export const MAX_BYTES = 10 * 1024 * 1024;

/** Extension -> the Content-Type the stream route will answer with. */
export const ALLOWED = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export const EXT_LIST = 'JPG, PNG, WebP or PDF';

/** Only ever what makeStoredName produces: base36 stamp, hex, our extension. */
const SAFE_STORED_NAME = /^[a-z0-9]+-[0-9a-f]{16}(\.[a-z0-9]{1,8})?$/;

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
 * The extension is a hint; these bytes are the check. Returns null when the
 * file really is what it claims, otherwise a leader-readable complaint.
 */
function sniff(ext, head) {
  if (ext === '.pdf') {
    return startsWith(head, [0x25, 0x50, 0x44, 0x46]) ? null : 'is not a real PDF (it does not start with %PDF).';
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return startsWith(head, [0xff, 0xd8, 0xff]) ? null : 'is not a real JPEG.';
  }
  if (ext === '.png') {
    return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? null : 'is not a real PNG.';
  }
  if (ext === '.webp') {
    const ok =
      startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
      head.length >= 12 &&
      latin1(head, 8, 12) === 'WEBP';
    return ok ? null : 'is not a real WebP image.';
  }
  return `is not a ${EXT_LIST} file.`;
}

/**
 * Checks one uploaded part against extension, size and magic bytes. Takes the
 * already-read bytes because a Worker can only read a body part once and the
 * caller needs them again for the put. Returns { ext, mime } when it passes, or
 * { error } describing what is wrong — same sentences the Express version used,
 * because they are shown to a leader verbatim.
 */
export function validate(file, bytes) {
  const ext = extname(file.name);
  const mime = ALLOWED[ext];
  if (!mime) return { error: `is not a ${EXT_LIST} file.` };
  if (bytes.byteLength > MAX_BYTES) return { error: `is larger than ${MAX_BYTES / 1024 / 1024} MB.` };
  const complaint = sniff(ext, bytes.subarray(0, 16));
  if (complaint) return { error: complaint };
  return { ext, mime };
}

/** A collision-proof stored name: timestamp + random, and only our extension. */
export function makeStoredName(ext) {
  const clean = /^\.[a-z0-9]{1,8}$/.test(String(ext || '')) ? ext : '';
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  return `${Date.now().toString(36)}-${rand}${clean}`;
}

/**
 * The one place an object key is composed. Returns null when either half is not
 * something this module could have produced — the caller then 404s rather than
 * asking R2 a question built from user input.
 */
export function key(meetingId, storedName) {
  const id = Number(meetingId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const name = String(storedName || '');
  if (!SAFE_STORED_NAME.test(name)) return null;
  return `events/${id}/${name}`;
}

/**
 * Writes one validated file to R2 and returns the row shape
 * models.eventFiles.create() wants — the caller owns the database write, so a
 * failed insert can never leave a half-attached file behind (it unlinks).
 */
export async function store(env, meetingId, file, bytes, { ext, mime }) {
  const stored_name = makeStoredName(ext);
  const objectKey = key(meetingId, stored_name);
  await env.FILES.put(objectKey, bytes, {
    httpMetadata: { contentType: mime, cacheControl: 'private, no-store, max-age=0' },
  });
  return {
    meeting_id: meetingId,
    original_name: String(file.name || '').slice(0, 200),
    stored_name,
    mime,
    size: bytes.byteLength,
  };
}

/** The object behind one attachment row, or null. Used by the stream route. */
export function get(env, meetingId, storedName) {
  const objectKey = key(meetingId, storedName);
  if (!objectKey) return null;
  return env.FILES.get(objectKey);
}

/** Best-effort byte removal for one attachment row. */
export async function unlinkStored(env, meetingId, storedName) {
  const objectKey = key(meetingId, storedName);
  if (!objectKey) return;
  try {
    await env.FILES.delete(objectKey);
  } catch (err) {
    console.error('[afwc] event attachment delete failed:', err);
  }
}
