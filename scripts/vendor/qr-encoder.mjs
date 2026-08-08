/**
 * A small, self-contained QR Code encoder — byte mode, error-correction
 * level M, versions 1-6 (up to ~106 bytes of payload, which is far more
 * than any reasonable URL needs). No dependencies; implements the parts of
 * ISO/IEC 18004 this app actually needs and nothing more:
 *
 *   - GF(256) Reed-Solomon error correction
 *   - byte-mode data encoding with the standard terminator/pad bytes
 *   - block splitting + codeword interleaving
 *   - finder / timing / alignment / dark-module / format-info placement
 *   - all 8 mask patterns, scored by the standard four penalty rules, best one wins
 *
 * Deliberately NOT implemented (not needed for a short URL): alphanumeric/
 * kanji modes, ECI, versions 7+ (which would also need the "version info"
 * blocks — a second BCH-coded field only versions 7-40 carry), and multi-
 * segment messages. If a caller ever needs to encode something longer than
 * version 6 / level M can hold (~106 bytes), encode() throws rather than
 * silently producing a corrupt code.
 *
 * See scripts/make-qr.mjs for the CLI that uses this, and its header for how
 * the output is verified against an external decoder before anything ships.
 */

'use strict';

/* --------------------------------------------------- GF(256) arithmetic -- */
// QR's field: primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D),
// generator element 2. Standard exp/log tables built once at load time.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** The Reed-Solomon generator polynomial of the given degree, as coefficients highest-to-lowest, leading term implicit 1. */
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The `eccLen` Reed-Solomon error-correction codewords for one block of data bytes. */
function rsRemainder(dataBytes, eccLen) {
  const generator = rsGeneratorPoly(eccLen);
  const remainder = new Uint8Array(eccLen);
  for (const b of dataBytes) {
    const factor = b ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[eccLen - 1] = 0;
    for (let j = 0; j < eccLen; j += 1) {
      remainder[j] ^= gfMul(generator[j + 1], factor);
    }
  }
  return remainder;
}

/* -------------------------------------------------------------- tables -- */
// Versions 1-6, error correction level M only — see file header for why.

const CAPACITY = [
  null, // 1-indexed
  { totalCw: 26, dataCw: 16, eccPerBlock: 10, g1: [1, 16], g2: [0, 0] },
  { totalCw: 44, dataCw: 28, eccPerBlock: 16, g1: [1, 28], g2: [0, 0] },
  { totalCw: 70, dataCw: 44, eccPerBlock: 26, g1: [1, 44], g2: [0, 0] },
  { totalCw: 100, dataCw: 64, eccPerBlock: 18, g1: [2, 32], g2: [0, 0] },
  { totalCw: 134, dataCw: 86, eccPerBlock: 24, g1: [2, 43], g2: [0, 0] },
  { totalCw: 172, dataCw: 108, eccPerBlock: 16, g1: [4, 27], g2: [0, 0] },
];

const REMAINDER_BITS = [null, 0, 7, 7, 7, 7, 7];

/** Alignment-pattern center coordinates per version (empty for version 1). */
const ALIGNMENT_COORDS = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

function sizeForVersion(version) {
  return 17 + 4 * version;
}

/* ------------------------------------------------------------ bit buffer -- */

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
}

/** Picks the smallest version (1-6) whose level-M capacity fits `byteLength` bytes of byte-mode data, or throws. */
function versionForByteLength(byteLength) {
  for (let v = 1; v < CAPACITY.length; v += 1) {
    const cap = CAPACITY[v];
    // mode (4 bits) + count indicator (8 bits, true for versions 1-9) + data.
    const headerBits = 4 + 8;
    const capacityBits = cap.dataCw * 8;
    if (headerBits + byteLength * 8 <= capacityBits) return v;
  }
  throw new Error(
    `Payload too long for this encoder (versions 1-6, level M): ${byteLength} bytes. ` +
      'Use a shorter URL, or extend CAPACITY/ALIGNMENT_COORDS for higher versions.'
  );
}

