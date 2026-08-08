# AFWC Board

A small, self-sufficient community hub for **The Agile Fiction Writers
Collective**, a Baltimore writing group that meets at R. House. It solves one
problem: the group's Meetup page can host a link but nothing more, so every
meetup turned into a scavenger hunt to find the table. This app gives the
group a public front page with the next meeting time and a floor map showing
exactly where they're sitting, a members' discussion board, group and
private chat, and a draft-sharing library with a locked in-browser reader —
with no developer required to operate it day-to-day, and no monthly bill.

## The live site: Cloudflare Workers, at $0/month

The site runs entirely on Cloudflare's free tier — **Workers** (the app
itself, a [Hono](https://hono.dev) router), **D1** (the database, SQLite
under the hood), and **R2** (draft files, event attachments, chat
attachments, and the monthly backup snapshot). No credit card, no server to
patch, nothing that sleeps or spins down between visits. `worker/` holds this
entire app; it shares `views/` and `public/` with the Express version below
and nothing else.

Why this shape holds up on a free plan, in one paragraph each:

- **No idle cost, no cold-start tax.** A Worker only runs while it's
  answering a request, and Cloudflare doesn't charge — or make anyone
  wait — for the gaps between visits, unlike a traditional host where "free"
  usually means "sleeps after 15 minutes of quiet."
- **The CPU budget (≈10ms/request) shaped real decisions**, not just
  performance tuning. Document conversion (docx/pdf/markdown/images) happens
  in the *uploader's own browser* before anything reaches the Worker — see
  `PORT-CLOUDFLARE.md §6` — and the password hasher (PBKDF2, see Security
  posture below) was tuned against the actual measured budget, not a guess.
- **D1's free tier** (5 GB stored, 5M rows read + 100k rows written per day)
  and **R2's free tier** (10 GB stored, zero egress fee ever) are both
  wildly larger than a volunteer writing group's board will ever produce.
- **Three Cron Triggers**, free on every Cloudflare plan, do everything this
  app used to do at Node process boot or on a `setInterval`: sweep stale
  sessions/drafts/rate-limit rows every 15 minutes, write a daily integrity
  report, and snapshot the database to R2 once a month. See
  `worker/wrangler.toml`'s `[triggers]` block and `worker/src/scheduled.js`.

## Local development

Two ways to run this locally, and they answer two different questions.

### The quick path: Express + SQLite (`npm run dev`)

```
npm install
npm run dev
```

Visit `http://localhost:3000`. This is the *original* build of this app —
one Node process, a SQLite file on disk, nothing to configure. It's the
fastest way to poke at a UI change or reproduce a bug report, and it stays
fully maintained (`src/`, sharing `views/` and `public/` with the Worker) as
a documented self-hosting alternative — see the appendix at the bottom of
this file. It is **not** what the live site runs; use the path below to test
anything that touches D1, R2, sessions, or the deploy pipeline.

On first run, with no users in the database, the front page links to
`/setup`. Data lives in `./data` (gitignored) — delete that folder to start
over from a clean slate.

### The production-shaped path: `wrangler dev`

```
npm install
npm run worker:build          # compiles views/*.ejs + bundles worker/src → worker/dist/index.js
npm run worker:migrate:local  # applies worker/migrations/*.sql to a local D1 (SQLite, no account needed)
npm run worker:seed:local     # seeds three test accounts + fixtures — see below
npm run worker:dev            # wrangler dev --local, http://localhost:8787
```

This runs the *actual* Worker code — Hono routes, D1 queries, R2 streams,
the client-side draft-ingest pipeline — against `workerd` (Cloudflare's
runtime) with local, on-disk emulations of D1 and R2. No Cloudflare account,
no login, nothing leaves your machine. This is what a pull request should be
tested against before it merges, and what `npm run worker:verify` checks in
CI (build + view-parity + a handful of unauthenticated smoke requests).

Seeded accounts (`npm run worker:seed:local`, safe to re-run — see that
script's header for exactly what it does and doesn't touch):

