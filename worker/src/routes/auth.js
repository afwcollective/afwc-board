/**
 * Port of src/routes/auth.js — /setup, /register, /login, /reset, /logout.
 *
 * Every rule the Express version enforced is enforced here, in the same order
 * and with the same wording, because the wording is what a member sees:
 *   * /setup is available ONLY while the users table is empty and hard-404s
 *     afterwards, so it can never mint a second architect;
 *   * /register needs the shared group passcode;
 *   * /login and /reset are rate limited (now D1-backed) and answer wrong
 *     username, wrong password and wrong reset code with the same generic
 *     message, so neither form can be used to probe which usernames exist;
 *   * a reset code is single-use and expires after 48 hours;
 *   * every successful credential change starts a fresh session.
 */

import { Hono } from 'hono';
import { getSetting, setSetting } from '../db.js';
import { users } from '../models.js';
import { hashPassword, verifyPassword, hashSecret, verifySecret } from '../auth/passwords.js';
import * as sessions from '../auth/sessions.js';
import { noUsersYet, requireGuest, safeEqual } from '../auth/middleware.js';
import { flash } from '../util/flash.js';
import * as ratelimit from '../util/ratelimit.js';
import { normalizeResetCode } from '../util/resetcode.js';
import { getBody, field } from '../util/body.js';
import { render } from '../render.js';
import { notFound } from './errors.js';

const router = new Hono();

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;
const MIN_PASSWORD = 8;