/* ------------------------------------------------------ codeword assembly -- */

function buildDataCodewords(version, bytes) {
  const cap = CAPACITY[version];
  const bb = new BitBuffer();
  bb.push(0b0100, 4); // byte mode
  bb.push(bytes.length, 8); // count indicator, 8 bits (versions 1-9)
  for (const byte of bytes) bb.push(byte, 8);

  const capacityBits = cap.dataCw * 8;
  // Terminator: up to 4 zero bits, only as many as fit.
  bb.push(0, Math.min(4, capacityBits - bb.length));
  // Pad to a byte boundary.
  while (bb.length % 8 !== 0) bb.bits.push(0);
  // Pad codewords 0xEC/0x11 alternating until the data-codeword capacity is full.
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (bb.length < capacityBits) {
    bb.push(padBytes[padIndex % 2], 8);
    padIndex += 1;
  }

  const codewords = new Uint8Array(cap.dataCw);
  for (let i = 0; i < cap.dataCw; i += 1) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bb.bits[i * 8 + j];
    codewords[i] = byte;
  }
  return codewords;
}

/** Splits into blocks, computes RS codewords per block, interleaves data then EC, per ISO/IEC 18004 §8.5. */
function interleaveCodewords(version, dataCodewords) {
  const cap = CAPACITY[version];
  const blocks = [];
  let offset = 0;
  const groups = [cap.g1, cap.g2].filter((g) => g[0] > 0);
  for (const [count, dataLen] of groups) {
    for (let i = 0; i < count; i += 1) {
      const data = dataCodewords.slice(offset, offset + dataLen);
      offset += dataLen;
      const ecc = rsRemainder(Array.from(data), cap.eccPerBlock);
      blocks.push({ data, ecc });
    }
  }

  const maxDataLen = Math.max(...blocks.map((b) => b.data.length));
  const out = [];
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) out.push(block.data[i]);
    }
  }
  for (let i = 0; i < cap.eccPerBlock; i += 1) {
    for (const block of blocks) out.push(block.ecc[i]);
  }
  return out;
}

/* ------------------------------------------------------------- the matrix -- */

class QrMatrix {
  constructor(version) {
    this.version = version;
    this.size = sizeForVersion(version);
    this.modules = Array.from({ length: this.size }, () => new Int8Array(this.size).fill(-1));
    this.isFunction = Array.from({ length: this.size }, () => new Uint8Array(this.size));
  }

  set(r, c, value, isFunc) {
    if (r < 0 || r >= this.size || c < 0 || c >= this.size) return;
    this.modules[r][c] = value ? 1 : 0;
    if (isFunc) this.isFunction[r][c] = 1;
  }

