'use strict';

const crypto = require('node:crypto');

/**
 * Leader-issued password reset codes — no email provider in this app, so a
 * leader reads a short code off their own screen and texts it to the member
 * ("MAPLE-7391"). Deliberately memorable and short-lived (48h, single-use).
 */

const WORDS = [
  'MAPLE', 'RIVER', 'CEDAR', 'AMBER', 'CORAL', 'BIRCH', 'OTTER', 'HAZEL',
  'EMBER', 'QUARTZ', 'WILLOW', 'GRANITE', 'JUNIPER', 'SPARROW', 'HARBOR',
  'MERIDIAN', 'COMPASS', 'LANTERN', 'THISTLE', 'PEBBLE', 'CANYON', 'FALCON',
  'MEADOW', 'CINDER', 'ORCHID', 'BOULDER', 'DRIFTER', 'HORIZON', 'PAPYRUS',
  'SATCHEL',
];

const RESET_CODE_TTL_MS = 48 * 60 * 60 * 1000;

/** "MAPLE-7391" — crypto-random word + 4 digits (~18 bits of entropy). */
function generateResetCode() {
  const word = WORDS[crypto.randomInt(WORDS.length)];
  const digits = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  return `${word}-${digits}`;
}

/** Normalizes user-typed codes (case, stray spaces) before hashing/compare. */
function normalizeResetCode(code) {
  return String(code || '').trim().toUpperCase();
}

module.exports = { generateResetCode, normalizeResetCode, RESET_CODE_TTL_MS };
