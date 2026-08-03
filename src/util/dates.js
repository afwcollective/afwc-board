'use strict';

const TZ = require('../config').timezone; // America/New_York

/*
 * Storage rule for the whole app: every timestamp column holds an ISO-8601 UTC
 * string. These helpers are the only place that knows about Baltimore time.
 */

function fmt(opts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && value) {
    // Accept both "2026-08-10T22:30:00.000Z" and SQLite's "2026-08-10 22:30:00"
    const s = value.includes('T') || value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Milliseconds that must be subtracted from a wall-clock reading to get UTC. */
function tzOffsetMs(date) {
  const parts = fmt({
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUtc - date.getTime();
}

/**
 * "2026-08-10T18:30" (what <input type="datetime-local"> submits, read as
 * Baltimore wall time) -> ISO UTC string. DST-correct via two-pass fixup.
 */
function localInputToUtcIso(input) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(input || '').trim());
  if (!m) return null;
  const [, Y, M, D, h, mi] = m.map(Number);
  const naive = Date.UTC(Y, M - 1, D, h, mi);
  let ts = naive;
  for (let i = 0; i < 2; i += 1) ts = naive - tzOffsetMs(new Date(ts));
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO UTC -> "2026-08-10T18:30" for pre-filling a datetime-local input. */
function utcIsoToLocalInput(value) {
  const d = toDate(value);
  if (!d) return '';
  const p = fmt({
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, x) => ((acc[x.type] = x.value), acc), {});
  return `${p.year}-${p.month}-${p.day}T${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`;
}

/** "Sunday, August 10, 2026" */
const formatDate = (v) => {
  const d = toDate(v);
  return d ? fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(d) : '';
};

/** "Sun, Aug 10" */
const formatDateShort = (v) => {
  const d = toDate(v);
  return d ? fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(d) : '';
};

/** "6:30 PM" */
const formatTime = (v) => {
  const d = toDate(v);
  return d ? fmt({ hour: 'numeric', minute: '2-digit', hour12: true }).format(d) : '';
};

/** "Sunday, August 10, 2026 · 6:30 PM" */
const formatDateTime = (v) => {
  const d = toDate(v);
  return d ? `${formatDate(d)} · ${formatTime(d)}` : '';
};

/** "SUNDAY" — for the mono eyebrow. */
const weekday = (v) => {
  const d = toDate(v);
  return d ? fmt({ weekday: 'long' }).format(d) : '';
};

/** Value for <time datetime="…">. */
const isoAttr = (v) => {
  const d = toDate(v);
  return d ? d.toISOString() : '';
};

/** "in 3 days" / "tomorrow" / "2 hours ago" — coarse and friendly. */
function relative(v) {
  const d = toDate(v);
  if (!d) return '';
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  const units = [
    ['year', 365 * 24 * 3600e3], ['month', 30 * 24 * 3600e3], ['week', 7 * 24 * 3600e3],
    ['day', 24 * 3600e3], ['hour', 3600e3], ['minute', 60e3],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return 'just now';
}

const nowIso = () => new Date().toISOString();

module.exports = {
  TZ,
  toDate,
  nowIso,
  localInputToUtcIso,
  utcIsoToLocalInput,
  formatDate,
  formatDateShort,
  formatTime,
  formatDateTime,
  weekday,
  isoAttr,
  relative,
};
