/**
 * Port of src/routes/account.js — the signed-in member's own account page,
 * currently just a password change.
 *
 * Mounted at /account (worker/src/index.js), so the two paths here are '/' and
 * '/password'; the Express version mounted at / and spelled them out in full.
 * Everything else is unchanged, including the rotation rule: changing a
 * password kills every OTHER session and keeps the one making the request
 * alive, so the member is not signed out of the tab they are standing in.
 */

import { Hono } from 'hono';

import { users } from '../models.js';
import { requireMember } from '../auth/middleware.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import * as sessions from '../auth/sessions.js';
import { flash } from '../util/flash.js';
import { getBody, field } from '../util/body.js';
import { render } from '../render.js';

const router = new Hono();

router.use('*', requireMember);

const MIN_PASSWORD = 8;

router.get('/', (c) =>
  render(c, 'account/show', {
    title: 'Your account',
    errors: [],
  })
);

router.post('/password', async (c) => {
  const db = c.env.DB;
  const body = await getBody(c);
  const current_password = field(body, 'current_password');
  const new_password = field(body, 'new_password');
  const new_password2 = field(body, 'new_password2');

  const me = c.get('currentUser');
  const user = await users.byId(db, me.id);
  const errors = [];

  if (!user || !(await verifyPassword(String(current_password || ''), user.password_hash))) {
    errors.push('Current password is not right.');
  }
  if (String(new_password || '').length < MIN_PASSWORD) {
    errors.push(`New password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (new_password !== new_password2) {
    errors.push('The two new passwords do not match.');
  }

  if (errors.length) {
    return render(c, 'account/show', { title: 'Your account', errors }, 400);
  }

  await users.setPasswordHash(db, me.id, await hashPassword(new_password));
  // Rotate: kill every other session, keep the one making this request alive.
  await sessions.destroyOtherSessions(c, db, me.id);
  flash(c, 'ok', 'Password changed. Any other signed-in sessions were signed out.');
  return c.redirect('/account', 302);
});

export default router;
