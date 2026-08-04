# AFWC Board

A small, self-sufficient community hub for **The Agile Fiction Writers
Collective**, a Baltimore writing group that meets at R. House. It solves one
problem: the group's Meetup page can host a link but nothing more, so every
meetup turned into a scavenger hunt to find the table. This app gives the
group a public front page with the next meeting time and a floor map showing
exactly where they're sitting, a members' discussion board, and a
draft-sharing library with a locked in-browser reader — all running as one
Node.js process with a SQLite database on the cheapest possible host, with no
developer required to operate it day-to-day.

## Local development

```
npm install
npm run dev
```

Visit `http://localhost:3000`. On first run, with no users in the database,
the front page links to `/setup` — that page creates the first leader account
and the group's shared registration passcode. Everything after that (meetings,
announcements, members, backups) is driven from `/admin`.

Data lives in `./data` (gitignored) — `data/app.db` and `data/uploads/`. Delete
that folder to start over from a clean slate.

Useful dev seed credentials, if `./data` still has the throwaway data from
development/testing: leader `brian` / `writers2026`, member `dana` /
`brandnewpw1`. Passwords may have drifted further during testing — if neither
works, use `/setup` against a fresh `data/` directory.

## Deploying

This app needs almost nothing from its host: one process, one persistent
volume for `/data`, one environment variable it can't run without
(`SESSION_SECRET`). No database server, no object storage, no email provider,
no CDN.

### ⚠️ Run exactly one instance, always

**This is the one rule that matters more than any other in this README.**
SQLite is a single file on disk. If two instances of this app ever run at the
same time against the same volume — two machines, a rolling deploy that
briefly overlaps old and new, an autoscaler adding a second copy — you will
get database corruption or silently diverging data. Every config below is
written to pin the app to exactly one always-on machine. If your host's
default behavior is to scale out or to run a new instance alongside the old
one during deploys, turn that off before you turn anything else on.

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
mounted at `/data`, set `SESSION_SECRET` and `DATA_DIR=/data` in the service's
environment variables, and set the service's replica count to **1** — Railway
allows more than one, but this app cannot support it.

### Render

Create a new Web Service from this repo (Docker runtime), attach a persistent
disk mounted at `/data`, set `SESSION_SECRET` and `DATA_DIR=/data` in the
environment tab, and leave the instance count at **1**. Render's autoscaling
must stay off for the same reason as above.

## Environment variables

| Variable         | Required        | Purpose                                                              |
|-------------------|-----------------|------------------------------------------------------------------------|
| `SESSION_SECRET`  | yes in production | Signs/derives session material. The app refuses to boot in production without it. In development a random one is generated at each start (sessions won't survive a restart). |
| `DATA_DIR`        | no (default `./data`) | Where `app.db` and `uploads/` live. Point this at your mounted volume in production (e.g. `/data`). |
| `PORT`            | no (default `3000`, `8080` in the Docker image) | Port the app listens on. |
| `NODE_ENV`        | no (default `development`) | Set to `production` in every real deployment — this both enables the `SESSION_SECRET` requirement and tightens cookie/security defaults. |

See `.env.example` for a copyable starting point.

## Backup and restore

**Backup:** as a leader, visit `/admin` and click **Download backup** (or hit
`/admin/backup.zip` directly). This streams a zip named
`afwc-backup-YYYY-MM-DD.zip` containing:

- `app.db` — a consistent snapshot of the entire database (users, meetings,
  announcements, board posts, drafts metadata, comments — everything).
- `uploads/drafts/` — every uploaded draft's original file and converted
  pages, one folder per draft.
- `uploads/events/` — attachments on off-site events, one folder per meeting.

Do this monthly at minimum; the admin dashboard shows how long it's been
since the last backup and turns amber past 30 days or if one has never been
taken. See the in-app **[leader handbook](#)** (`/admin/help`) for the
non-technical version of this same advice.

**Restore** is a hosting-level operation, meant for standing the app back up
on a fresh volume (new host, disaster recovery, migrating providers):

1. Unzip the backup file.
2. Copy the extracted `app.db` to the root of the new `/data` volume, so it
   sits at `/data/app.db`.
3. Copy the extracted `uploads/` folder into the new volume, so the trees land
   at `/data/uploads/drafts/` and `/data/uploads/events/`.
4. Start (or restart) the app pointed at that volume as `DATA_DIR`. It will
   find the existing database, run any migrations newer than the backup, and
   serve exactly the state that was backed up.

There is no restore *button* in the admin console on purpose — restoring
means replacing the live database wholesale, which is rare and risky enough
that it deserves a deliberate, off-app step rather than a click.

## Security posture — what's protected, what isn't

**Protected:**

- Every route serving draft content requires an active, non-booted session;
  original uploaded files are never served through a static directory and
  are never downloadable except the one deliberate PDF-streaming route
  (needed so the in-browser PDF viewer can render pages), which still
  requires a session and disables download/print in the viewer UI.
- Passwords are hashed with `node:crypto` scrypt; nothing is stored in
  plaintext. Sessions are random tokens, only their SHA-256 hash lives in the
  database, and booting a member destroys every one of their sessions
  instantly.
- CSRF protection on every state-changing request (per-session token plus an
  Origin/Referer check).
- Registration is gated behind a shared group passcode that only leaders can
  see or change, so the site isn't open to the public internet at large.
- An optional watermark tags every reader page with the current viewer's
  name, making a leaked screenshot traceable back to an account.

**Not protected, on purpose, and stated plainly to leaders in the handbook:**

- Screenshots and browser dev-tools cannot be blocked by any web app,
  including this one. The anti-download measures (no download/print buttons,
  no text layer in the PDF viewer, disabled copy/drag/right-click in the
  reader pane) raise the bar against casual sharing; they do not stop someone
  determined to copy content they can already see on their own screen.
- Any member who has been let into the group can, by design, read every
  draft in the library. There are no per-draft access controls beyond
  "you're a member in good standing."
- This is a single-instance app with no rate-limited third-party auth
  provider and no dedicated security team behind it — appropriate for a small
  trusted group, not for anything that needs to withstand targeted attack.

## Support

There is no support contract here — this is a volunteer-run tool for a
volunteer-run group. The `/admin/help` page inside the app is written for the
leaders who'll actually operate it day to day; this README is for whoever
next has to deploy or restore it.
