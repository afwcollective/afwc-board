/**
 * Off-site event attachments — the VALIDATION half of what used to be this
 * app's first application of THE R2 PATTERN, now sitting on top of
 * worker/src/services/filestore.js.
 *
 * Port of src/services/events/attachments.js + src/services/events/paths.js,
 * which between them owned the tmp-file dance, the magic-byte check and the
 * DATA_DIR/uploads/events/<meetingId>/ tree. On Workers there is no disk and no
 * tmp file: the browser's multipart part arrives as a `File`, is read into
 * memory once, checked, and handed to the store. The two Express modules
 * collapse into this one because half of what paths.js existed for — refusing a
 * name that escapes its directory — is not a thing that can happen to an
 * address we generate ourselves.
 *
 * ---------------------------------------------------- WHAT MOVED, AND WHY ---
 *
 * Everything about WHICH FILES ARE ALLOWED is still here: the four-format
 * allowlist, the 5-file/10-MB caps, the magic-byte sniffing, the stored-name
 * generator, and the leader-readable complaint sentences. Everything about
 * WHERE THE BYTES GO is now filestore.js — one module for all three kinds of
 * attachment, because after the move to D1 they really are one mechanism
 * (chunked rows) rather than three shapes of object key.
 *
 * The four rules are unchanged and are written out, in their D1 form, at the
 * top of filestore.js. This module's share of them:
 *
 * 1. KEYS ARE BUILT, NEVER ACCEPTED. `key(meetingId, storedName)` is still the
 *    only place an event file's address is composed, from a validated integer
 *    id and a stored_name this module generated. Nothing a leader's file
 *    manager called a file is ever used, and a stored_name read back out of D1
 *    is re-checked against SAFE_STORED_NAME before it is used. The address is
 *    now the triple ('events', meetingId, stored_name) rather than the object
 *    key events/<meetingId>/<stored_name> — same rule, one fewer place a path
 *    separator can mean something.
 *
 * 3. VALIDATE BEFORE YOU WRITE. Extension → size → magic bytes, all on the
 *    bytes in hand, and the caller writes NOTHING until every file in the
 *    submit has passed. That is what keeps a half-attached event impossible:
 *    the event_attachments rows and the bytes are written in the same, later,
 *    step.
 *
 * The sniffing here is deliberately its own small copy of the idea the drafts
 * and chat modules also need rather than a shared abstraction: this list is
 * four formats long and answers a different question (what may a LEADER attach
 * to an event), and coupling them would mean one edit could quietly widen the
 * others. That is exactly why filestore.js took the storage half and left the
 * three allowlists alone.
 */

import * as filestore from '../filestore.js';

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

/** The filestore scope every file in this module belongs to. */
const SCOPE = 'events';

/**
 * The one place an event file's address is composed. Returns the filestore
 * triple, or null when either half is not something this module could have
 * produced — the caller then 404s rather than asking the database a question
 * built from user input.
 */
export function key(meetingId, storedName) {
  const name = String(storedName || '');
  if (!SAFE_STORED_NAME.test(name)) return null;
  return filestore.fileKey(SCOPE, meetingId, name);
}

/**
 * Writes one validated file and returns the row shape
 * models.eventFiles.create() wants — the caller owns the database write, so a
 * failed insert can never leave a half-attached file behind (it unlinks).
 */
export async function store(env, meetingId, file, bytes, { ext, mime }) {
  const stored_name = makeStoredName(ext);
  const address = key(meetingId, stored_name);
  if (!address) throw new Error(`refusing to store an unsafe event file name: ${stored_name}`);
  await filestore.put(env.DB, SCOPE, address.refId, address.storedName, mime, bytes);
  return {
    meeting_id: meetingId,
    original_name: String(file.name || '').slice(0, 200),
    stored_name,
    mime,
    size: bytes.byteLength,
  };
}

/**
 * The bytes behind one attachment row, as filestore's
 * `{ status, headers, body }`, or null when the row names nothing — which is
 * also what a file aged out by the retention sweep looks like from here. Used
 * by the stream route in worker/src/routes/events.js.
 */
export function open(env, meetingId, storedName, options) {
  const address = key(meetingId, storedName);
  if (!address) return Promise.resolve(null);
  return filestore.stream(env.DB, address, options);
}

/** Best-effort byte removal for one attachment row. */
export async function unlinkStored(env, meetingId, storedName) {
  const address = key(meetingId, storedName);
  if (!address) return;
  await filestore.remove(env.DB, SCOPE, address.refId, address.storedName);
}
