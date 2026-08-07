# Port plan: AFWC Board → Cloudflare free tier

Target: Workers (Hono) + D1 (database) + R2 (draft/event files), deployed
from this GitHub repo via `wrangler`. $0/mo, no credit card, no sleeping.
The Express/SQLite app in `src/` stays intact and runnable until the port
reaches feature parity; port work happens in the `worker/` directory on
`main` (the two share `views/`, `public/`, and nothing else).

## Architecture decisions (locked)

1. **Router: Hono.** Express-like ergonomics; middleware chain mirrors
   src/app.js order (headers → session load → csrf → routes → error page).
2. **Templates: precompiled EJS.** Workers forbid `eval`/`new Function`, so
   EJS cannot compile at runtime. Build step (`esbuild` + a small script)
   compiles every view in `views/` with `ejs.compile({client: true})` at
   deploy time into plain functions bundled with the Worker. Views stay
   byte-identical where possible; the `include()` shim resolves at build.
3. **DB: D1.** All queries become `await`. better-sqlite3 transactions
   become `env.DB.batch([...])` (no interactive transactions in D1) — the
   ingest "pages + status flip" and thread+post creation are restructured
   as single batches. Migrations 001–005 are squashed into a fresh
   `worker/migrations/0001_init.sql` (same final schema; no prod data
   exists yet, so no upgrade path is needed) applied via
   `wrangler d1 migrations`.
4. **Files: R2.** `uploads/drafts/<id>/…` and `uploads/events/<id>/…`
   become R2 keys with the same shape. Streams pass through the Worker
   (auth stays server-side; R2 is never public). Range requests for the
   PDF reader use R2 range reads.
5. **Passwords: PBKDF2 via WebCrypto** (no scrypt in crypto.subtle).
   Iterations chosen by measurement against the free-tier CPU budget
   (target ≤ ~5ms native; document the number in worker/src/auth/). No
   hash migration needed — production starts empty; dev parity script
   re-seeds test users.
6. **The CPU-budget rule (10 ms/request on the free plan) drives ingest:**
   document conversion moves CLIENT-SIDE. The uploader's browser runs
   mammoth (docx→HTML), marked (md), pagination, pdf.js page-count, and
   image dimensioning, then submits: original file → R2 (streamed, cheap)
   plus per-page payloads → D1. The Worker re-sanitizes each page
   server-side (sanitize-html per ~page-sized payload fits the budget;
   pages submit in small batches). Server-side validation keeps: magic
   bytes, size caps, page-count sanity, ownership. A draft submitted
   without pages (JS off / abandoned) stays `processing` and is sweepable
   exactly as today. Trust model note: page HTML is sanitized server-side
   with the same allowlist as before — the client conversion is a
   convenience, not a trust boundary.
7. **Sessions/CSRF: unchanged design** (random token cookie, sha256 in
   D1, per-session csrf) — sha256 via crypto.subtle.
8. **Backups:** `/admin/backup` becomes a leader-clickable export: D1 dump
   (SQL via the D1 export API / wrangler) + a manifest of R2 keys; plus a
   README-documented `wrangler d1 export` + `rclone`/wrangler r2 path for
   full copies. A monthly Cron Trigger (free) writes a D1 SQL dump into R2
   as a belt-and-braces snapshot.
9. **Timer, floor map, all client JS/CSS:** unchanged (static assets served
   via Workers Assets / Pages).
10. **What dies in the port:** Dockerfile/fly.toml (README keeps a "self-
    host with Node" section pointing at the `main` branch), archiver,
    multer, better-sqlite3, express — none are needed on Workers.

## Ownership / deploy model (Brian's part)

Group email (e.g. afwcollective@gmail.com) owns: GitHub account (this
repo), Cloudflare account (Workers/D1/R2). Passing ownership = passing
that mailbox. Deploy = `wrangler deploy` from CI (GitHub Actions, free)
or locally; site lives at `<name>.workers.dev`. QR code generated once
the URL exists.

## Port phases

P1 spine: worker scaffold (wrangler.toml, esbuild+EJS build, Hono app,
   D1 schema, sessions/auth/csrf, setup/login/register/reset, landing +
   floor map read-only) — runnable with `wrangler dev` end-to-end.
P2 admin + meetings/recurring/events/hosts + announcements + about.
P3 board + threaded comments + conversation.
P4 drafts: client-side ingest pipeline, R2 streams, locked reader,
   watermark, page comments.
P5 roles/members/reset codes/rate limit (D1-backed bucket) + backups +
   cron snapshot + security headers parity.
P6 verification: full E2E matrix re-run against `wrangler dev`, CPU
   budget spot-checks, 375px sweep, README rewrite, GitHub Actions
   deploy workflow, QR code.

Each phase ends runnable under `wrangler dev` with the same verification
bar as the original build. Feature parity checklist = the E2E list in
the plan file + every agent report on `main`.