  drawFinder(top, left) {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= this.size || c < 0 || c >= this.size) continue;
        const onRing = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        const inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        let dark = false;
        if (inner) {
          const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          dark = border || core;
        }
        this.set(r, c, onRing ? 0 : dark, true);
      }
    }
  }

  drawFinders() {
    this.drawFinder(0, 0);
    this.drawFinder(0, this.size - 7);
    this.drawFinder(this.size - 7, 0);
  }

  drawTiming() {
    for (let i = 8; i < this.size - 8; i += 1) {
      const dark = i % 2 === 0;
      if (this.modules[6][i] === -1) this.set(6, i, dark, true);
      if (this.modules[i][6] === -1) this.set(i, 6, dark, true);
    }
  }

  drawAlignments() {
    const coords = ALIGNMENT_COORDS[this.version];
    if (!coords.length) return;
    const first = coords[0];
    const last = coords[coords.length - 1];
    for (const r of coords) {
      for (const c of coords) {
        // Skip the three positions that overlap a finder pattern.
        if ((r === first && c === first) || (r === first && c === last) || (r === last && c === first)) {
          continue;
        }
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            const ring = Math.max(Math.abs(dr), Math.abs(dc));
            this.set(r + dr, c + dc, ring !== 1, true);
          }
        }
      }
    }
  }

  drawDarkModule() {
    this.set(4 * this.version + 9, 8, true, true);
  }

  /** Reserves the format-info strips (both copies) with placeholder 0s, so data placement skips them. */
  reserveFormatAreas() {
    for (let i = 0; i <= 8; i += 1) {
      if (this.modules[8][i] === -1) this.set(8, i, false, true);
      if (this.modules[i][8] === -1) this.set(i, 8, false, true);
    }
    for (let i = 0; i < 8; i += 1) {
      this.set(8, this.size - 1 - i, false, true);
      this.set(this.size - 1 - i, 8, false, true);
    }
  }

  /** Zigzags data bits into every non-function module, right to left in column pairs, per §7.7.3. */
  placeData(codewordBytes) {
    const bits = [];
    for (const byte of codewordBytes) {
      for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
    }
    let bitIndex = 0;
    let upward = true;
    for (let colPair = this.size - 1; colPair >= 1; colPair -= 2) {
      const col = colPair === 6 ? 5 : colPair; // column 6 is the timing column; skip to 5
      for (let step = 0; step < this.size; step += 1) {
        const row = upward ? this.size - 1 - step : step;
        for (const c of [col, col - 1]) {
          if (this.isFunction[row][c]) continue;
          const bit = bitIndex < bits.length ? bits[bitIndex] : 0;
          bitIndex += 1;
          this.set(row, c, bit === 1, false);
        }
      }
      upward = !upward;
    }
  }

  /** Applies mask pattern `m` to every non-function module of a COPY of the matrix; returns the copy. */
  masked(m) {
    const fn = MASK_FUNCTIONS[m];
    const copy = this.modules.map((row) => Int8Array.from(row));
    for (let r = 0; r < this.size; r += 1) {
      for (let c = 0; c < this.size; c += 1) {
        if (this.isFunction[r][c]) continue;
        if (fn(r, c)) copy[r][c] ^= 1;
      }
    }
    return copy;
  }

  writeFormatInfo(eccLevelBits, maskId) {
    const data = (eccLevelBits << 3) | maskId; // 5 bits
    let value = data << 10;
    const generator = 0x537; // x^10+x^8+x^5+x^4+x^2+x+1
    let shifted = value;
    for (let i = 14; i >= 10; i -= 1) {
      if ((shifted >>> i) & 1) shifted ^= generator << (i - 10);
    }
    const bits15 = ((data << 10) | shifted) ^ 0x5412;

    const bit = (i) => (bits15 >>> i) & 1;

    // Copy 1: top-left.
    const copy1 = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    // Copy 2: top-right + bottom-left.
    const copy2 = [
      [this.size - 1, 8], [this.size - 2, 8], [this.size - 3, 8], [this.size - 4, 8],
      [this.size - 5, 8], [this.size - 6, 8], [this.size - 7, 8],
      [8, this.size - 8], [8, this.size - 7], [8, this.size - 6], [8, this.size - 5],
      [8, this.size - 4], [8, this.size - 3], [8, this.size - 2], [8, this.size - 1],
    ];
    // The coordinate lists above are written MSB-first (copy1[0]/copy2[0]
    // hold bit 14, the highest bit of the 15-bit format value), matching
    // ISO/IEC 18004 Figure 25 — NOT the LSB-first order `bit()`'s index
    // suggests, so index from the top down.
    for (let i = 0; i < 15; i += 1) {
      const value15 = bit(14 - i);
      const [r1, c1] = copy1[i];
      this.set(r1, c1, value15 === 1, true);
      const [r2, c2] = copy2[i];
      this.set(r2, c2, value15 === 1, true);
    }
  }
}

const MASK_FUNCTIONS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/* --------------------------------------------------------- mask scoring -- */

