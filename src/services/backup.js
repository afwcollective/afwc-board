'use strict';

/**
 * Full-backup zip for leaders (Phase 7).
 *
 * streamBackup(res) -> Promise<void>
 *   1. Snapshots the live database with better-sqlite3's `db.backup()` into
 *      DATA_DIR/uploads/tmp/ (a consistent copy even while the app is running —
 *      no need to stop the server or lock the WAL).
 *   2. Streams a zip to `res` containing that snapshot as `app.db` plus the
 *      whole `uploads/drafts/` tree (uploads/tmp is never included).
 *   3. Cleans up the snapshot file afterward, including on client abort.
 *
 * The zip's top-level layout is exactly what a fresh /data volume expects:
 *   app.db
 *   uploads/drafts/<id>/...
 * so "restore" is just "unzip into /data". See README.md.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const archiver = require('archiver');

const config = require('../config');
const { db, setSetting } = require('../db');
const { DRAFTS_ROOT } = require('./ingest/paths');

const TMP_DIR = path.join(config.uploadsDir, 'tmp');

/** Best-effort unlink; a missing or already-removed file is not an error. */
function cleanup(file) {
  fs.unlink(file, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('[afwc] backup: could not remove snapshot temp file:', err);
    }
  });
}

/**
 * Streams a full backup zip to `res`. Caller is responsible for setting
 * response headers (filename, content-type) before calling this.
 */
async function streamBackup(res) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const snapshotPath = path.join(TMP_DIR, `backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);

  await db.backup(snapshotPath);

  let cleaned = false;
  const cleanupOnce = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup(snapshotPath);
  };

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('warning', (err) => console.error('[afwc] backup: archiver warning:', err));
    archive.on('error', (err) => {
      cleanupOnce();
      reject(err);
    });

    // Client disconnected mid-stream (closed tab, dropped connection) — stop
    // archiving and clean up rather than leaving a snapshot file behind.
    res.on('close', () => {
      cleanupOnce();
      if (!archive.destroy) return;
      archive.destroy();
    });

    archive.on('end', () => {
      cleanupOnce();
      setSetting('last_backup_at', new Date().toISOString());
      resolve();
    });

    archive.pipe(res);
    archive.file(snapshotPath, { name: 'app.db' });
    if (fs.existsSync(DRAFTS_ROOT)) {
      archive.directory(DRAFTS_ROOT, 'uploads/drafts');
    }
    archive.finalize().catch((err) => {
      cleanupOnce();
      reject(err);
    });
  });
}

module.exports = { streamBackup };
