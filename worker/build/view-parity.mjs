/**
 * `npm run worker:parity:views` — proof that the precompiled views render
 * EXACTLY what Express renders.
 *
 * The port swaps a runtime EJS engine for a build-time one and swaps
 * express-ejs-layouts for eleven lines in worker/src/views/render.js. Neither
 * substitution is allowed to change a byte of output, because views/ is shared:
 * the Express app on `main` and the Worker read the same files, and a template
 * that renders differently on one of them is a bug that would only ever show up
 * as a subtly wrong page.
 *
 * So this harness renders every view TWICE over one fixed locals object —
 * once through real ejs plus the express-ejs-layouts algorithm (render the view,
 * then render layout.ejs with the view's locals plus `body`), once through the
 * generated registry — and string-compares the results. The fixture below is
 * deliberately over-supplied: it carries every local name the compiler reported
 * for any template, so no view has to be skipped.
 *
 * ANY AGENT WHO TOUCHES views/ OR THE COMPILER SHOULD RE-RUN THIS. It needs
 * `npm run worker:build` to have produced worker/.generated/views.js first, and
 * it talks to no server and no database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ejs from 'ejs';

import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VIEWS = path.join(ROOT, 'views');

const workerViews = (await import(path.join(ROOT, 'worker/.generated/views.js'))).default;
const nodeDates = require(path.join(ROOT, 'src/util/dates.js'));

const site = {
  name: 'AFWC Board',
  group: 'The Agile Fiction Writers Collective',
  venue: 'R. House',
  venueAddress: '301 W 29th St, Baltimore',
};

const user = { id: 1, username: 'brian', display_name: 'Brian', role: 'architect', is_active: 1 };
const meeting = {
  id: 7, starts_at: '2026-08-15T17:00:00.000Z', title: 'Saturday sprints',
  notes: 'Bring headphones.', location_label: 'The tables in front of Hilo',
  map_x: 15, map_y: 59.7, is_cancelled: 0, kind: 'rhouse', address: null,
  body_html: null, host_user_id: 2, host_name: 'Dana', is_recurring: true,
  recurring_id: 1, weekday: 6, time_hhmm: '13:00', local_date: '2026-08-15',
  overridden: false, inProgress: false,
};
const ann = {
  id: 1, title: 'The board is open', body_html: '<p>Hello.</p>', body_md: 'Hello.',
  is_pinned: 1, author_name: 'Brian', created_at: '2026-08-01T12:00:00.000Z', snippet: 'Hello.',
};
const rule = {
  id: 1, weekday: 6, time_hhmm: '13:00', title: 'Saturday sprints',
  location_label: 'Hilo', map_x: 15, map_y: 59.7, notes: null, is_active: 1,
};
/*
 * user_id: 1 matches `user` below (the fixture's currentUser), so the base
 * pass is "looking at your own draft" — author_name: null is the common case
 * (no pen name set, byline falls back to uploader_name). Pen-name branches
 * (the tooltip, the edit link's uploader-or-architect gate) are pinned as
 * VARIANTS further down rather than crammed into one object here.
 */
const draft = {
  id: 3, title: 'Chapter One', description: 'draft', kind: 'docx', status: 'ready',
  page_count: 4, user_id: 1, author_name: null, uploader_name: 'Brian',
  original_filename: 'chapter-one.docx',
  created_at: '2026-08-01T12:00:00.000Z',
};
const thread = {
  id: 2, title: 'A thread', user_id: 1, author_name: 'Brian', draft_id: null,
  is_pinned: 0, is_locked: 0, created_at: '2026-08-01T12:00:00.000Z',
  last_post_at: '2026-08-02T12:00:00.000Z', post_count: 2, reply_count: 1,
};
const post = {
  id: 5, thread_id: 2, user_id: 1, author_name: 'Brian', body_html: '<p>Hi.</p>',
  created_at: '2026-08-01T12:00:00.000Z', deleted_at: null,
};
const person = {
  id: 2, username: 'dana', display_name: 'Dana', role: 'member', role_expires_at: null,
  is_active: 1, created_at: '2026-07-01T12:00:00.000Z', last_login_at: '2026-08-01T12:00:00.000Z',
};

