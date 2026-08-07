/**
 * Worker-side twin of src/config.js. Only the values a Worker can actually have
 * survive the port: there is no DATA_DIR, no dbFile, no PORT, and no
 * SESSION_SECRET (the Express app used it as a fallback seed for dev cookies;
 * session tokens here are always crypto-random and stored hashed in D1, so
 * nothing is derived from a secret).
 *
 * `isProd` is gone too. Everything that used it was really asking "is this
 * connection secure?", which a Worker can answer from the request URL — see
 * cookieSecure() in worker/src/util/cookies.js.
 */
export const config = {
  timezone: 'America/New_York',
  siteName: 'AFWC Board',
  groupName: 'The Agile Fiction Writers Collective',
  venue: 'R. House',
  venueAddress: '301 W 29th St, Baltimore',
  sessionCookie: 'afwc_sid',
  csrfCookie: 'afwc_csrf',
  flashCookie: 'afwc_flash',
  sessionTtlDays: 30,
};

export default config;