/** Shared field validation for /setup and /register. Returns array of errors. */
async function validateAccount(db, { username, display_name, password, password2 }) {
  const errors = [];
  if (!USERNAME_RE.test(String(username || '').trim())) {
    errors.push('Username must be 3–32 characters: letters, numbers, dot, dash or underscore.');
  } else if (await users.byUsername(db, username)) {
    errors.push('That username is already taken.');
  }
  if (!String(display_name || '').trim()) errors.push('Please give a display name.');
  if (String(display_name || '').trim().length > 60) errors.push('Display name is too long.');
  if (String(password || '').length < MIN_PASSWORD) {
    errors.push(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (password2 !== undefined && password !== password2) errors.push('The two passwords do not match.');
  return errors;
}

function safeNext(value) {
  const v = String(value || '');
  return /^\/(?!\/)[^\s]*$/.test(v) ? v : '/';
}

/* ------------------------------------------------------------------ setup */
// Available only while the users table is empty. Hard 404 afterwards, so the
// route cannot be used to mint a second architect. The first account is the
// board's architect — the one tier that can demote or boot a leader, and the
// one account nobody else can touch (see worker/src/auth/roles.js).

router.get('/setup', async (c) => {
  if (!(await noUsersYet(c.env.DB))) return notFound(c);
  return render(c, 'auth/setup', {
    title: 'First run — set up your board',
    bodyClass: 'page-auth',
    errors: [],
    values: {},
  });
});

router.post('/setup', async (c) => {
  const db = c.env.DB;
  if (!(await noUsersYet(db))) return notFound(c);

  const body = await getBody(c);
  const username = field(body, 'username');
  const display_name = field(body, 'display_name');
  const email = field(body, 'email');
  const password = field(body, 'password');
  const password2 = field(body, 'password2');
  const passcode = field(body, 'passcode');
  const passcode2 = field(body, 'passcode2');

  const errors = await validateAccount(db, { username, display_name, password, password2 });
  if (String(passcode || '').trim().length < 4) {
    errors.push('The group passcode must be at least 4 characters.');
  } else if (passcode !== passcode2) {
    errors.push('The two group passcodes do not match.');
  }

  if (errors.length) {
    return render(
      c,
      'auth/setup',
      {
        title: 'First run — set up your board',
        bodyClass: 'page-auth',
        errors,
        values: { username, display_name, email },
      },
      400
    );
  }

  const info = await users.create(db, {
    username,
    display_name,
    email,
    password_hash: await hashPassword(password),
    role: 'architect',
  });
  await setSetting(db, 'group_passcode_hash', await hashSecret(String(passcode).trim()));
  await setSetting(db, 'site_name', 'AFWC Board');

  const user = await users.byId(db, info.last_row_id);
  await sessions.createSession(c, db, user);
  await users.touchLogin(db, user.id);
  flash(c, 'ok', `Welcome, ${user.display_name}. You are the architect of this board — set the next meeting.`);
  return c.redirect('/admin', 302);
});

/* --------------------------------------------------------------- register */

router.get('/register', requireGuest, async (c) => {
  return render(c, 'auth/register', {
    title: 'Join the board',
    bodyClass: 'page-auth',
    errors: [],
    values: {},
    setupNeeded: await noUsersYet(c.env.DB),
  });
});

router.post('/register', requireGuest, async (c) => {
  const db = c.env.DB;
  const body = await getBody(c);
  const username = field(body, 'username');
  const display_name = field(body, 'display_name');
  const email = field(body, 'email');
  const password = field(body, 'password');
  const password2 = field(body, 'password2');
  const passcode = field(body, 'passcode');

  const errors = [];
  const stored = await getSetting(db, 'group_passcode_hash');
  if (!stored) {
    errors.push('Registration is not open yet — a leader still has to set the group passcode.');
  } else if (!(await verifySecret(String(passcode || '').trim(), stored))) {
    errors.push('That group passcode is not right. Ask a leader for the current one.');
  }
  errors.push(...(await validateAccount(db, { username, display_name, password, password2 })));

  if (errors.length) {
    return render(
      c,
      'auth/register',
      {
        title: 'Join the board',
        bodyClass: 'page-auth',
        errors,
        values: { username, display_name, email },
        setupNeeded: await noUsersYet(db),
      },
      400
    );
  }

  const info = await users.create(db, {
    username,
    display_name,
    email,
    password_hash: await hashPassword(password),
    role: 'member',
  });
  const user = await users.byId(db, info.last_row_id);
  await sessions.createSession(c, db, user);
  await users.touchLogin(db, user.id);
  flash(c, 'ok', `You're in, ${user.display_name}.`);
  return c.redirect('/', 302);
});

/* ------------------------------------------------------------------ login */

router.get('/login', async (c) => {
  if (c.get('currentUser')) return c.redirect(safeNext(c.req.query('next')), 302);
  return render(c, 'auth/login', {
    title: 'Sign in',
    bodyClass: 'page-auth',
    errors: [],
    values: {},
    next: safeNext(c.req.query('next')),
    setupNeeded: await noUsersYet(c.env.DB),
  });
});

router.post('/login', async (c) => {
  const db = c.env.DB;
  const body = await getBody(c);
  const username = field(body, 'username');
  const password = field(body, 'password');
  const next = safeNext(field(body, 'next'));
  const ip = ratelimit.clientIp(c);

  if (await ratelimit.isBlocked(db, ip, username)) {
    return render(
      c,
      'auth/login',
      {
        title: 'Sign in',
        bodyClass: 'page-auth',
        errors: ['Too many attempts — wait a few minutes and try again.'],
        values: { username },
        next,
        setupNeeded: await noUsersYet(db),
      },
      429
    );
  }

  const user = await users.byUsername(db, username);
  const ok = !!user && (await verifyPassword(String(password || ''), user.password_hash));

  if (!ok || !user.is_active) {
    await ratelimit.recordFailure(db, ip, username);
    const message =
      ok && !user.is_active
        ? 'That account is no longer active. Talk to a group leader.'
        : 'Username or password is not right.';
    return render(
      c,
      'auth/login',
      {
        title: 'Sign in',
        bodyClass: 'page-auth',
        errors: [message],
        values: { username },
        next,
        setupNeeded: await noUsersYet(db),
      },
      401
    );
  }

  await ratelimit.clear(db, ip, username);
  await sessions.createSession(c, db, user);
  await users.touchLogin(db, user.id);
  flash(c, 'ok', `Signed in as ${user.display_name}.`);
  return c.redirect(next, 302);
});

/* ------------------------------------------------------------------ reset */
// Leader-issued codes, not email — see worker/src/util/resetcode.js. Username +
// code + new password; wrong/expired/reused all fail with the same generic
// message so the form can't be used to probe which usernames exist.

router.get('/reset', requireGuest, (c) =>
  render(c, 'auth/reset', {
    title: 'Reset your password',
    bodyClass: 'page-auth',
    errors: [],
    values: {},
  })
);

router.post('/reset', requireGuest, async (c) => {
  const db = c.env.DB;
  const body = await getBody(c);
  const username = field(body, 'username');
  const code = field(body, 'code');
  const password = field(body, 'password');
  const password2 = field(body, 'password2');
  const ip = ratelimit.clientIp(c);

  const GENERIC_ERROR = 'That reset code is not valid or has expired. Ask a leader for a new one.';

  if (await ratelimit.isBlocked(db, ip, username)) {
    return render(
      c,
      'auth/reset',
      {
        title: 'Reset your password',
        bodyClass: 'page-auth',
        errors: ['Too many attempts — wait a few minutes and try again.'],
        values: { username },
      },
      429
    );
  }

  const errors = [];
  if (String(password || '').length < MIN_PASSWORD) {
    errors.push(`New password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (password !== password2) errors.push('The two new passwords do not match.');

  const user = await users.byUsername(db, username);
  const supplied = normalizeResetCode(code);
  const validCode =
    !!user &&
    !!user.reset_code_hash &&
    !!user.reset_expires_at &&
    user.reset_expires_at > new Date().toISOString() &&
    safeEqual(await sessions.sha256(supplied), user.reset_code_hash);

  if (!validCode) errors.push(GENERIC_ERROR);

  if (errors.length) {
    await ratelimit.recordFailure(db, ip, username);
    return render(
      c,
      'auth/reset',
      {
        title: 'Reset your password',
        bodyClass: 'page-auth',
        errors,
        values: { username },
      },
      400
    );
  }

  await ratelimit.clear(db, ip, username);
  await users.setPasswordHash(db, user.id, await hashPassword(password));
  await users.clearResetCode(db, user.id);
  await sessions.destroyAllForUser(db, user.id);
  await sessions.createSession(c, db, user);
  await users.touchLogin(db, user.id);
  flash(c, 'ok', `Password reset. Signed in as ${user.display_name}.`);
  return c.redirect('/', 302);
});

/* ----------------------------------------------------------------- logout */

router.post('/logout', async (c) => {
  await sessions.destroySession(c, c.env.DB);
  flash(c, 'info', 'Signed out.');
  return c.redirect('/', 302);
});

export default router;