function scorePenalty(grid) {
  const size = grid.length;
  let penalty = 0;

  // Rule 1: 5+ same-color modules in a row/column.
  for (let r = 0; r < size; r += 1) {
    penalty += runPenalty((c) => grid[r][c], size);
  }
  for (let c = 0; c < size; c += 1) {
    penalty += runPenalty((r) => grid[r][c], size);
  }

  // Rule 2: 2x2 blocks of one color.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) penalty += 3;
    }
  }

  // Rule 3: 1:1:3:1:1 finder-like patterns with 4 light modules of padding.
  const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r += 1) {
    penalty += 40 * countPatternMatches((c) => grid[r][c], size, patternA);
    penalty += 40 * countPatternMatches((c) => grid[r][c], size, patternB);
  }
  for (let c = 0; c < size; c += 1) {
    penalty += 40 * countPatternMatches((r) => grid[r][c], size, patternA);
    penalty += 40 * countPatternMatches((r) => grid[r][c], size, patternB);
  }

  // Rule 4: overall dark-module balance vs 50%.
  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) dark += grid[r][c];
  const percent = (dark * 100) / (size * size);
  penalty += 10 * Math.floor(Math.abs(percent - 50) / 5);

  return penalty;
}

function runPenalty(get, size) {
  let penalty = 0;
  let runColor = -1;
  let runLen = 0;
  for (let i = 0; i < size; i += 1) {
    const v = get(i);
    if (v === runColor) {
      runLen += 1;
    } else {
      if (runLen >= 5) penalty += 3 + (runLen - 5);
      runColor = v;
      runLen = 1;
    }
  }
  if (runLen >= 5) penalty += 3 + (runLen - 5);
  return penalty;
}

function countPatternMatches(get, size, pattern) {
  let count = 0;
  for (let start = 0; start + pattern.length <= size; start += 1) {
    let match = true;
    for (let i = 0; i < pattern.length; i += 1) {
      if (get(start + i) !== pattern[i]) {
        match = false;
        break;
      }
    }
    if (match) count += 1;
  }
  return count;
}

/* -------------------------------------------------------------- the API -- */

const ECC_LEVEL_M_BITS = 0b00; // format-info indicator for level M

/**
 * Encodes `text` (ASCII/Latin-1 — a URL is always fine) as a QR code.
 * Returns { size, modules } where modules[r][c] is 0 or 1 (1 = dark).
 */
export function encodeQr(text) {
  const bytes = Array.from(text, (ch) => {
    const code = ch.codePointAt(0);
    if (code > 0xff) {
      throw new Error(`encodeQr: non-Latin-1 character in payload (U+${code.toString(16)}); URLs should be ASCII.`);
    }
    return code;
  });

  const version = versionForByteLength(bytes.length);
  const dataCodewords = buildDataCodewords(version, bytes);
  const finalCodewords = interleaveCodewords(version, dataCodewords);

  const matrix = new QrMatrix(version);
  matrix.drawFinders();
  matrix.drawTiming();
  matrix.drawAlignments();
  matrix.drawDarkModule();
  matrix.reserveFormatAreas();
  matrix.placeData(finalCodewords);
  // Remainder bits (REMAINDER_BITS[version], versions 2-6 only): placeData's
  // zigzag fills every non-function module regardless of whether codeword
  // bits remain, defaulting to 0 past the end — exactly the padding those
  // trailing remainder bits are defined to be. Nothing further to do here.

  let best = null;
  for (let m = 0; m < 8; m += 1) {
    const grid = matrix.masked(m);
    const penalty = scorePenalty(grid);
    if (!best || penalty < best.penalty) best = { m, grid, penalty };
  }

  matrix.writeFormatInfo(ECC_LEVEL_M_BITS, best.m);
  // Re-apply the winning mask on top of the now-final format info (format
  // modules are function modules, so masked() already left them untouched).
  const finalGrid = matrix.masked(best.m);

  return { size: matrix.size, modules: finalGrid };
}
