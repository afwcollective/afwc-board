/**
 * Port of src/util/resetcode.js. Same word list, same "WORD-1234" shape, same
 * 48-hour single-use life — a member who was told "MAPLE-7391" by a leader on
 * the Express app types the identical thing here.
 *
 * The only change is the source of randomness: node:crypto.randomInt becomes
 * crypto.getRandomValues with rejection sampling, so the distribution stays
 * uniform rather than picking up modulo bias.
 */

const WORDS = [
  'MAPLE', 'RIVER', 'CEDAR', 'AMBER', 'CORAL', 'BIRCH', 'OTTER', 'HAZEL',
  'EMBER', 'QUARTZ', 'WILLOW', 'GRANITE', 'JUNIPER', 'SPARROW', 'HARBOR',
  'MERIDIAN', 'COMPASS', 'LANTERN', 'THISTLE', 'PEBBLE', 'CANYON', 'FALCON',
  'MEADOW', 'CINDER', 'ORCHID', 'BOULDER', 'DRIFTER', 'HORIZON', 'PAPYRUS',
  'SATCHEL',
];

export const RESET_CODE_TTL_MS = 48 * 60 * 60 * 1000;

/** Uniform integer in [0, max) — rejection sampling, no modulo bias. */
function randomInt(max) {
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let n;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return n % max;
}

/** "MAPLE-7391" — crypto-random word + 4 digits (~18 bits of entropy). */
export function generateResetCode() {
  const word = WORDS[randomInt(WORDS.length)];
  const digits = String(randomInt(10000)).padStart(4, '0');
  return `${word}-${digits}`;
}

/** Normalizes user-typed codes (case, stray spaces) before hashing/compare. */
export function normalizeResetCode(code) {
  return String(code || '').trim().toUpperCase();
}
