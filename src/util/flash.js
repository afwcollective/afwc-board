'use strict';

const config = require('../config');
const { parseCookies, setCookie, clearCookie } = require('../auth/sessions');

const MAX = 4;

/**
 * Cookie-backed flash messages. `type` is one of ok | error | info and maps to
 * the .flash--* modifier classes in site.css.
 *
 *   flash(res, 'ok', 'Meeting saved.');   // then res.redirect(...)
 *
 * The layout renders res.locals.flash via views/partials/flash.ejs.
 */
function flash(res, type, message) {
  const pending = res.locals._pendingFlash || [];
  pending.push({ type: String(type || 'info'), message: String(message) });
  res.locals._pendingFlash = pending.slice(-MAX);
  setCookie(res, config.flashCookie, Buffer.from(JSON.stringify(res.locals._pendingFlash)).toString('base64url'), {
    maxAge: 60 * 1000,
  });
}

/** Middleware: lifts any pending flash off the cookie into res.locals.flash. */
function flashMiddleware(req, res, next) {
  const raw = parseCookies(req)[config.flashCookie];
  let messages = [];
  if (raw) {
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (Array.isArray(parsed)) messages = parsed.filter((m) => m && m.message).slice(0, MAX);
    } catch {
      /* malformed cookie — drop it */
    }
    clearCookie(res, config.flashCookie);
  }
  res.locals.flash = messages;
  next();
}

module.exports = { flash, flashMiddleware };