/*
 * Chat (P3). views/chat/index.ejs and views/chat/messages.ejs were the two
 * SKIPs P2 left behind — the fixture had none of their locals, so the ejs side
 * threw on the first undefined name and the comparison never ran. The block
 * below supplies all of them, and is deliberately shaped to exercise every
 * BRANCH in both templates rather than merely to make them render:
 *
 *   · the current channel is a GROUP, so the head shows Leave + Archive +
 *     the rename form (canAdmin) rather than #general's plainer header;
 *   · myGroups carries an archived group (the "Archived" badge) and joinable
 *     is non-empty (the "Groups you can join" rail, with its member-count
 *     pluralisation);
 *   · dms is non-empty (the DM rail with its relative timestamp);
 *   · the transcript covers all four message shapes — a day separator, a
 *     grouped follow-up, a removed message, and one carrying both an image
 *     attachment (thumbnail path) and a non-image one (chip path) — plus a
 *     deletable row, so the inline delete form renders;
 *   · hasEarlier is true, so the "show earlier" link renders.
 *
 * `limits` is EXTENDED rather than replaced: views/drafts/new.ejs and
 * views/admin/meeting-form.ejs read the upload numbers off the same object.
 */
const chatChannel = {
  id: 4, kind: 'group', name: 'Sci-fi crew', description: 'Space opera, first contact, hard SF',
  pair_key: null, created_by: 1, created_at: '2026-07-20T12:00:00.000Z',
  archived_at: null, archived_by: null,
};
const chatGeneral = {
  id: 1, kind: 'general', name: 'general',
  description: 'Everyone in the collective. Announcements, questions, and whatever else the group is talking about.',
  pair_key: null, created_by: null, created_at: '2026-07-01T12:00:00.000Z',
  archived_at: null, archived_by: null,
};
const chatMessages = [
  {
    id: 10, user_id: 1, author: 'Brian', body_html: '<p>Morning, all.</p>',
    created_at: '2026-08-06T13:00:00.000Z', removed: false, daySep: true,
    dayLabel: 'Thu 6 Aug', grouped: false, mine: true, canDelete: true, attachments: [],
  },
  {
    id: 11, user_id: 1, author: 'Brian', body_html: '<p>Two minutes to the sprint.</p>',
    created_at: '2026-08-06T13:01:00.000Z', removed: false, daySep: false,
    dayLabel: 'Thu 6 Aug', grouped: true, mine: true, canDelete: true, attachments: [],
  },
  {
    id: 12, user_id: 2, author: 'Dana', body_html: '', created_at: '2026-08-07T09:00:00.000Z',
    removed: true, daySep: true, dayLabel: 'Fri 7 Aug', grouped: false, mine: false,
    canDelete: false, attachments: [],
  },
  {
    id: 13, user_id: 2, author: 'Dana', body_html: '<p>Cover rough, plus the notes.</p>',
    created_at: '2026-08-07T09:05:00.000Z', removed: false, daySep: false,
    dayLabel: 'Fri 7 Aug', grouped: false, mine: false, canDelete: true,
    attachments: [
      { id: 1, name: 'cover.png', size: '2 KB', mime: 'image/png', isImage: true },
      { id: 2, name: 'notes.txt', size: '1 KB', mime: 'text/plain; charset=utf-8', isImage: false },
    ],
  },
];

/*
 * Two fixture objects that VARIANTS need to merge into rather than replace, so
 * they are named here instead of inlined below. `values` is the shared
 * form-values bag every form view reads — a variant that only wants a different
 * `topic` must not silently drop `title` — and `limits` carries numbers from
 * three unrelated pages, one of which (maxImagesTotalMb) legitimately differs
 * between the two stacks.
 */
const LOCALS_VALUES = {
  username: 'dana', display_name: 'Dana', email: 'd@example.com',
  // drafts/new.ejs and drafts/edit.ejs read these five off the same object.
  title: 'Chapter One', description: 'draft', mode: 'document',
  authorName: '', topic: 'Chapter One',
};

const LOCALS_LIMITS = {
  maxDocMb: 25, maxImageMb: 10, maxImages: 60, maxTotalMb: 150,
  maxImagesTotalMb: 150,
  // drafts/new.ejs + drafts/edit.ejs — the pen-name field
  maxAuthorChars: 80,
  // drafts/edit.ejs — title/description clamped to the upload form's own
  // limits, and the discussion topic (threads.title) to the draft title's.
  maxTitleChars: 160, maxDescChars: 2000, maxTopicChars: 160,
  // chat/index.ejs
  maxFiles: 3, maxFileMb: 10, maxChars: 8000,
};

