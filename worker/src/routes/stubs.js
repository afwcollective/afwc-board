/**
 * Placeholder routers for the sections a later phase will fill in.
 *
 * This is the same pattern the original build used at the end of its Phase 1
 * (git a7dfcea): each section answers with views/coming-soon.ejs, BEHIND THE
 * GUARD THE REAL ROUTER WILL USE. That matters more than the page does — it
 * means the navigation in views/partials/nav.ejs and views/layout.ejs never
 * points at a 404, and it means the access rules are verified now rather than
 * being invented alongside the features later.
 *
 * The guard kept below is the one the Express original has today:
 *   /drafts   requireMember          (src/routes/drafts.js: router.use(requireMember))
 *
 * A phase that replaces one of these deletes its block here and mounts the real
 * router in worker/src/index.js in the same slot. P2 did that for /admin, /host
 * and /account; P3 did it for /board, /chat and /timer
 * (worker/src/routes/board.js, chat.js, timer.js). What is left below is P4's
 * drafts — the reader, the client-side ingest pipeline and the R2 originals.
 */

import { Hono } from 'hono';
import { requireMember } from '../auth/middleware.js';
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
