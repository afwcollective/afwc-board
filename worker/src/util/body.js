/**
 * Request-body parsing, and the reason CSRF still works on multipart uploads.
 *
 * Express parsed `application/x-www-form-urlencoded` in a middleware
 * (express.urlencoded, limit 256kb) that ran BEFORE checkCsrf, which is how
 * checkCsrf could read the hidden `_csrf` field. Multipart bodies were NOT
 * parsed at that point — multer ran per-route, later — which is why
 * src/routes/drafts.js documents that a plain multipart <form> can never satisfy
 * the CSRF check and the uploader has to send X-CSRF-Token from XHR instead.
 *
 * A Worker request body can only be read ONCE. So this module does the parsing
 * lazily and caches the result on the context:
 *
 *   * urlencoded  → parsed here, cached, and handed to both checkCsrf and the
 *                   route. Reading it in the middleware costs the route nothing.
 *   * multipart   → NOT TOUCHED. checkCsrf falls back to the X-CSRF-Token
 *                   header exactly as before, and the route (P4) is free to
 *                   call c.req.parseBody() itself on an unconsumed stream.
 *   * anything else → {}.
 *
 * That is the same trust boundary the Express app had, with the "before body
 * consumption" property now enforced by the runtime rather than by convention.
 */

/** 256kb, matching express.urlencoded({ limit: '256kb' }). */
export const MAX_URLENCODED_BYTES = 256 * 1024;

export class BodyTooLarge extends Error {
  constructor() {
    super('That form was too large.');
    this.status = 413;
  }
}

export function isMultipart(c) {
  return (c.req.header('content-type') || '').toLowerCase().includes('multipart/form-data');
}

/**
 * The urlencoded body as a plain object. Repeated keys collect into an array,
 * matching Node's querystring.parse (what express.urlencoded({extended:false})
 * uses) rather than URLSearchParams' last-one-wins.
 */
export async function getBody(c) {
  const cached = c.get('parsedBody');
  if (cached) return cached;

  let body = {};
  const type = (c.req.header('content-type') || '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    const declared = Number(c.req.header('content-length') || 0);
    if (declared > MAX_URLENCODED_BYTES) throw new BodyTooLarge();
    const text = await c.req.text();
    if (text.length > MAX_URLENCODED_BYTES) throw new BodyTooLarge();
    for (const [k, v] of new URLSearchParams(text)) {
      if (k in body) body[k] = Array.isArray(body[k]) ? [...body[k], v] : [body[k], v];
      else body[k] = v;
    }
  }

  c.set('parsedBody', body);
  return body;
}

/** First value for a field, whether it arrived once or several times. */
export function field(body, name) {
  const v = body ? body[name] : undefined;
  return Array.isArray(v) ? v[0] : v;
}
