/**
 * The runtime half of the precompiled-EJS pipeline.
 *
 * worker/build/compile-views.mjs turns every views/*.ejs into a function with
 * the signature EJS's client mode produces:
 *
 *     (locals, escapeFn, include, rethrow) => string
 *
 * This module supplies the last two arguments and reproduces the two things
 * Express did around a bare template render: include resolution, and the
 * express-ejs-layouts wrap.
 *
 * ---------------------------------------------------------------- includes --
 * ejs resolves `include('partials/head')` relative to the FILE doing the
 * including (ejs's getIncludePath → path.resolve(dirname(filename), name)), and
 * `include('/x')` relative to the views root. There is no filesystem here, so
 * resolveViewName does the same arithmetic on the registry keys, which are view
 * names relative to views/ with the .ejs dropped: "layout", "partials/head",
 * "auth/login". `include('../partials/form-errors')` from "auth/login" lands on
 * "partials/form-errors" exactly as it does under Express.
 *
 * Data merging matches ejs too: the include gets a COPY of the parent's locals
 * with its own overrides layered on, so a partial cannot mutate its caller's
 * scope.
 *
 * ------------------------------------------------------------------ layout --
 * express-ejs-layouts (src/app.js sets `app.set('layout', 'layout')` and uses
 * the middleware) renders the view FIRST, then renders layout.ejs with every
 * local the view had plus `body` — the rendered view — and a `defineContent`
 * helper. Its contentFor/extractScripts/extractStyles/extractMetas features are
 * all off in this app (nothing calls contentFor, and none of the `layout
 * extract*` settings are enabled), so the faithful reproduction is exactly:
 * render view → render layout with { ...locals, body, defineContent }.
 */

import views from '../../.generated/views.js';

function dirName(viewName) {
  const i = viewName.lastIndexOf('/');
  return i < 0 ? '' : viewName.slice(0, i);
}

/** ejs's getIncludePath, over registry keys instead of file paths. */
function resolveViewName(fromView, requested) {
  let raw = String(requested || '').trim();
  if (raw.endsWith('.ejs')) raw = raw.slice(0, -4);

  const absolute = raw.startsWith('/');
  const base = absolute ? [] : dirName(fromView).split('/').filter(Boolean);
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') base.pop();
    else base.push(segment);
  }
  return base.join('/');
}

function makeInclude(selfView, data) {
  return function include(requested, includeData) {
    const name = resolveViewName(selfView, requested);
    const fn = views[name];
    if (!fn) {
      throw new Error(`view not found: "${name}" (included as "${requested}" from "${selfView}")`);
    }
    const merged = includeData ? { ...data, ...includeData } : { ...data };
    return fn(merged, undefined, makeInclude(name, merged), undefined);
  };
}

/** Render one template by name. No layout — this is Express's `layout: false`. */
export function renderView(name, locals = {}) {
  const fn = views[name];
  if (!fn) throw new Error(`view not found: "${name}"`);
  return fn(locals, undefined, makeInclude(name, locals), undefined);
}

/** Render a view and wrap it in layout.ejs, the way express-ejs-layouts does. */
export function renderPage(name, locals = {}) {
  const body = renderView(name, locals);
  const layoutLocals = {
    ...locals,
    body,
    defineContent: (contentName) => locals[contentName] || '',
  };
  return renderView('layout', layoutLocals);
}

/** For diagnostics: every view name this build knows about. */
export const viewNames = () => Object.keys(views).sort();
