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
  overridden: false,
};
const ann = {
  id: 1, title: 'The board is open', body_html: '<p>Hello.</p>', body_md: 'Hello.',
  is_pinned: 1, author_name: 'Brian', created_at: '2026-08-01T12:00:00.000Z', snippet: 'Hello.',
};
const rule = {
  id: 1, weekday: 6, time_hhmm: '13:00', title: 'Saturday sprints',
  location_label: 'Hilo', map_x: 15, map_y: 59.7, notes: null, is_active: 1,
};
const draft = {
  id: 3, title: 'Chapter One', description: 'draft', kind: 'docx', status: 'ready',
  page_count: 4, user_id: 1, author_name: 'Brian', created_at: '2026-08-01T12:00:00.000Z',
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
    { id: 3, title: 'Chapter One', kind: 'docx', created_at: '2026-08-01T12:00:00.000Z', uploader_name: 'Brian' },
    { id: 4, title: 'The Long Way Down', kind: 'pdf', created_at: '2026-07-30T12:00:00.000Z', uploader_name: 'Dana' },
    { id: 5, title: 'Panels', kind: 'images', created_at: '2026-07-29T12:00:00.000Z', uploader_name: 'Walt' },
  ],
  recentDraftCount: 3,
  draftKindLabel: { docx: 'Word', pdf: 'PDF', text: 'Text', images: 'Graphic novel' },
  // forms
  errors: ['Something went wrong.', 'And another.'],
  values: { username: 'dana', display_name: 'Dana', email: 'd@example.com' },
  next: '/board', setupNeeded: false,
  // floormap
  markerX: 15, markerY: 59.7, interactive: false,
  // errors / coming-soon
  status: 403, message: 'Nope.', eyebrow: 'Eyebrow', heading: 'Heading', blurb: 'Blurb.',
  // admin
  announcements: [ann], announcementCount: 1, backupStale: true,
  lastBackupAt: '2026-07-01T12:00:00.000Z', leaderCount: 2, memberCount: 5,
  passcodeSet: true, watermarkOn: true, previewHtml: '<p>Preview.</p>', expiringLeaderCount: 1,
  files: [{ id: 1, original_name: 'flyer.png', size: 2048 }],
  limits: {
    maxDocMb: 25, maxImageMb: 10, maxImages: 60, maxTotalMb: 150,
    // chat/index.ejs
    maxFiles: 3, maxFileMb: 10, maxChars: 8000,
  },
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
  // board / drafts / reader
  threads: [thread], thread, posts: [post], draft, drafts: [draft],
  canManage: () => true, canPost: true, kindLabel: () => 'Word document',
  commentCounts: { 1: 2 }, firstPageHtml: '<p>Page one.</p>', mode: 'html',
  pageSizes: [{ page_number: 1, width: 800, height: 1000 }],
  sections: [{ page: 1, heading: 'One' }], threadId: 2,
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
console.log(`\n${names.length - 1} views compared, ${bad} mismatch(es).`);
process.exit(bad ? 1 : 0);
