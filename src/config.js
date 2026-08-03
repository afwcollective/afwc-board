'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

// SESSION_SECRET is required in production only. In development we fall back to
// an ephemeral secret so `npm run dev` works with zero setup (cookies simply do
// not survive a restart).
let sessionSecret = process.env.SESSION_SECRET || '';
if (!sessionSecret) {
  if (isProd) {
    console.error(
      '[afwc] FATAL: SESSION_SECRET is required when NODE_ENV=production. Set it and restart.'
    );
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const uploadsDir = path.join(dataDir, 'uploads');

for (const dir of [dataDir, uploadsDir, path.join(uploadsDir, 'tmp'), path.join(uploadsDir, 'drafts')]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  env,
  isProd,
  port: Number(process.env.PORT || 3000),
  sessionSecret,
  dataDir,
  uploadsDir,
  dbFile: path.join(dataDir, 'app.db'),
  timezone: 'America/New_York',
  siteName: 'AFWC Board',
  groupName: 'The Agile Fiction Writers Collective',
  venue: 'R. House',
  venueAddress: '301 W 29th St, Baltimore',
  sessionCookie: 'afwc_sid',
  csrfCookie: 'afwc_csrf',
  flashCookie: 'afwc_flash',
  sessionTtlDays: 30,
};
