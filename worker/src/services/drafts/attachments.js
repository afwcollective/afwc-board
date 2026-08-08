/**
 * Draft originals and page images — the VALIDATION half; the bytes live in
 * worker/src/services/filestore.js with everything else this app stores. The
 * four rules are written out in their D1 form at the top of that file. This
 * module's share of them:
 *
 * 1. KEYS ARE BUILT, NEVER ACCEPTED. `key(draftId, relPath)` is the only place
 *    a draft file's address is composed, out of a validated integer id and a
 *    relative path THIS module generated — `original.<ext>` or
 *    `pages/0001.<ext>`. A path read back out of D1 (drafts.original_path,
 *    draft_pages.file_path) is re-tested against SAFE_REL before it is used, so
 *    a hand-edited row cannot name somebody else's bytes. The address is now
 *    the triple ('drafts', draftId, 'pages/0001.png') where it used to be the
 *    object key drafts/<draftId>/pages/0001.png — the same tree
 *    src/services/ingest/paths.js kept on disk under uploads/drafts/, with the
 *    id lifted out of the string. That is also why this file is where
 *    resolveInDraft() went: refusing `..` stopped being a filesystem question
 *    the moment the store stopped being a filesystem, and SAFE_REL — "could we
 *    have generated this name" — is the answer that replaced it.
 *
 * 2. THE STORE IS NEVER PUBLIC. Every byte leaves through
 *    GET /drafts/:id/file.pdf or GET /drafts/:id/img/:n in
 *    worker/src/routes/reader.js, both requireMember, both no-store, both
 *    Content-Disposition: inline. There is no signed URL and no public
 *    hostname; a URL copied out of the reader is dead the moment it leaves the
 *    session. Draft ORIGINALS are never handed back at all — the .pdf route
 *    streams the one kind whose original IS the reading experience, and even
 *    that one is inline-only.
 *
 * 3. VALIDATE BEFORE YOU WRITE. Extension → size → magic bytes, on the bytes in
 *    hand, for EVERY file in the submit, before anything is written. multer's
 *    declarative caps in src/routes/drafts.js become the explicit checks in
 *    limitError(); the complaint sentences are that file's, kept word for word
 *    because members read them.
 *
 *    §6 OF THE PORT PLAN CHANGES WHAT CONVERSION IS, NOT WHAT VALIDATION IS.
 *    The uploader's browser now does the docx/markdown/PDF/image reading, but
 *    the server still sniffs every original it stores and still sanitizes every
 *    page of HTML the client sends back. A client that lies about its file type
 *    is refused here; a client that lies about its page HTML is defanged by
 *    worker/src/util/sanitize.js. Neither was ever the client's call.
 *
 * 4. ROWS OWN THE BYTES. The draft row is written first (its id names the
 *    file's address, exactly as it named the directory before), then the bytes.
 *    If a write fails, the caller flips the draft to 'failed' and unlinks what
 *    landed. A page row whose bytes are missing answers 404 rather than
 *    exploding, which is what the fs.existsSync check did.
 *
 *    A SOFT-DELETED DRAFT STILL KEEPS ITS FILES — soft delete is reversible by
 *    a leader with SQL, exactly as on Express, where nothing was unlinked
 *    either. What is new is the other direction: the RETENTION SWEEP
 *    (worker/src/scheduled.js) deletes files by age, and when a draft's files
 *    go the draft is soft-deleted to match, so the library never lists a draft
 *    whose pages have stopped existing. See that file for the policy.
 *
 * The allowlist and the sniffing are deliberately a separate copy of the idea
 * rather than a generalization of the events and chat modules: this one answers
 * a third question (what may a MEMBER turn into a page-turner), over a third
 * allowlist, with a size cap two orders of magnitude larger. Folding them
 * together would mean one edit could quietly widen the others. Only the storage
 * half was general enough to share.
 */

import * as filestore from '../filestore.js';

/* ---------------- limits & formats — src/routes/drafts.js, verbatim -------- */

export const MAX_DOC_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 60;

/**
 * THE ONE LIMIT THAT SHRANK IN THE PORT: 150 MB → 40 MB for a page-image
 * sequence, and it is a memory limit, not a policy one.
 *
 * multer streamed each part to a tmp file, so an Express upload of sixty 2.5 MB
 * pages never held more than one of them in RAM. A Worker has no disk: Hono's
 * parseBody() materialises the ENTIRE multipart body in the isolate, and the
 * isolate has 128 MB. A 150 MB submit cannot be parsed at all — it would OOM
 * before a single byte reached R2, which is a much worse failure than being
 * told up front that the batch is too big.
 *
 * 40 MB keeps the worst case (body + the one file being copied out for
 * sniffing) comfortably inside the budget, and the per-file 10 MB cap and the
 * 60-page count are unchanged. The number is rendered into views/drafts/new.ejs
 * from route locals, so the upload page tells the truth on whichever stack is
 * serving it. If page sequences ever need to be bigger than this, the fix is a
 * per-image upload loop (one request per page), not a bigger buffer.
 */
export const MAX_IMAGES_TOTAL_BYTES = 40 * 1024 * 1024;

/** Extension -> drafts.kind. */
export const DOC_KINDS = {
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
};

export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Content-Type the image stream route answers with. */
export const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export const KIND_LABEL = {
  docx: 'Word',
  pdf: 'PDF',
  text: 'Text',
  images: 'Graphic novel',
};

/**
 * Only ever what this module composes: `original.<ext>` or `pages/<4 digits>.<ext>`.
 * This is the port of resolveInDraft()'s "does this escape the directory" check
 * — a question that becomes "could we have written this name" once the store is
 * a bucket rather than a filesystem.
 */