| Username | Password | Role |
|---|---|---|
| `brian` | `writers2026` | architect (the board owner) |
| `dana` | `brandnewpw1` | member |
| `walt` | `walter1234` | member |

Group passcode: `remington2026`.

**Exercising the cron jobs locally**: `wrangler dev --local --test-scheduled`
(add `--test-scheduled` to the `worker:dev` command above) exposes
`GET /__scheduled?cron=<expression>`. Take a cron string from
`worker/wrangler.toml`'s `[triggers]`, URL-encode its spaces as `+`, and curl
it — e.g. the 15-minute sweep is
`curl "http://localhost:8787/__scheduled?cron=*%2F15+*+*+*+*"`. The dev
server's own console prints each job's result (see
`worker/src/scheduled.js` for what each one logs).

## DEPLOY-DAY CHECKLIST

Everything above works with zero Cloudflare account. This section is the
one-time ceremony for the day the group actually wants a live URL. It's
written to be followed literally, top to bottom, by whoever holds the
group's Cloudflare account (see **Succession**, below, for who that should
be) — copy each command, run it, move to the next line.

```bash
# 0. From the repo root:
cd worker

# 1. Sign in once. Opens a browser tab; nothing after this needs it again.
wrangler login

# 2. Create the database. WRITE DOWN THE UUID THIS PRINTS — you need it in step 3.
wrangler d1 create afwc-board

# 3. Open worker/wrangler.toml and paste that UUID into database_id under
#    [[d1_databases]]. It's marked with a loud comment so you can't miss it:
#      # ← PASTE FROM `wrangler d1 create afwc-board` OUTPUT (the "database_id" line)
#      database_id = "00000000-0000-0000-0000-000000000000"

# 4. Create the file bucket. The name in wrangler.toml is already final —
#    this step just brings the bucket that name refers to into existence.
wrangler r2 bucket create afwc-board-files

# 5. Apply the database schema to the REAL (remote) database — --remote is
#    the one flag that makes this touch Cloudflare instead of local state.
wrangler d1 migrations apply afwc-board --remote

# 6. Build and ship it.
cd ..
npm run worker:build
cd worker
wrangler deploy

# 7. Visit the URL wrangler just printed (something like
#    https://afwc-board.<your-subdomain>.workers.dev) and go to /setup.
#    This creates the first leader account (the architect) and the group's
#    shared registration passcode — same as local dev's /setup, but for real.
```

**From then on: push-to-deploy.** Once the pieces above exist,
`.github/workflows/deploy.yml` builds and deploys on every push to `main` —
nobody needs to run `wrangler deploy` by hand again. That workflow needs one
more thing, a repo secret, which only has to be set up once:

```bash
# 8. Create a scoped API token instead of reusing your personal login:
#    Cloudflare dashboard → My Profile → API Tokens → Create Token.
#    Start from the "Edit Cloudflare Workers" template, then ADD two more
#    permissions it doesn't include by default:
#      Account → D1 → Edit
#      Account → Workers R2 Storage → Edit
#    Scope it to the one account this app lives in. Copy the token — it's
#    shown once.

# 9. Add it as a repo secret:
#    GitHub repo → Settings → Secrets and variables → Actions →
#    New repository secret → name it CLOUDFLARE_API_TOKEN, paste the value.
```

Until step 9 is done, `.github/workflows/deploy.yml` still runs on every
push — it builds and checks view parity, then skips the deploy steps with a
plain-English notice in the workflow summary, rather than failing. That's
deliberate: this repo can exist and take contributions before the group's
Cloudflare account does.

**One more thing worth doing on deploy day**: run
`node scripts/make-qr.mjs <the workers.dev URL you just got>` (see **QR code
for the table**, below) and print the table tent.

### QR code for the table

`scripts/make-qr.mjs` turns the live URL into a scannable QR code and a
print-ready one-page "scan to find our table" flyer, with no dependencies —
the QR encoder is `scripts/vendor/qr-encoder.mjs`, written for this repo.

