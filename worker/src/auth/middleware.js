/**
 * Port of src/auth/middleware.js — the session/CSRF/guard layer.
 *
 * The Express file published its results on res.locals; there is no res here, so
 * everything lands on the Hono context via c.set(...) and is collected into the
 * template locals by worker/src/render.js. The NAMES are unchanged
 * (currentUser, isLeader, isArchitect, isHost, csrfToken, currentPath), because
 * views/ is shared with the Express app and every template reads those names.
 */

import config from '../config.js';
import { one, run } from '../db.js';
import * as sessions from './sessions.js';
import * as roles from './roles.js';
import { flash } from '../util/flash.js';
import { parseCookies } from '../util/cookies.js';
import { getBody, isMultipart, field } from '../util/body.js';
import { hosts } from '../models.js';

/** An error with an HTTP status — what the Express code did with err.status. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * A time-boxed leader whose term has run out, demoted the moment they touch the
 * app. Cheap by design: one guarded UPDATE, and only when the loaded session row
 * actually carries an expiry that has passed.
 *
 * The demotion never touches sessions — losing leadership is not being booted.
 * They stay signed in and simply stop seeing /admin from this request on.
 *
 * (The Express app paired this with a boot-time sweep for everyone who is NOT
 * making a request. A Worker has no boot; that half becomes the P5 Cron Trigger
 * calling sweepExpiredRoles from worker/src/db.js.)
 */
async function expireRoleIfDue(db, session) {
  if (!session || session.role !== roles.LEADER) return session;
  const expires = session.role_expires_at;
  if (!expires || expires > new Date().toISOString()) return session;
  await run(
    db,
    `UPDATE users SET role = 'member', role_expires_at = NULL
      WHERE id = ? AND role = 'leader' AND role_expires_at IS NOT NULL AND role_expires_at <= ?`,
    session.uid,
    new Date().toISOString()
  );
  session.role = roles.MEMBER;
  session.role_expires_at = null;
  return session;
}

/**
 * loadUser — resolves the session cookie into the request's user and publishes
 * the view locals every template relies on:
 *   currentUser, isLeader, isArchitect, isHost, csrfToken, currentPath
 * Booted users (is_active = 0) are treated as logged out and their cookie is
 * dropped, so deactivation takes effect on the very next request.
 *
 * isHost — "this member is running a session in the next 30 days." One query
 * (models.hosts.hasUpcoming), run only when somebody is signed in, and false for
 * everyone else. It is published as a FACT, not as a gate: nothing in this file
 * or in the routes it fronts uses it to allow or refuse anything. Host
 * authorization is always per-occurrence and checked server-side against the
 * actual assignment (P2's /host router) — a boolean that says "hosting
 * something, somewhere, this month" is not permission to edit any particular
 * meeting. Views may use it to offer a link; the sprint timer's own gate is
 * wired to it separately.
 */
export async function loadUser(c, next) {
  const db = c.env.DB;
  let session = null;
  try {
    session = await sessions.readSession(c, db);
  } catch {
    session = null;
  }

  if (session && !session.is_active) {
    await sessions.destroySession(c, db);
    session = null;
  }

  session = await expireRoleIfDue(db, session);

  const user = session
    ? {
        id: session.uid,
        username: session.username,
        display_name: session.display_name,
        role: session.role,
        role_expires_at: session.role_expires_at,
        is_active: session.is_active,
      }
    : null;

  c.set('session', session);
  c.set('currentUser', user);
  c.set('isLeader', roles.isLeaderUser(user));
  c.set('isArchitect', roles.isArchitectUser(user));
  c.set('isHost', user ? await hosts.hasUpcoming(db, user.id) : false);
  c.set('csrfToken', sessions.ensureCsrfToken(c, session));
  c.set('currentPath', new URL(c.req.url).pathname);

  await next();
}

/* ---------------- guards ---------------- */

function loginRedirect(c, message = 'Please sign in to see that.') {
  const url = new URL(c.req.url);
  const next = encodeURIComponent(`${url.pathname}${url.search}` || '/');
  flash(c, 'error', message);
  return c.redirect(`/login?next=${next}`, 302);
}

export async function requireMember(c, next) {
  const user = c.get('currentUser');
  if (user && user.is_active) return next();
  return loginRedirect(c);
}

/** Leaders and the architect — the whole /admin console. */
export async function requireLeader(c, next) {
  const user = c.get('currentUser');
  if (user && user.is_active && roles.isLeaderUser(user)) return next();
  if (!user) return loginRedirect(c);
  throw new HttpError(403, 'Leaders only.');
}

/**
 * The architect alone: anything that moves another account downward, and the
 * transfer of the chair itself. Server-side twin of the buttons the members
 * view hides — never trust the view.
 */
export async function requireArchitect(c, next) {
  const user = c.get('currentUser');
  if (user && user.is_active && roles.isArchitectUser(user)) return next();
  if (!user) return loginRedirect(c);
  throw new HttpError(403, 'Only the architect can manage leaders.');
}

export async function requireGuest(c, next) {
  if (c.get('currentUser')) return c.redirect('/', 302);
  return next();
}

/** Constant-time string compare. Twin of safeEqual in src/auth/middleware.js. */
export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(String(a == null ? '' : a));
  const bb = enc.encode(String(b == null ? '' : b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i += 1) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/**
 * checkCsrf — applied to every state-changing request. Two independent gates,
 * in the same order and with the same failure message as the Express version:
 *   1. the per-session (or pre-auth cookie) token echoed in a hidden _csrf field
 *      OR in an X-CSRF-Token header
 *   2. Origin/Referer host must match the request host when the header is present
 *
 * The body is read through worker/src/util/body.js, which parses urlencoded
 * bodies once and never touches a multipart stream — so a multipart upload is
 * still verified by its header alone and still reaches its route with the body
 * unconsumed. See that file for why that matters.
 */
export async function checkCsrf(c, next) {
  const method = c.req.method;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();

  const host = c.req.header('host');
  const source = c.req.header('origin') || c.req.header('referer');
  if (source) {
    let ok = false;
    try {
      ok = new URL(source).host === host;
    } catch {
      ok = false;
    }
    if (!ok) throw csrfFail('cross-origin request blocked');
  }

  let supplied = c.req.header('x-csrf-token');
  if (!isMultipart(c)) {
    const body = await getBody(c);
    supplied = field(body, '_csrf') || field(body, 'csrf') || supplied;
  }

  const session = c.get('session');
  const expected = session
    ? session.csrf_token
    : c.get('freshCsrfCookie') || parseCookies(c)[config.csrfCookie];

  if (!expected || !safeEqual(supplied, expected)) {
    throw csrfFail('form security token missing or stale');
  }
  return next();
}

function csrfFail(why) {
  return new HttpError(
    403,
    `Your session could not be verified (${why}). Please reload the page and try again.`
  );
}

/** True while the users table is empty — enables /setup and the first-run card. */
export async function noUsersYet(db) {
  const row = await one(db, 'SELECT COUNT(*) AS n FROM users');
  return !row || row.n === 0;
}
