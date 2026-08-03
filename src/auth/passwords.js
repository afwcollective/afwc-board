'use strict';

const crypto = require('node:crypto');

// scrypt parameters — N=16384 keeps a hash under ~50ms on a small VPS.
const KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Returns "scrypt$<saltB64>$<hashB64>". */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time verify. Never throws on malformed stored values. */
function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], 'base64');
    expected = Buffer.from(parts[2], 'base64');
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(plain), salt, KEYLEN, SCRYPT_OPTS);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

/** Same format, used for the shared group passcode and one-time reset codes. */
const hashSecret = hashPassword;
const verifySecret = verifyPassword;

module.exports = { hashPassword, verifyPassword, hashSecret, verifySecret };