const LOCALS = {
  // app.locals + per-request
  site, dates: nodeDates, title: 'A title', bodyClass: 'page-x',
  pageCss: ['/css/events.css'], pageJs: ['/js/comments.js'],
  flash: [{ type: 'ok', message: 'Saved.' }, { type: 'error', message: 'Nope.' }],
  currentUser: user, isLeader: true, isArchitect: true, isHost: true,
  csrfToken: 'TOKEN123456789012345678', currentPath: '/board',
  body: '<p>BODY</p>', defineContent: () => '',
  // home
  firstRun: false, meeting, eventAttachments: [
    { id: 1, meeting_id: 7, original_name: 'flyer.png', size: 2048 },
  ],
  weekly: [rule], aboutHtml: '<p>About.</p>',
  pinnedAnnouncements: [ann], recentAnnouncements: [{ ...ann, is_pinned: 0 }],
  specialEvents: [{ ...meeting, is_recurring: false, kind: 'offsite', address: '1 Main St' }],
  quoteOfDay: {
    id: 1, text: 'Not all those who wander are lost', attribution: 'J.R.R. Tolkien',
    source_note: 'The Fellowship of the Ring', is_active: 1, sort_order: 0,
  },
  recentDrafts: [
    { id: 3, title: 'Chapter One', kind: 'docx', created_at: '2026-08-01T12:00:00.000Z', author_name: null, uploader_name: 'Brian' },
    { id: 4, title: 'The Long Way Down', kind: 'pdf', created_at: '2026-07-30T12:00:00.000Z', author_name: null, uploader_name: 'Dana' },
    { id: 5, title: 'Panels', kind: 'images', created_at: '2026-07-29T12:00:00.000Z', author_name: null, uploader_name: 'Walt' },
  ],
  recentDraftCount: 3,
  draftKindLabel: { docx: 'Word', pdf: 'PDF', text: 'Text', images: 'Graphic novel' },
  // forms
  errors: ['Something went wrong.', 'And another.'],
  values: LOCALS_VALUES,
  next: '/board', setupNeeded: false,
  // floormap
  markerX: 15, markerY: 59.7, interactive: false,
  // errors / coming-soon
  status: 403, message: 'Nope.', eyebrow: 'Eyebrow', heading: 'Heading', blurb: 'Blurb.',
  // admin
  announcements: [ann], announcementCount: 1, backupStale: true,
  lastBackupAt: '2026-07-01T12:00:00.000Z', leaderCount: 2, memberCount: 5,
  /*
   * admin/backup.ejs — the Worker-only backup page (Express has no such route;
   * it streams a real zip from /admin/backup.zip). lastBackupAt and backupStale
   * above are shared with the dashboard card; the rest are read only here.
   *
   * The base fixture puts the file store in the PAGINATED world (filesInline
   * false, two parts) because that branch has the most markup in it; the
   * "small store" and "empty store" branches are variants below.
   *
   * NOTE ON retentionDays: it is in the BASE fixture, not a variant, because
   * admin/backup.ejs needs it and only the base pass renders that view. That
   * means admin/dashboard's base pass takes its WORKER branch. Both of the
   * dashboard's real-world combinations are therefore pinned explicitly as
   * variants below — the Express one (no Worker locals at all) and the Worker
   * one — rather than relying on the base pass to be either.
   */
  lastSnapshotAt: '2026-07-01T09:00:00.000Z', lastSnapshotMonth: '2026-07',
  fileCount: 7, fileBytes: 12_582_912, filesInline: false,
  fileParts: [
    { part: 1, fromFile: 1, fromChunk: 0, toFile: 5, toChunk: 0, rows: 5, bytes: 240_000, oversize: false },
    { part: 2, fromFile: 6, fromChunk: 0, toFile: 6, toChunk: 0, rows: 1, bytes: 1_000_000, oversize: true },
  ],
  retentionDays: 365, retentionMin: 30, retentionMax: 3650,
  passcodeSet: true, groupPasscode: 'remington2026',
  watermarkOn: true, previewHtml: '<p>Preview.</p>', expiringLeaderCount: 1,
  files: [{ id: 1, original_name: 'flyer.png', size: 2048 }],
  limits: LOCALS_LIMITS,
  /*
   * drafts/edit.ejs. `values` above is the shared form-values object every
   * other form view reads, so the edit page's names go in beside them rather
   * than replacing it — see the merge a few lines down. `hasThread` true is the
   * ordinary case (a draft owns a discussion thread from the moment it is
   * uploaded); the removed-thread branch is a variant.
   */
  hasThread: true, topicPlaceholder: 'Chapter One',
  memberOptions: [person], upcoming: [meeting], past: [meeting],
  rules: [{ ...rule, skips: [{ id: 1, recurring_id: 1, skip_date: '2026-08-22' }], skipDefault: '2026-08-22', hosts: [{ id: 1, local_date: '2026-08-15', user_id: 2, display_name: 'Dana' }], nextDates: ['2026-08-15'], hostDates: [{ local_date: '2026-08-15', starts_at: '2026-08-15T17:00:00.000Z', host: { display_name: 'Dana' } }] }],
  quotes: [
    { id: 1, text: 'Not all those who wander are lost', attribution: 'J.R.R. Tolkien',
      source_note: 'The Fellowship of the Ring', is_active: 1, sort_order: 0 },
    { id: 2, text: 'Write drunk, edit sober', attribution: 'Nobody, actually',
      source_note: null, is_active: 0, sort_order: 5 },
  ],
  people: [person], termOptions: [{ value: '30', label: '30 days' }],
  todayLocal: '2026-08-07', transferCandidates: [person],
  weekdays: nodeDates.weekdayNames(), rule,
  /*
   * board / drafts / reader (P4).
   *
   * `kindLabel` is read TWO WAYS by the two draft templates — drafts/index.ejs
   * indexes it (`kindLabel[d.kind]`) and drafts/show.ejs prints it
   * (`<%= kindLabel %>`), because the library shows a label per row and the
   * reader shows the one for the draft it is already looking at. The fixture
   * satisfies both with an object that also has a toString(), so neither
   * template falls back to "[object Object]" and both sides of the comparison
   * see something a route really could have passed.
   *
   * `sections` uses page_number (what SELECT page_number, heading returns and
   * what the <option value> is built from), and there are TWO of them, because
   * drafts/show.ejs only renders the section menu at `sections.length > 1`.
   * `pageSizes` likewise carries more than one row so the pdf/images branches
   * lay out a real column of slots. `drafts` carries one of each status so the
   * library exercises its Converting / Didn't convert / retry / remove paths.
   */
  threads: [thread], thread, posts: [post], draft,
  drafts: [
    draft,
    { ...draft, id: 4, title: 'Still converting', kind: 'pdf', status: 'processing', page_count: 0 },
    { ...draft, id: 5, title: 'Never converted', kind: 'images', status: 'failed', page_count: 0,
      error_msg: 'We could not process those page images. Try uploading them again.' },
  ],
  canManage: () => true, canPost: true,
  kindLabel: Object.assign(
    { docx: 'Word', pdf: 'PDF', text: 'Text', images: 'Graphic novel' },
    { toString: () => 'Word' }
  ),
  commentCounts: { 1: { total: 2, open: 1 } }, firstPageHtml: '<p>Page one.</p>', mode: 'html',
  pageSizes: [
    { page_number: 1, width: 800, height: 1000 },
    { page_number: 2, width: 800, height: 1000 },
    { page_number: 3, width: null, height: null },
  ],
  sections: [
    { page_number: 1, heading: 'One' },
    { page_number: 3, heading: 'Two' },
  ],
  threadId: 2,
  watermarkDataUri: 'data:image/svg+xml;base64,AAA',
  // chat
  channel: chatChannel, general: chatGeneral, channelTitle: 'Sci-fi crew',
  channelHref: (ch) => `/chat/c/${ch.id}`,
  partner: { id: 2, display_name: 'Dana', username: 'dana', is_active: 1 },
  // `memberCount` (5) and `canPost` (true) are already above — chat/index.ejs
  // reads exactly those two names, so they are shared rather than duplicated.
  myGroups: [
    { ...chatChannel, member_count: 4, last_message_id: 13 },
    { id: 5, kind: 'group', name: 'Poetry Mondays', description: null, archived_at: '2026-08-01T12:00:00.000Z', member_count: 2, last_message_id: 3 },
  ],
  joinable: [
    { id: 6, kind: 'group', name: 'Memoir table', description: null, archived_at: null, member_count: 1 },
    { id: 7, kind: 'group', name: 'Worldbuilders', description: 'Maps, languages, calendars', archived_at: null, member_count: 3 },
  ],
  dms: [
    { id: 8, created_at: '2026-08-01T12:00:00.000Z', other_id: 2, other_name: 'Dana',
      other_username: 'dana', other_active: 1, last_message_id: 9, last_at: '2026-08-06T18:00:00.000Z' },
    { id: 9, created_at: '2026-08-02T12:00:00.000Z', other_id: 3, other_name: 'Walt',
      other_username: 'walt', other_active: 1, last_message_id: 4, last_at: null },
  ],
  messages: chatMessages, show: 50, hasEarlier: true, pageSize: 50,
  canRead: true, canAdmin: true, joined: true, conversationFocused: true,
  // host
  sessions: [{ ...meeting, type: 'recurring', editPath: '/host/recurring/1/2026-08-15', paused: false, skipped: false }],
  windowDays: 30,
  ctx: { rule, localDate: '2026-08-15', meeting },
};