const SAFE_REL = /^(original\.[a-z0-9]{1,8}|pages\/[0-9]{4}\.[a-z0-9]{1,8})$/;

/* ---------------- magic-byte sniffing ---------------- */

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
 * file really is what it claims, otherwise a member-readable complaint — the
 * same sentences src/routes/drafts.js sniff() used, because they are shown to a
 * member verbatim.
 */
export function sniff(ext, bytes) {
  const head = bytes.subarray(0, 16);
  if (ext === '.docx') {
    // Every OOXML file is a zip.
    return startsWith(head, [0x50, 0x4b])
      ? null
      : 'is not a real Word file (its contents are not a .docx).';
  }
  if (ext === '.pdf') {
    return startsWith(head, [0x25, 0x50, 0x44, 0x46])
      ? null
      : 'is not a real PDF (its contents do not start with %PDF).';
  }
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return null;
    } catch {
      return 'is not plain UTF-8 text. Re-save it as UTF-8 and try again.';
    }
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return startsWith(head, [0xff, 0xd8, 0xff]) ? null : 'is not a real JPEG.';
  }
  if (ext === '.png') {
    return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? null
      : 'is not a real PNG.';
  }
  if (ext === '.webp') {
    const ok =
      startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
      head.length >= 12 &&
      latin1(head, 8, 12) === 'WEBP';
    return ok ? null : 'is not a real WebP image.';
  }
  return 'is not a file type we can read.';
}

/* ---------------- key construction ---------------- */

/** `original.docx`, from an extension this module has already accepted. */
export function originalRel(ext) {
  const clean = /^\.[a-z0-9]{1,8}$/.test(String(ext || '')) ? ext : '';
  return `original${clean}`;
}

/** `pages/0001.png` — the same zero-padded, filename-sorted order Express used. */
export function pageRel(index, ext) {
  const clean = /^\.[a-z0-9]{1,8}$/.test(String(ext || '')) ? ext : '';
  return `pages/${String(index).padStart(4, '0')}${clean}`;
}

/** The filestore scope every file in this module belongs to. */
const SCOPE = 'drafts';

/**
 * The one place a draft file's address is composed. Returns the filestore
 * triple, or null when either half is not something this module could have
 * produced — the caller then 404s rather than asking the database a question
 * built out of user input.
 */
export function key(draftId, relPath) {
  const rel = String(relPath || '');
  if (!SAFE_REL.test(rel)) return null;
  return filestore.fileKey(SCOPE, draftId, rel);
}

/* ---------------- reads & writes ---------------- */

/**
 * One file, as filestore's `{ status, headers, body }`, or null when nothing
 * is stored at that address — which is what a missing original, a hand-edited
 * row, and a file the retention sweep has aged out all look like from here.
 *
 * `options.range` is the raw Range HEADER, passed straight through: the whole
 * of PORT-CLOUDFLARE.md §4's "Range requests for the PDF reader" now lives in
 * filestore.stream(), which turns a byte range into the closed interval of
 * chunk rows that intersects it. The parsing — the regex, the suffix range, the
 * clamp, both 416 branches — is character for character what this route did
 * against R2 and what Express does against a file descriptor, because pdf.js is
 * the client and its expectations are not negotiable.
 */
export function open(env, draftId, relPath, options) {
  const address = key(draftId, relPath);
  if (!address) return Promise.resolve(null);
  return filestore.stream(env.DB, address, options);
}

/** Writes one already-validated original or page image. */
export async function put(env, draftId, relPath, bytes, contentType) {
  const address = key(draftId, relPath);
  if (!address) throw new Error(`refusing to write unsafe draft file name: ${relPath}`);
  await filestore.put(env.DB, SCOPE, address.refId, address.storedName, contentType, bytes);
  return relPath;
}

/** Best-effort byte removal — rule 4's cleanup path after a failed insert. */
export async function unlink(env, draftId, relPaths) {
  const list = (Array.isArray(relPaths) ? relPaths : [relPaths])
    .map((rel) => key(draftId, rel))
    .filter(Boolean);
  for (const address of list) {
    await filestore.remove(env.DB, SCOPE, address.refId, address.storedName);
  }
}

/* ---------------- submit-level validation ---------------- */

/**
 * multer's `limits` from src/routes/drafts.js, as checks the route runs itself.
 * There is no streaming parser on Workers to enforce them for us, so the caps
 * are asserted on the parts already in hand — which is also why the route reads
 * Content-Length first and refuses an over-large body before it parses.
 */
export function limitError(kind, files) {
  const list = files || [];
  if (kind === 'images') {
    if (list.length > MAX_IMAGES) return `That is more than ${MAX_IMAGES} page images.`;
    const total = list.reduce((sum, f) => sum + f.size, 0);
    if (total > MAX_IMAGES_TOTAL_BYTES) {
      return `Those pages add up to more than ${MAX_IMAGES_TOTAL_BYTES / 1024 / 1024} MB.`;
    }
    return null;
  }
  if (list.some((f) => f.size > MAX_DOC_BYTES)) {
    return `That file is too large. Documents max out at ${MAX_DOC_BYTES / 1024 / 1024} MB and page images at ${MAX_IMAGE_BYTES / 1024 / 1024} MB each.`;
  }
  return null;
}

/** Filename order, the comparator src/routes/drafts.js sorted page images with. */
export const byFilename = (a, b) =>
  String(a.name).localeCompare(String(b.name), 'en', { numeric: true, sensitivity: 'base' });
