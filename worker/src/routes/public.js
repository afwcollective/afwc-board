/**
 * Port of src/routes/public.js — /healthz and the landing page.
 *
 * The section order, the privacy rule and the two constants below are all
 * unchanged. This is the route that forces the D1 port of the whole
 * meetings/recurring/hosts/announcements/settings model layer, which every
 * later phase reuses.
 */

import { Hono } from 'hono';
import { meetings, recurring, announcements, eventFiles, about, quotes, drafts } from '../models.js';
import { noUsersYet } from '../auth/middleware.js';
import { mdToHtml, toPlainText } from '../util/sanitize.js';
import { render } from '../render.js';

/** How many of the most recent unpinned announcements the landing page shows. */
const RECENT_ANNOUNCEMENT_COUNT = 6;
/** How many special events the landing page lists before it would need paging. */
const SPECIAL_EVENT_COUNT = 20;
/** Featured cell + this many smaller cells in the "fresh pages" window. */
const FRESH_DRAFT_COUNT = 3;

/** Mirrors the drafts router's KIND_LABEL — kept local rather than shared
    across routers, same convention as everything else in that file. */
const DRAFT_KIND_LABEL = { docx: 'Word', pdf: 'PDF', text: 'Text', images: 'Graphic novel' };

const router = new Hono();

router.get('/healthz', (c) => c.text('ok'));

router.get('/', async (c) => {
  const db = c.env.DB;
  const firstRun = await noUsersYet(db);
  const unified = firstRun ? null : await meetings.nextUnified(db);

  /*
   * THE PRIVACY RULE for off-site events (decided with the group): the address,
   * the details and the attachments belong to members. A logged-out visitor
   * gets the title, the date and time, and an invitation to sign in.
   *
   * Both halves of that are done here rather than in the template: the row is
   * passed through meetings.publicSafe(), which nulls the private columns
   * outright, and the attachment list is simply not fetched. A template that
   * forgot the rule would have nothing to leak.
   */
  const signedIn = !!c.get('currentUser');
  const meeting = signedIn ? unified : meetings.publicSafe(unified);
  const eventAttachments =
    signedIn && meeting && meeting.kind === 'offsite' && meeting.id
      ? await eventFiles.forMeeting(db, meeting.id)
      : [];

  /*
   * News & announcements: pinned ones are the newsletter — featured in full,
   * markdown body and all. Unpinned ones are a compact recent list (no
   * pagination yet, so just the most recent few). `announcements.list` already
   * sorts pinned-first, newest-first, so one query covers both halves.
   */
  const allAnnouncements = firstRun ? [] : await announcements.list(db, 30);
  const pinnedAnnouncements = allAnnouncements.filter((a) => a.is_pinned);
  const recentAnnouncements = allAnnouncements
    .filter((a) => !a.is_pinned)
    .slice(0, RECENT_ANNOUNCEMENT_COUNT)
    .map((a) => ({ ...a, snippet: toPlainText(a.body_html, 140) }));

  /*
   * Special events: every future one-off meeting except whichever one is
   * already the next-session card above (nothing should appear twice on the
   * page). Same privacy rule as the next-session card.
   */
  const excludeId = unified && !unified.is_recurring ? unified.id : null;
  const specialRaw = firstRun ? [] : await meetings.upcomingSpecial(db, SPECIAL_EVENT_COUNT, excludeId);
  const specialEvents = signedIn ? specialRaw : specialRaw.map(meetings.publicSafe);

  /*
   * Quote rail: one deterministic pick, same for every visitor today. Null
   * (nothing active, or a first-run board) just means the section is skipped
   * — quotes.ofDay already returns null rather than throwing.
   */
  const quoteOfDay = firstRun ? null : await quotes.ofDay(db);

  /*
   * "Fresh pages": members see the real thing (title, author, date, kind),
   * a logged-out visitor sees only a count — no titles, no names. Both reads
   * are READY, non-deleted drafts only, same rule the library itself uses.
   */
  const recentDrafts = !firstRun && signedIn ? await drafts.recent(db, FRESH_DRAFT_COUNT) : [];
  const recentDraftCount = !firstRun && !signedIn ? await drafts.countAll(db) : 0;

  return render(c, 'home', {
    title: null, // layout falls back to the site name
    bodyClass: 'page-home',
    pageCss: ['/css/events.css'],
    firstRun,
    meeting,
    eventAttachments,
    weekly: firstRun ? [] : await recurring.listActive(db),
    aboutHtml: firstRun ? '' : mdToHtml(await about.getMd(db)),
    pinnedAnnouncements,
    recentAnnouncements,
    specialEvents,
    quoteOfDay,
    recentDrafts,
    recentDraftCount,
    draftKindLabel: DRAFT_KIND_LABEL,
    pageJs: [],
  });
});

export default router;