function nodeRender(name, locals) {
  const file = path.join(VIEWS, `${name}.ejs`);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

function nodeRenderPage(name, locals) {
  const body = nodeRender(name, locals);
  return nodeRender('layout', { ...locals, body, defineContent: (n) => locals[n] || '' });
}

function workerRenderView(name, locals) {
  const dirName = (v) => (v.lastIndexOf('/') < 0 ? '' : v.slice(0, v.lastIndexOf('/')));
  const resolve = (from, req) => {
    let raw = String(req).replace(/\.ejs$/, '');
    const base = raw.startsWith('/') ? [] : dirName(from).split('/').filter(Boolean);
    for (const s of raw.split('/')) {
      if (s === '' || s === '.') continue;
      if (s === '..') base.pop();
      else base.push(s);
    }
    return base.join('/');
  };
  const mk = (self, data) => (req, extra) => {
    const n = resolve(self, req);
    const merged = extra ? { ...data, ...extra } : { ...data };
    return workerViews[n](merged, undefined, mk(n, merged), undefined);
  };
  return workerViews[name](locals, undefined, mk(name, locals), undefined);
}

function workerRenderPage(name, locals) {
  const body = workerRenderView(name, locals);
  return workerRenderView('layout', { ...locals, body, defineContent: (n) => locals[n] || '' });
}

/*
 * VARIANTS — a second (third, …) pass over one view with different locals.
 *
 * One fixture cannot be inside and outside an `if` at the same time, and the
 * draft reader has branches that matter enough to be worth proving on both
 * sides: the three reader MODES (html / pdf / images render completely
 * different panes), the processing and failed states, and the `retryHint`
 * local that only the Worker sets (views/drafts/show.ejs — see the comment
 * there; Express deliberately leaves it undefined and takes the else branch,
 * which the base pass above already covers).
 *
 * Each entry renders `view` again with LOCALS merged under its `locals`, and
 * is compared exactly like a base view.
 */
const VARIANTS = [
  ['drafts/show', 'pdf reader', { mode: 'pdf', draft: { ...draft, kind: 'pdf' }, kindLabel: 'PDF' }],
  ['drafts/show', 'image reader', { mode: 'images', draft: { ...draft, kind: 'images' }, kindLabel: 'Graphic novel' }],
  ['drafts/show', 'processing', { draft: { ...draft, status: 'processing', page_count: 0 } }],
  ['drafts/show', 'failed (Express wording)', {
    draft: { ...draft, status: 'failed', error_msg: 'We could not read that PDF.' },
  }],
  ['drafts/show', 'failed (Worker retryHint)', {
    draft: { ...draft, status: 'failed', error_msg: 'We could not read that PDF.' },
    retryHint: 'Conversion happens in your own browser on this site, so trying again means uploading the file once more.',
  }],
  ['drafts/show', 'watermark off', { watermarkOn: false, watermarkDataUri: null }],
  ['drafts/show', 'locked conversation', { thread: { ...thread, is_locked: 1 }, canPost: false }],
  ['drafts/show', 'thread removed by a leader', { thread: null, threadId: null, posts: [] }],
  /*
   * THE DISCUSSION TOPIC. threads.title starts as the draft's title on both
   * stacks, and while they agree the conversation section says nothing extra —
   * which is what every pass above already proves. Once the uploader has
   * renamed it from /drafts/:id/edit, the reader shows what the conversation is
   * actually about, so nobody has to go out to /board to find the heading.
   */
  ['drafts/show', 'a discussion topic renamed away from the draft title', {
    thread: { ...thread, title: 'Pacing after the argument' },
  }],

  /*
   * BYLINE — the draft-author feature. `draft.author_name` (nullable, both
   * schemas) overrides the uploader's display name wherever a byline shows;
   * `draft.user_id === currentUser.id || isArchitect` is the one thing that
   * ALSO gates the "Edit byline" link, deliberately narrower than the
   * canManage() authority retry/delete already have (a plain leader manages
   * a draft but does not get to rewrite whose name is on someone else's
   * work — see the comment on canEditAuthor() in worker/src/routes/drafts.js
   * and src/routes/drafts.js). The base pass already covers the plainest
   * case: no pen name, viewed by its own uploader (who is also, in this
   * fixture, a leader and the architect). These four pin the other reachable
   * combinations of {pen name set?, viewer = uploader/architect/leader/
   * ordinary member?}.
   */
  ['drafts/show', 'byline: pen name set, uploader viewing (moderation tooltip + edit link)', {
    draft: { ...draft, author_name: 'Wordsmith' },
  }],
  ['drafts/show', 'byline: pen name set, a leader (neither uploader nor architect) viewing', {
    draft: { ...draft, user_id: 2, uploader_name: 'Dana', author_name: 'Wordsmith' },
    isArchitect: false,
  }],
  ['drafts/show', 'byline: pen name set, an ordinary member viewing (no tooltip, no edit link)', {
    draft: { ...draft, user_id: 2, uploader_name: 'Dana', author_name: 'Wordsmith' },
    isLeader: false, isArchitect: false,
  }],
  ['drafts/show', 'byline: architect editing a draft they did not upload', {
    draft: { ...draft, user_id: 2, uploader_name: 'Dana', author_name: 'Wordsmith' },
    isLeader: true, isArchitect: true,
  }],

  ['drafts/index', 'empty library', { drafts: [] }],
  ['drafts/index', 'nothing this member may manage', { canManage: () => false }],
  ['drafts/index', 'byline: pen name set, moderation tooltip + architect edit link', {
    drafts: [{ ...draft, author_name: 'Wordsmith', user_id: 2, uploader_name: 'Dana' }],
  }],
  ['drafts/index', 'byline: pen name set, ordinary member viewing (no tooltip, no edit link)', {
    drafts: [{ ...draft, author_name: 'Wordsmith', user_id: 2, uploader_name: 'Dana' }],
    isLeader: false, isArchitect: false, canManage: () => false,
  }],

  /*
   * drafts/edit — the full per-draft edit surface: title, description, byline,
   * DISCUSSION TOPIC (threads.title, renamed from here) and REPLACING THE FILE.
   * The base pass is the plainest state: a Word draft whose topic still matches
   * its title and which has no pen name. These pin the rest.
   */
  ['drafts/edit', 'editing an existing pen name', {
    draft: { ...draft, author_name: 'Wordsmith' },
    values: { ...LOCALS_VALUES, authorName: 'Wordsmith' },
  }],
  ['drafts/edit', 'a topic renamed away from the draft title', {
    values: { ...LOCALS_VALUES, topic: 'Pacing after the argument' },
    topicPlaceholder: 'Pacing after the argument',
  }],
  ['drafts/edit', 'the discussion thread was removed by a leader (no topic field)', {
    hasThread: false, topicPlaceholder: '',
    values: { ...LOCALS_VALUES, topic: '' },
  }],
  ['drafts/edit', 'a rejected save (title emptied)', {
    errors: ['Give the draft a title so people know what they are opening.'],
    values: { ...LOCALS_VALUES, title: '' },
  }],
  ['drafts/edit', 'a page-sequence draft, replacing with another sequence', {
    draft: { ...draft, kind: 'images', original_filename: '12 page images' },
    kindLabel: 'Graphic novel',
    values: { ...LOCALS_VALUES, mode: 'images' },
  }],
  ['drafts/edit', 'a draft uploaded before original_filename was recorded', {
    draft: { ...draft, original_filename: null },
  }],
  /*
   * The one number that genuinely DIFFERS between the two stacks on this page:
   * a page sequence may total 150 MB on Express (multer streams each part to a
   * tmp file) and 40 MB on the Worker (Hono materialises the whole body in a
   * 128 MB isolate — see worker/src/services/drafts/attachments.js). Both
   * routes render it from their own limits object, so this proves the template
   * says whichever is true rather than hardcoding either.
   */
  ['drafts/edit', 'worker file limits (40 MB page-sequence total)', {
    limits: { ...LOCALS_LIMITS, maxImagesTotalMb: 40 },
  }],

  ['drafts/new', 'with errors', { errors: ['Give the draft a title so people know what they are opening.'] }],
  ['drafts/new', 'image mode preselected', { values: { title: 'Panels', description: '', mode: 'images' } }],
  /*
   * admin/dashboard's two real shapes. The Backup card (P5) and the file
   * RETENTION card (this phase) are both typeof-guarded Worker-only locals —
   * the same arrangement as drafts/show's retryHint above — so the two
   * combinations that actually ship are pinned here rather than implied:
   *
   *   express  no Worker locals at all: the hardcoded /admin/backup.zip +
   *            "Download backup" link, and no retention card.
   *   worker   worker/src/routes/admin.js's GET / handler, in full.
   *
   * `undefined` really does mean "absent" for a typeof guard: `with(locals)`
   * binds the name, and `typeof name` on a bound-but-undefined name is
   * 'undefined' — which is exactly the state Express leaves it in.
   */
  ['admin/dashboard', 'express stack (no worker locals)', {
    backupHref: undefined, backupLabel: undefined,
    retentionDays: undefined, retentionMin: undefined, retentionMax: undefined,
  }],
  ['admin/dashboard', 'worker stack (backup card + retention card)', {
    backupHref: '/admin/backup', backupLabel: 'Backup options',
    retentionDays: 90, retentionMin: 30, retentionMax: 3650,
  }],

  /*
   * admin/help's Backups section forks the same way: Express documents its zip
   * of app.db + uploads/, the Worker documents a .sql download and the
   * retention window. The base pass renders the Worker half (retentionDays is
   * in the fixture); this pins Express's.
   */
  ['admin/help', 'express stack (zip backup section)', { retentionDays: undefined }],

  /*
   * admin/backup.ejs's other two file-store worlds. The base fixture is the
   * paginated one; a board with a handful of prose drafts gets the first of
   * these, and a brand-new board gets the second.
   */
  ['admin/backup', 'small store (files inline)', { filesInline: true, fileCount: 3, fileBytes: 240_000, fileParts: [] }],
  ['admin/backup', 'empty store', { filesInline: true, fileCount: 0, fileBytes: 0, fileParts: [] }],
  ['admin/backup', 'never downloaded', { lastBackupAt: null, lastSnapshotAt: null, lastSnapshotMonth: null }],

  /*
   * drafts/new's retention note — Worker-only, and worded from a live setting
   * so the number is never a lie. Base covers Express (absent).
   */
  ['drafts/new', 'worker retention note', {
    retentionNote: 'Shared files are kept for a year, then cleaned up automatically.',
  }],

  /*
   * The two Worker-only "expired" flags on shared views. Both are per-ITEM
   * rather than per-page locals — `a.expired` on an attachment, `f.expired` on
   * an event file — so the fixture varies the collection rather than a
   * top-level name. Express supplies neither key, which the base pass covers.
   */
  ['chat/messages', 'worker: attachments still live', {
    messages: chatMessages.map((m) => ({
      ...m,
      attachments: m.attachments.map((a) => ({ ...a, expired: false })),
    })),
  }],
  ['chat/messages', 'worker: attachments expired', {
    messages: chatMessages.map((m) => ({
      ...m,
      attachments: m.attachments.map((a) => ({ ...a, expired: true })),
    })),
  }],
  ['home', 'worker: event attachment expired', {
    eventAttachments: [{ id: 1, meeting_id: 7, original_name: 'flyer.png', size: 2048, expired: 1 }],
  }],
  ['home', 'fresh pages: a pen name credited instead of the uploader', {
    recentDrafts: [
      { id: 3, title: 'Chapter One', kind: 'docx', created_at: '2026-08-01T12:00:00.000Z',
        author_name: 'Wordsmith', uploader_name: 'Brian' },
      { id: 4, title: 'The Long Way Down', kind: 'pdf', created_at: '2026-07-30T12:00:00.000Z',
        author_name: null, uploader_name: 'Dana' },
    ],
  }],

  /*
   * The bootstrap setup code — rendered only when a SETUP_TOKEN binding exists
   * on the deployment. Express has no bindings and never sets it, which the
   * base pass covers.
   */
  ['auth/setup', 'worker: setup code required', { setupTokenRequired: true }],

  /*
   * Group passcode display (both stacks pass `groupPasscode`, so this is not a
   * typeof-guarded Worker-only local like backupHref — it's a plain nullable
   * string). Base fixture covers the normal case (a plaintext code on file);
   * these two pin the other reachable states: a pre-existing board whose
   * passcode was set before this feature (hash only, no plaintext), and a
   * brand-new board where registration hasn't been opened at all.
   */
  ['admin/dashboard', 'legacy passcode (hash only, no plaintext on file)', { groupPasscode: null }],
  ['admin/dashboard', 'no passcode set yet', { groupPasscode: null, passcodeSet: false }],

  /*
   * SESSION LINGER (dates.SESSION_LINGER_MS) — the "Happening now" branch on
   * the two next-session cards. `meeting.inProgress` is computed by
   * models.js's meetings.nextUnified; these pin the badge + "since <time>"
   * markup that replaces the ordinary dates.relative() line while it's true.
   */
  ['home', 'happening now (session linger)', { meeting: { ...meeting, inProgress: true } }],
  ['admin/dashboard', 'happening now (session linger)', { meeting: { ...meeting, inProgress: true } }],
  ['admin/passcode', 'legacy passcode (hash only, no plaintext on file)', { groupPasscode: null }],
  ['admin/passcode', 'no passcode set yet', { groupPasscode: null, passcodeSet: false }],
];

const names = Object.keys(workerViews).sort();
let bad = 0;
for (const name of names) {
  if (name === 'layout') continue;
  let a;
  let b;
  try {
    a = nodeRenderPage(name, LOCALS);
  } catch (e) {
    console.log(`SKIP  ${name} (ejs side threw: ${e.message.split('\n')[0]})`);
    continue;
  }
  try {
    b = workerRenderPage(name, LOCALS);
  } catch (e) {
    console.log(`FAIL  ${name} (worker side threw: ${e.message.split('\n')[0]})`);
    bad += 1;
    continue;
  }
  if (a === b) {
    console.log(`OK    ${name}  (${a.length} bytes identical)`);
  } else {
    bad += 1;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    console.log(`DIFF  ${name}  first difference at byte ${i}`);
    console.log(`      express: ${JSON.stringify(a.slice(i - 60, i + 60))}`);
    console.log(`      worker : ${JSON.stringify(b.slice(i - 60, i + 60))}`);
  }
}
for (const [name, label, extra] of VARIANTS) {
  const locals = { ...LOCALS, ...extra };
  let a;
  let b;
  try {
    a = nodeRenderPage(name, locals);
  } catch (e) {
    console.log(`FAIL  ${name} [${label}] (ejs side threw: ${e.message.split('\n')[0]})`);
    bad += 1;
    continue;
  }
  try {
    b = workerRenderPage(name, locals);
  } catch (e) {
    console.log(`FAIL  ${name} [${label}] (worker side threw: ${e.message.split('\n')[0]})`);
    bad += 1;
    continue;
  }
  if (a === b) {
    console.log(`OK    ${name} [${label}]  (${a.length} bytes identical)`);
  } else {
    bad += 1;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    console.log(`DIFF  ${name} [${label}]  first difference at byte ${i}`);
    console.log(`      express: ${JSON.stringify(a.slice(i - 60, i + 60))}`);
    console.log(`      worker : ${JSON.stringify(b.slice(i - 60, i + 60))}`);
  }
}

console.log(
  `\n${names.length - 1} views + ${VARIANTS.length} branch variants compared, ${bad} mismatch(es).`
);
process.exit(bad ? 1 : 0);
