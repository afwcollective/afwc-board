'use strict';

const path = require('node:path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');

const config = require('./config');
const { loadUser, checkCsrf } = require('./auth/middleware');
const { flashMiddleware } = require('./util/flash');
const dates = require('./util/dates');

const app = express();

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('layout', 'layout');
app.use(expressLayouts);
app.disable('x-powered-by');

/**
 * Security headers — app-wide, applied to every response before static or
 * routed content. The CSP is written to be no looser than the app actually
 * needs; each source is commented with what breaks if it's removed:
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
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self'",
      "frame-ancestors 'self'",
    ].join('; ')
  );
  next();
});

app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.isProd ? '7d' : 0,
    etag: true,
  })
);
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// Anything the templates may reference. Routes add to this via res.render locals.
app.locals.site = {
  name: config.siteName,
  group: config.groupName,
  venue: config.venue,
  venueAddress: config.venueAddress,
};
app.locals.dates = dates;

/**
 * Per-page asset hooks. Every view may pass:
 *   res.render('board/thread', { pageCss: ['/css/board.css'], pageJs: ['/js/comments.js'] })
 * layout.ejs emits them after the shared site.css / in <body> end. Defaults live
 * here so a view that passes neither still renders.
 */
app.use((req, res, next) => {
  res.locals.pageCss = [];
  res.locals.pageJs = [];
  res.locals.title = null;
  res.locals.bodyClass = '';
  next();
});

app.use(flashMiddleware);
app.use(loadUser);
app.use(checkCsrf);

/* ---------------- routers ----------------
 * Mounted once, here. Later phases fill in the routers themselves and should
 * never need to touch this file.
 */
app.use('/', require('./routes/public'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/account'));
app.use('/admin', require('./routes/admin'));
app.use('/board', require('./routes/board'));
app.use('/drafts', require('./routes/drafts'));
app.use('/', require('./routes/reader'));

/* ---------------- errors ---------------- */

app.use((req, res) => {
  res.status(404).render('errors/404', { title: 'Page not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[afwc] error:', err);
  res.status(status).render('errors/error', {
    title: status === 403 ? 'Not allowed' : 'Something went wrong',
    status,
    message:
      status < 500
        ? err.message || 'That request could not be completed.'
        : 'Something went wrong on our end. Try again in a moment.',
  });
});

module.exports = app;
