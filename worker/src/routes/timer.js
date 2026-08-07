/**
 * Port of src/routes/timer.js — the writing-sprint timer shell.
 *
 * GATE: leaders, the architect, or a member hosting an upcoming session
 * (isHost, computed once per request by loadUser). THREE PLACES ENFORCE THE
 * SAME RULE and must move together:
 *
 *   1. this router (the only one that actually matters);
 *   2. the `isLeader || isHost` guard around the timer-widget include in
 *      views/layout.ejs — the floating chip on every page;
 *   3. the same guard around the Timer link in views/partials/nav.ejs.
 *
 * Both views are shared verbatim with the Express app and read the locals
 * worker/src/render.js publishes, so the widget and the nav link light up on
 * Worker pages for exactly the people this route lets in — verified rather
 * than assumed (a plain member's /board HTML carries neither).
 *
 * The phase engine (manual sprint/break plus opt-in auto session plans) is
 * pure client-side JavaScript in public/js/timer-core.js and comes across
 * untouched; this route only renders the shell.
 */

import { Hono } from 'hono';

import { requireMember, HttpError } from '../auth/middleware.js';
import { render } from '../render.js';

const router = new Hono();

router.use('*', requireMember);

/** Leaders, the architect, or a member hosting an upcoming session. */
router.use('*', async (c, next) => {
  if (c.get('isLeader') || c.get('isHost')) return next();
  throw new HttpError(403, 'The timer is for leaders and session hosts.');
});

router.get('/', (c) =>
  render(c, 'timer', {
    title: 'Sprint timer',
    pageCss: ['/css/timer.css'],
    pageJs: ['/js/timer.js'],
  })
);

export default router;
