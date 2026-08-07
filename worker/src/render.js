/**
 * res.locals, without a res.
 *
 * src/app.js published template locals in three places:
 *   * app.locals        — site, dates (set once at boot)
 *   * a small middleware — pageCss, pageJs, title, bodyClass defaults
 *   * loadUser/flash    — currentUser, isLeader, isArchitect, isHost,
 *                         csrfToken, currentPath, flash
 *
 * Every one of those names is read by a template in the shared views/ directory,
 * so all three collapse into baseLocals() below and are merged under whatever
 * the route passes. Order matters and matches Express: app.locals, then the
 * per-request locals, then the route's own object wins.
 */

import { renderPage, renderView } from './views/render.js';
import * as dates from './util/dates.js';
import config from './config.js';

/** app.locals.site from src/app.js. */
export const SITE = {
  name: config.siteName,
  group: config.groupName,
  venue: config.venue,
  venueAddress: config.venueAddress,
};

export function baseLocals(c) {
  return {
    // app.locals
    site: SITE,
    dates,
    // per-request defaults (src/app.js's res.locals middleware)
    pageCss: [],
    pageJs: [],
    title: null,
    bodyClass: '',
    // flashMiddleware + loadUser
    flash: c.get('flash') || [],
    currentUser: c.get('currentUser') || null,
    isLeader: c.get('isLeader') || false,
    isArchitect: c.get('isArchitect') || false,
    isHost: c.get('isHost') || false,
    csrfToken: c.get('csrfToken') || '',
    currentPath: c.get('currentPath') || new URL(c.req.url).pathname,
  };
}

/** res.render(view, locals) — with the layout, like every route in the app. */
export function render(c, view, locals = {}, status = 200) {
  const html = renderPage(view, { ...baseLocals(c), ...locals });
  return c.html(html, status);
}

/** res.render(view, { layout: false }) — the reader shell uses this in P4. */
export function renderBare(c, view, locals = {}, status = 200) {
  const html = renderView(view, { ...baseLocals(c), ...locals });
  return c.html(html, status);
}
