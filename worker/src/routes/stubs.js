/**
 * Placeholder routers for the sections P2–P5 will fill in.
 *
 * This is the same pattern the original build used at the end of its Phase 1
 * (git a7dfcea): each section answers with views/coming-soon.ejs, BEHIND THE
 * GUARD THE REAL ROUTER WILL USE. That matters more than the page does — it
 * means the navigation in views/partials/nav.ejs and views/layout.ejs never
 * points at a 404, and it means the access rules are verified now, in this
 * phase, rather than being invented alongside the features later.
 *
 * Each router keeps the guard the Express original has today:
 *   /board    requireMember          (src/routes/board.js: router.use(requireMember))
 *   /drafts   requireMember
 *   /account  requireMember
 *   /host     requireMember          (per-occurrence checks are inside, P2)
 *   /admin    requireLeader          (leader or architect)
 *   /timer    requireMember + isLeader||isHost  (src/routes/timer.js)
 *
 * A phase that replaces one of these deletes its block here and mounts the real
 * router in worker/src/index.js in the same slot.
 */

import { Hono } from 'hono';
import { requireMember, requireLeader, HttpError } from '../auth/middleware.js';
import { render } from '../render.js';

function comingSoon(c, { title, eyebrow, heading, blurb }) {
  return render(c, 'coming-soon', {
    title,
    bodyClass: 'page-soon',
    eyebrow,
    heading,
    blurb,
  });
}

/* ------------------------------------------------------------------ /board */
export const boardRouter = new Hono();
boardRouter.use('*', requireMember);
boardRouter.get('/', (c) =>
  comingSoon(c, {
    title: 'Board',
    eyebrow: 'Members · Discussion',
    heading: 'The board',
    blurb:
      'Threads, replies and markdown land in P3 of the Cloudflare port. Until then, announcements on the front page carry the news.',
  })
);

/* ----------------------------------------------------------------- /drafts */
export const draftsRouter = new Hono();
draftsRouter.use('*', requireMember);
draftsRouter.get('/', (c) =>
  comingSoon(c, {
    title: 'Drafts',
    eyebrow: 'Members · Read & critique',
    heading: 'The draft library',
    blurb:
      'Upload a chapter as .docx, .pdf, images or plain text and it becomes a page-turner in the browser, with comments on every page. Lands in P4, once uploads stream to R2.',
  })
);

/* ------------------------------------------------------------------ /admin */
export const adminRouter = new Hono();
adminRouter.use('*', requireLeader);
adminRouter.get('/', (c) =>
  comingSoon(c, {
    title: 'Admin',
    eyebrow: 'Leaders · Console',
    heading: 'The admin console',
    blurb:
      'Meetings, weekly rules, hosts, announcements, the group passcode and the members table all move across in P2.',
  })
);

/* ------------------------------------------------------------------- /host */
export const hostRouter = new Hono();
hostRouter.use('*', requireMember);
hostRouter.get('/', (c) =>
  comingSoon(c, {
    title: 'Hosting',
    eyebrow: 'Members · Running a session',
    heading: "The sessions you're hosting",
    blurb:
      'Your next 30 days of assignments, and the handful of things a host may change about one session, arrive with the meetings port in P2.',
  })
);

/* ---------------------------------------------------------------- /account */
export const accountRouter = new Hono();
accountRouter.use('*', requireMember);
accountRouter.get('/', (c) =>
  comingSoon(c, {
    title: 'Your account',
    eyebrow: 'Members · You',
    heading: 'Your account',
    blurb: 'Changing your password from here comes across with the members admin in P5.',
  })
);

/* ------------------------------------------------------------------ /timer */
/**
 * GATE: leaders, the architect, or a member hosting an upcoming session
 * (isHost, published by loadUser). The matching client-side gates are the
 * `isLeader || isHost` guards around the widget include in views/layout.ejs and
 * the Timer link in views/partials/nav.ejs — all three must move together or
 * the nav link will disagree with what the route actually allows.
 */
export const timerRouter = new Hono();
timerRouter.use('*', requireMember);
timerRouter.use('*', async (c, next) => {
  if (c.get('isLeader') || c.get('isHost')) return next();
  throw new HttpError(403, 'The timer is for leaders and session hosts.');
});
timerRouter.get('/', (c) =>
  comingSoon(c, {
    title: 'Sprint timer',
    eyebrow: 'Leaders & hosts · Sprints',
    heading: 'The sprint timer',
    blurb:
      'The timer is pure client-side JavaScript and comes across untouched — it just needs the page shell, which lands with the rest of the member pages.',
  })
);
