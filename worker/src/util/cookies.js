/**
 * Cookie helpers with Express's semantics, on Hono's primitives.
 *
 * Two differences from src/auth/sessions.js worth knowing about:
 *
 *  1. maxAge units. Express's res.cookie takes MILLISECONDS; the Set-Cookie
 *     header (and Hono) take SECONDS. Every call site keeps passing
 *     milliseconds, exactly like the Express code it was ported from, and the
 *     conversion happens here once.
 *
 *  2. `secure`. The Express app keyed this off NODE_ENV=production. A Worker
 *     knows something better than an env var: whether THIS request arrived over
 *     TLS. `wrangler dev` on http://localhost gets non-secure cookies (so local
 *     sign-in works), and anything on https gets Secure — including a
 *     workers.dev preview, which NODE_ENV would have got wrong in both
 *     directions.
 */

import { getCookie, setCookie as honoSetCookie, deleteCookie } from 'hono/cookie';

/** True when this request arrived over TLS. */
export function cookieSecure(c) {
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** All cookies on the request, as a plain object. Twin of parseCookies(req). */
export function parseCookies(c) {
  return getCookie(c) || {};
}

export function readCookie(c, name) {
  return getCookie(c, name);
}

/**
 * @param {object} opts { maxAge } in MILLISECONDS, plus any Set-Cookie option.
 */
export function setCookie(c, name, value, opts = {}) {
  const { maxAge, httpOnly, ...rest } = opts;
  const options = {
    httpOnly: httpOnly !== false,
    sameSite: 'Lax',
    secure: cookieSecure(c),
    path: '/',
    ...rest,
  };
  if (maxAge !== undefined && maxAge !== null) {
    options.maxAge = Math.floor(Number(maxAge) / 1000);
  }
  honoSetCookie(c, name, value, options);
}

export function clearCookie(c, name) {
  deleteCookie(c, name, {
    path: '/',
    sameSite: 'Lax',
    secure: cookieSecure(c),
    httpOnly: true,
  });
}
