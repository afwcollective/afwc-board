/**
 * The Worker entry point — the port of src/app.js.
 *
 * THE MIDDLEWARE ORDER IS THE CONTRACT. src/app.js runs:
 *
 *   security headers → static → body parse → locals defaults
 *     → flash → loadUser → checkCsrf → routers → 404 → error page
 *
 * and this file runs the same list, for the same reasons. Two entries changed
 * shape rather than position:
 *
 *   * "static" is Workers Assets. wrangler.toml sets run_worker_first = true so
 *     the Worker sees every request and the security headers land on stylesheets
 *     and scripts too, exactly as express.static-behind-the-headers did.
 *
 *   * "body parse" is lazy (worker/src/util/body.js). A Worker body can only be
 *     read once, so urlencoded bodies are parsed on first use and cached, and
 *     multipart bodies are never touched by the middleware — which is what
 *     keeps CSRF checkable before consumption on an upload.
 */

import { Hono } from 'hono';

import { flashMiddleware } from './util/flash.js';
import { loadUser, checkCsrf } from './auth/middleware.js';
import { notFound, errorPage } from './routes/errors.js';
import publicRouter from './routes/public.js';
import authRouter from './routes/auth.js';
import accountRouter from './routes/account.js';
import adminRouter from './routes/admin.js';
import boardRouter from './routes/board.js';
import chatRouter from './routes/chat.js';
import eventsRouter from './routes/events.js';
import hostRouter from './routes/host.js';
import timerRouter from './routes/timer.js';
import draftsRouter from './routes/drafts.js';
import readerRouter from './routes/reader.js';

const app = new Hono();

/**
 * Security headers — app-wide, applied to every response before static or
 * routed content. The CSP is copied VERBATIM from src/app.js and is written to
 * be no looser than the app actually needs; each source is commented with what
 * breaks if it's removed:
 *   - img-src data:     docx-embedded figures (mammoth keeps data: URIs) and
 *                        the reader watermark, both inline SVG/base64 images.
 *   - style-src 'unsafe-inline'  the few inline style="" attributes (page-slot
 *                        aspect-ratio, map-picker marker position, the
 *                        watermark tile) — there is no <style> tag anywhere.
 *   - worker-src 'self'  the vendored pdf.js worker, loaded from
 *                        /vendor/pdfjs/pdf.worker.min.mjs (same origin).
 *   - script-src 'self'  every <script> is either a same-origin file or the
 *                        non-executing <script type="application/json"> the
 *                        reader uses to hand data to reader-core.js; neither
 *                        needs 'unsafe-inline'.
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
};

app.use('*', async (c, next) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  await next();
});

/**
 * express.static(public/), as Workers Assets.
 *
 * Only file-shaped paths are offered to the assets binding — a last segment with
 * a dot in it. Exactly one route in this app is shaped like a file
 * (/admin/backup.zip, whose name is what the browser saves), and it falls
 * through here on the assets layer's 404 like any other miss; nothing else pays
 * a lookup. Keeping the check means a missing /css/typo.css answers 404 from the
 * assets layer rather than falling through to the HTML 404 page. A response from
 * the binding is rebuilt so the security headers above can be written onto it;
 * headers set with c.header() are only merged into responses this Worker
 * creates, not into ones it forwards.
 */
const FILE_PATH = /\/[^/]+\.[a-zA-Z0-9]+$/;

app.use('*', async (c, next) => {
  const method = c.req.method;
  if ((method !== 'GET' && method !== 'HEAD') || !FILE_PATH.test(new URL(c.req.url).pathname)) {
    return next();
  }
  const hit = await c.env.ASSETS.fetch(c.req.raw);
  if (hit.status === 404) return next();

  const out = new Response(hit.body, hit);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
});

app.use('*', flashMiddleware);
app.use('*', loadUser);
app.use('*', checkCsrf);

/* ---------------- routers ----------------
 * Mounted once, here. Later phases fill in the routers themselves and should
 * never need to touch this file — a phase swaps its stub import for the real
 * router in the same slot.
 */
app.route('/', publicRouter);
app.route('/', authRouter);
app.route('/account', accountRouter);
app.route('/admin', adminRouter);
app.route('/board', boardRouter);
app.route('/chat', chatRouter);
app.route('/drafts', draftsRouter);
app.route('/events', eventsRouter);
app.route('/host', hostRouter);
app.route('/timer', timerRouter);
/*
 * The reader lands LAST and at the root, exactly as src/app.js mounted
 * src/routes/reader.js after src/routes/drafts.js: it owns /reader,
 * /comments/:id/* and the /drafts/:id/… paths the library router does not.
 * Hono merges both into one router, so the two sets coexist rather than one
 * shadowing the other.
 */
app.route('/', readerRouter);

/* ---------------- errors ---------------- */

app.notFound((c) => notFound(c));
app.onError((err, c) => errorPage(c, err));

export default app;
