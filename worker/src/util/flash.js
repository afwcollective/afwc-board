/**
 * Port of src/util/flash.js — same cookie, same name, same base64url JSON
 * payload, same 60-second life, same 4-message cap.
 *
 *   flash(c, 'ok', 'Meeting saved.');   // then return c.redirect(...)
 *
 * The layout renders locals.flash via views/partials/flash.ejs, which is
 * compiled straight from the shared views/ directory and never knew where the
 * messages came from.
 *
 * Base64 note: Node's Buffer.from(x, 'base64url') has no direct equivalent in
 * workerd, so the encode/decode pair below goes through atob/btoa with the
 * URL-safe alphabet swapped in and out by hand. The wire format is byte-for-byte
 * what the Express app wrote, so a cookie set by one is readable by the other.
 */

import config from '../config.js';
import { parseCookies, setCookie, clearCookie } from './cookies.js';

const MAX = 4;

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const b64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Queue a flash message on the response. `type` is one of ok | error | info and
 * maps to the .flash--* modifier classes in site.css.
 */
export function flash(c, type, message) {
  const pending = c.get('pendingFlash') || [];
  pending.push({ type: String(type || 'info'), message: String(message) });
  const capped = pending.slice(-MAX);
  c.set('pendingFlash', capped);
  setCookie(c, config.flashCookie, toBase64Url(JSON.stringify(capped)), { maxAge: 60 * 1000 });
}

/** Middleware: lifts any pending flash off the cookie into locals.flash. */
export async function flashMiddleware(c, next) {
  const raw = parseCookies(c)[config.flashCookie];
  let messages = [];
  if (raw) {
    try {
      const parsed = JSON.parse(fromBase64Url(raw));
      if (Array.isArray(parsed)) messages = parsed.filter((m) => m && m.message).slice(0, MAX);
    } catch {
      /* malformed cookie — drop it */
    }
    clearCookie(c, config.flashCookie);
  }
  c.set('flash', messages);
  await next();
}