```
node scripts/make-qr.mjs "https://afwc-board.<your-subdomain>.workers.dev" ./out "AFWC Board"
```

Writes `qr-afwc.svg` (the code alone) and `table-tent.html` (the printable
page — site name, "scan to find our table", the QR, and the URL spelled out
in monospace underneath for anyone whose camera won't cooperate) into `./out`.
Open `table-tent.html` in a browser and print it. See that script's header
for how to re-verify a QR code actually scans (a rasterize-and-decode round
trip through an independent decoder) before trusting a printout — worth
repeating any time `scripts/vendor/qr-encoder.mjs` changes, not just once.

## Backup and restore

**As a leader**, visit `/admin/backup`. Two things live there:

- **Download database snapshot (.sql)** — a plain-text SQL dump of every
  table (members, meetings, announcements, board posts, drafts metadata,
  comments — everything except the files themselves), on demand, any time.
  This is the one-click half of the story, and the admin dashboard shows how
  long it's been since the last one, turning amber past 30 days or if one
  has never been taken.
- **The automatic monthly snapshot** — the same dump, written to R2
  (`backups/YYYY-MM/`) by a Cron Trigger on the 1st of every month whether or
  not a leader remembers to click anything. Belt-and-braces, not a
  replacement for the on-demand download — see `worker/src/services/backup.js`
  for the exact mechanics and why it's shaped as one R2 object per table
  rather than one giant file.

Neither of those includes the uploaded files themselves (draft originals,
event attachments, chat attachments) — those live in R2 under `drafts/`,
`events/`, and `chat/`, and copying them needs a terminal, not a browser
button. This is the one-time setup for whoever holds the Cloudflare account,
not a monthly chore:

```bash
# One object at a time, by key (find keys via the Cloudflare dashboard's R2
# browser, or `wrangler r2 object get` will tell you if a key is wrong):
wrangler r2 object get afwc-board-files/drafts/<draftId>/original.docx --file ./out --remote

# Or the whole bucket in one command, with rclone configured for an R2 API
# token (Cloudflare dashboard → R2 → Manage R2 API Tokens):
rclone copy r2:afwc-board-files ./local-backup
```

**Full restore drill** — standing the board back up from a snapshot, e.g.
after a disaster or when migrating to a new Cloudflare account:

1. Create a fresh D1 database and apply `worker/migrations/*.sql` to it
   (steps 2 and 5 of the DEPLOY-DAY CHECKLIST, above, against the new
   database).
2. Load the SQL dump: `sqlite3` can't write directly to D1, so the dump's
   `INSERT` statements go in via `wrangler d1 execute afwc-board --remote
   --file ./the-dump.sql`. For a dump pulled from the automatic monthly
   snapshot rather than the on-demand download, first concatenate that
   month's per-table objects (`backups/YYYY-MM/<table>[.N].sql`, listed in
   that folder's `manifest.json`) into one file, in the order the manifest
   lists them.
3. Recreate the R2 bucket (`wrangler r2 bucket create`) and copy the files
   back in with `rclone copy ./local-backup r2:afwc-board-files` (the
   reverse of the command above).
4. Update `worker/wrangler.toml`'s `database_id` to the new database's UUID
   and redeploy.

There is no restore *button* in the admin console, on purpose — restoring
means replacing the live database wholesale, which is rare and risky enough
that it deserves a deliberate, off-app procedure rather than a click.

## Succession

Whoever controls the group's Cloudflare account, GitHub account, and the
Gmail address both are registered under controls the website, the code, and
the hosting — full stop. **Passing ownership of this project means passing
that one mailbox.** Practically:

- Everything hangs off one group email address (e.g.
  `afwcollective@gmail.com`). GitHub and Cloudflare are both registered to
  that address. A new owner doesn't need three handoffs — they need that
  mailbox's password and its recovery info updated to them.
- The site's own **architect** account (created at `/setup` on deploy day)
  is a separate thing from the Cloudflare/GitHub/Gmail chain above — it's
  who runs the board day-to-day, not who could redeploy it from scratch.
  `/admin/members` has a **transfer architect** control for handing that off
  without touching any of the accounts above.
- Nothing here requires a developer to keep running. The whole point of the
  Cloudflare shape is that once deployed, it stays up, costs nothing, and
  needs nobody to SSH in and restart a process — the only maintenance is the
  occasional backup download and, someday, a Node/Wrangler version bump.
- A copy of the account credentials should live somewhere off any single
  laptop — a shared password manager, the leaders' pinned group-chat note,
  a physical binder. This repo's own `OWNER-CREDENTIALS.md` is gitignored on
  purpose (it exists for exactly one machine); don't let that be the only
  copy.

## Security posture — what's protected, what isn't

**Protected:**

- Every route serving draft content requires an active, non-booted session;
  original uploaded files are never served through a public URL and are
  never downloadable except the one deliberate PDF-streaming route (needed
  so the in-browser PDF viewer can render pages, with Range-request support
  for fast seeking), which still requires a session and disables
  download/print in the viewer UI.
- **Passwords: PBKDF2-SHA256 via WebCrypto, 60,000 iterations — a
  measured trade, not a shortcut.** Workers has no `scrypt` (the original
  Express app's choice) — `crypto.subtle` doesn't implement it and a pure-JS
  fallback would be both slow and would burn the whole 10ms/request CPU
  budget the free plan allows. PBKDF2 is native in Workers, which makes it
  the only credible option; the honest cost is that PBKDF2 is not
  memory-hard, so it buys less per unit of work against a GPU attacker than
  scrypt did. 60,000 was chosen by *measuring*, not guessing — see
  `worker/src/auth/passwords.js` for the actual benchmark table
  (`npm run worker:bench:pbkdf2` reproduces it) — it's the largest round
  number that fits inside roughly half the CPU budget, leaving room for the
  database round-trips and page render on every login. That's a fraction of
  OWASP's 600,000-iteration guidance for a server whose only job is the
  login; the gap is covered by what was already true of this app —
  registration gated behind a shared group passcode, login and password
  reset rate-limited to 10 failures per 15 minutes per IP+username, hashes
  that never leave the database — and the plain fact that this protects a
  volunteer writing group's board, not a bank. The iteration count travels
  inside each stored hash, so raising it later needs no migration: old
  passwords keep verifying at their original cost.
- CSRF protection on every state-changing request (a per-session token plus
  an Origin/Referer check).
- Registration is gated behind a shared group passcode that only leaders can
  see or change, so the site isn't open to the public internet at large.
- An optional watermark tags every reader page with the current viewer's
  name, making a leaked screenshot traceable back to an account.
- **Direct messages are private by construction, not by convention.** A DM
  channel is readable by its two participants and by nobody else — there is
  no leader override anywhere in the chat code. A leader (or the architect)
  asking for someone else's DM gets the exact same 404 a stranger gets, on
  every path that could otherwise confirm a conversation exists: the page,
  the poll endpoints, posting a message, deleting a message, downloading an
  attachment. The one moderation tool for a member misusing DMs is
  deactivating their account, not reading their messages.

**Not protected, on purpose, and stated plainly to leaders in the
handbook (`/admin/help`):**

- Screenshots and browser dev-tools cannot be blocked by any web app,
  including this one. **This is the honest limit of the draft reader's
  "lock"**: no download/print buttons, no text layer in the PDF viewer,
  copy/drag/right-click disabled in the reader pane — these raise the bar
  against casual sharing and make an accidental re-post less likely. They do
  not, and cannot, stop someone determined to copy content they can already
  see rendered on their own screen. The watermark exists because of this
  limit, not despite it: it can't prevent a leak, only make one traceable.
- Any member who has been let into the group can, by design, read every
  draft in the library. There are no per-draft access controls beyond "you're
  a member in good standing."
- This is a small trusted-group tool with no dedicated security team behind
  it, appropriate for a volunteer writing collective — not for anything that
  needs to withstand a targeted attack.

## Appendix: self-hosting alternative (Express + Docker)

The original build of this app — one Node process, SQLite on disk, deployed
with the included `Dockerfile` — is preserved and still maintained
(`src/`, sharing `views/` and `public/` with the Worker). Reach for this if
the group ever wants to run its own server instead of Cloudflare's free
tier: identical features, different operational trade-offs (a server to
patch, a volume to back up, a monthly bill).

### ⚠️ Run exactly one instance, always

**This is the one rule that matters more than any other in this section.**
SQLite is a single file on disk. If two instances of this app ever run at the
same time against the same volume — two machines, a rolling deploy that
briefly overlaps old and new, an autoscaler adding a second copy — you will
get database corruption or silently diverging data. Every config below is
written to pin the app to exactly one always-on machine. If your host's
default behavior is to scale out or run a new instance alongside the old one
during deploys, turn that off before you turn anything else on.

### Fly.io (recommended)

```bash
fly launch --no-deploy          # generates/confirms fly.toml, does not deploy yet
fly volumes create afwc_data --size 1 --region iad
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"
fly deploy
```

The included `fly.toml` is a starting point — it mounts a volume named
`afwc_data` at `/data`, sets `min_machines_running = 1` and
`auto_stop_machines = false`, and does not define any scaling beyond a single
`[[vm]]`. Leave those settings alone. Adjust `app`, `primary_region`, and the
`[[vm]]` size to taste.

### Railway

Deploy from this repo (Railway auto-detects the `Dockerfile`). Add a volume
mounted at `/data`, set `SESSION_SECRET` and `DATA_DIR=/data` in the
service's environment variables, and set the service's replica count to
**1** — Railway allows more than one, but this app cannot support it.

### Render

Create a new Web Service from this repo (Docker runtime), attach a persistent
disk mounted at `/data`, set `SESSION_SECRET` and `DATA_DIR=/data` in the
environment tab, and leave the instance count at **1**. Render's autoscaling
must stay off for the same reason as above.

### Environment variables (Express stack only)

| Variable         | Required        | Purpose                                                              |
|-------------------|-----------------|------------------------------------------------------------------------|
| `SESSION_SECRET`  | yes in production | Signs/derives session material. The app refuses to boot in production without it. In development a random one is generated at each start (sessions won't survive a restart). |
| `DATA_DIR`        | no (default `./data`) | Where `app.db` and `uploads/` live. Point this at your mounted volume in production (e.g. `/data`). |
| `PORT`            | no (default `3000`, `8080` in the Docker image) | Port the app listens on. |
| `NODE_ENV`        | no (default `development`) | Set to `production` in every real deployment — this both enables the `SESSION_SECRET` requirement and tightens cookie/security defaults. |

See `.env.example` for a copyable starting point. (The Worker stack needs
none of this — no session secret, no data directory, no port — its
equivalents are D1/R2 bindings and Cloudflare's own TLS termination.)

### Backup and restore (Express stack)

**Backup:** as a leader, visit `/admin` and click **Download backup** (or hit
`/admin/backup.zip` directly). This streams a zip named
`afwc-backup-YYYY-MM-DD.zip` containing `app.db` (a consistent snapshot of
the entire database) and `uploads/drafts/` + `uploads/events/` (every
uploaded file). Do this monthly at minimum; the admin dashboard shows how
long it's been since the last backup.

**Restore** is a hosting-level operation, meant for standing the app back up
on a fresh volume:

1. Unzip the backup file.
2. Copy the extracted `app.db` to the root of the new `/data` volume.
3. Copy the extracted `uploads/` folder into the new volume.
4. Start (or restart) the app pointed at that volume as `DATA_DIR`. It finds
   the existing database, runs any migrations newer than the backup, and
   serves exactly the state that was backed up.

## Support

There is no support contract here — this is a volunteer-run tool for a
volunteer-run group. The `/admin/help` page inside the app is written for the
leaders who'll actually operate it day to day; this README is for whoever
next has to deploy, back up, or hand off the project itself.
