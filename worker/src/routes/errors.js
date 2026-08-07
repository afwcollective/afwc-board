/**
 * The two error pages, factored out so the 404 handler, the error handler and
 * /setup's "this page is gone for good" branch all render the same thing.
 * Mirrors the two app.use handlers at the bottom of src/app.js.
 */

import { render } from '../render.js';
import { HttpError } from '../auth/middleware.js';

export function notFound(c) {
  return render(c, 'errors/404', { title: 'Page not found' }, 404);
}

export function errorPage(c, err) {
  const status = (err && (err.status || err.statusCode)) || 500;
  if (status >= 500) console.error('[afwc] error:', err && err.stack ? err.stack : err);
  return render(
    c,
    'errors/error',
    {
      title: status === 403 ? 'Not allowed' : 'Something went wrong',
      status,
      message:
        status < 500
          ? (err && err.message) || 'That request could not be completed.'
          : 'Something went wrong on our end. Try again in a moment.',
    },
    status
  );
}

export { HttpError };
