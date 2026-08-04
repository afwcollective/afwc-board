'use strict';

/**
 * Off-site event attachments: the rules, the magic-byte check, and the moves
 * between multer's tmp directory and DATA_DIR/uploads/events/<meetingId>/.
 *
 * Kept out of src/routes/admin.js so the route reads as policy, not plumbing.
 * The sniffing here is deliberately its own small copy of the idea in
 * src/routes/drafts.js rather than a shared abstraction: this list is four
 * formats long and answers a different question (what may a LEADER attach to an
 * event), and coupling the two would mean one edit could quietly widen the
 * other.
 */

const fs = require('node:fs');
const path = require('node:path');

const { eventDir, resolveInEvent, makeStoredName } = require('./paths');

const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;

/** Extension -> the Content-Type the stream route will answer with. */
const ALLOWED = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

const EXT_LIST = 'JPG, PNG, WebP or PDF';

const startsWith = (buf, bytes) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

function readHead(fullPath, n = 16) {
  const fd = fs.openSync(fullPath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
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
      head.subarray(8, 12).toString('latin1') === 'WEBP';
    return ok ? null : 'is not a real WebP image.';
  }
  return `is not a ${EXT_LIST} file.`;
}

/**
 * Checks one uploaded temp file against extension, size and magic bytes.
 * Returns { ext, mime } when it passes, or { error } describing what is wrong.
 */
function validate(file) {
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const mime = ALLOWED[ext];
  if (!mime) return { error: `is not a ${EXT_LIST} file.` };
  if (file.size > MAX_BYTES) return { error: `is larger than ${MAX_BYTES / 1024 / 1024} MB.` };
  const complaint = sniff(ext, readHead(file.path));
  if (complaint) return { error: complaint };
  return { ext, mime };
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/**
 * Moves a validated temp file into the event's directory. Returns the row shape
 * models.eventFiles.create() wants — the caller owns the database write, so a
 * failed insert can never leave a half-attached file behind.
 */
function store(meetingId, file, { ext, mime }) {
  const dir = eventDir(meetingId);
  fs.mkdirSync(dir, { recursive: true });
  const stored_name = makeStoredName(ext);
  moveFile(file.path, path.join(dir, stored_name));
  return {
    meeting_id: meetingId,
    original_name: String(file.originalname || '').slice(0, 200),
    stored_name,
    mime,
    size: file.size,
  };
}

/** Best-effort byte removal for one attachment row. */
function unlinkStored(meetingId, storedName) {
  const full = resolveInEvent(meetingId, storedName);
  if (!full) return;
  try {
    fs.unlinkSync(full);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[afwc] event attachment unlink failed:', err);
  }
}

/** Best-effort cleanup of temp files a rejected upload left behind. */
function discard(files) {
  for (const file of files || []) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* already gone */
    }
  }
}

module.exports = { MAX_FILES, MAX_BYTES, ALLOWED, EXT_LIST, validate, store, unlinkStored, discard };
