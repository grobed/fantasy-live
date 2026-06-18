# Cloudflare backend — kickoff brief

This file is the standing brief for the next Claude Code session that
builds the Cloudflare backend. Read it end-to-end before doing anything
else, then also skim:

- `index.html` — the existing static frontend. The CSV parser, the
  `DRIVER_ALIASES` map, the period-stripping `cleanName()`, the
  schedule-date handling, the Central-time formatting, and the
  `liveRaceProbe` logic all already exist there. Port verbatim into a
  shared module inside `worker/`; do not rewrite.
- `nascar-feeds.md` — the documented map of NASCAR's undocumented
  Cloudflare-cached JSON feeds. Field shapes, flag-state values, and
  the lap-times post-race persistence note all come from there.

The decisions below were settled in a prior planning conversation; do
not re-litigate them. Open questions are listed at the bottom —
surface those to the user before applying migrations or shipping the
frontend cutover commit.

## Audience

Assume the user is new to Cloudflare. Walk through every wrangler step
(install, login, `wrangler.toml`, D1/R2 binding creation, secrets,
local dev, deploy) and pause for any browser-auth or paste-the-id
step. Don't run anything that requires the user's credentials without
telling them what's about to happen.

## Goal

A single Worker (in `worker/`) that:

1. Mirrors the league's Google-Sheets state into D1 every minute (the
   live mirror).
2. Archives one `lap-times.json` per race into R2 after the race
   finishes (the historical archive).
3. Serves a read-only JSON API the frontend consumes for league state.
4. Exposes mutation HTTP routes for on-demand reconcile / archive /
   backfill / health.

Then, **after the API is verified end-to-end**, cut `index.html` over
to read league state from the Worker API instead of fetching the three
CSVs directly. NASCAR live feeds remain fetched client-side from
`cf.nascar.com` (no Worker proxy in this phase) to keep blast radius
and Worker CPU pressure small.

The league's Google Sheet remains the draft source of truth for now.
A future project will replace the Google Apps Script drafting flow
with direct writes to D1 — design the schema to support that future
state, but **do not build it in this project**.

## Data sources

Three published-CSV tabs from one Google Sheet:

- `PICKS_CSV_URL`       (gid=7)   col A=owner, col B=driver
- `STANDINGS_CSV_URL`   (gid=148) col C=owner, col D=season pts
- `DRAFT_ORDER_CSV_URL` (gid=4)   col A=owner, header `owner`

NASCAR feeds (documented in `nascar-feeds.md`):

- `cf.nascar.com/cacher/{year}/race_list_basic.json` — schedule
- `cf.nascar.com/live/feeds/live-feed.json` — live probe
- `cf.nascar.com/cacher/live/series_{id}/{race}/live-feed.json`
- `cf.nascar.com/live/feeds/series_{id}/{race}/live_points.json`
- `cf.nascar.com/cacher/live/series_{id}/{race}/lap-times.json` —
  persists post-race per `nascar-feeds.md`; this is the archive target.

## Storage

**D1** = relational mirror of league state. Owners, picks, standings,
draft order, schedule. Every table carries a `season` column from day
one. The schema must also be friendly to future direct-from-drafting-UI
writes — natural keys, no "sheet row number" baked in, draft picks
identified by `(season, race_id, owner_id)` with a `pick_order` column.
Propose the schema (4–6 tables) and **pause for user review** before
applying any migrations.

**R2** = archive of NASCAR `lap-times.json`. One snapshot per race
after the checkered flag. Path:

```
lap-times/{year}/series_{id}/{race_id}/lap-times.json
```

Immutable, append-only. One file per race — no periodic snapshots, no
other feeds.

KV is not used. GitHub-as-archive is not used.

## Cron schedules

One Worker, one schedule, branch on `controller.cron`:

- `* * * * *` — every minute → reconcile sheet CSVs into D1; then,
  for any race that's recently finished and lacks a
  `lap_times_archived_at` in D1, fetch
  `cacher/live/series_{id}/{race_id}/lap-times.json` and write to R2,
  then stamp the D1 row.

Keep the hot path lean to stay under the 10 ms free-tier CPU budget
(parse CSV, diff, batched D1 writes). The lap-times fetch must be
gated by a D1 flag so we fetch exactly once per race.

Cron limit on free tier is 5/account; we use 1. Worker request budget
is 100K/day; minute-cadence is 1,440/day, well within.

## NASCAR hit budget (enforced by D1 gating, not by trust)

The cron runs every minute but touches `cf.nascar.com` only when
gated by D1 state:

- `race_list_basic.json` — at most once per 6 hours (D1
  `schedule_refreshed_at` timestamp). The schedule changes rarely;
  daily is plenty, every 6 h is conservative.
- `lap-times.json` per race — skipped if `lap_times_archived_at` is
  set; capped to one attempt per cron tick per race, with a 24-hour
  give-up window after `race_date`.
- `live-feed.json` — **not polled by the Worker at all**. Live-race
  detection in the Worker is derived from schedule (`race_date` +
  `winner_driver_id` presence), not from probing the live feed.

The frontend continues to hit NASCAR feeds directly from the browser
when a user has the page open — that's existing user-driven behavior
and is unchanged. The Worker's total automated NASCAR footprint is on
the order of a few hundred requests per year.

## Read-only API (consumed by index.html)

```
GET /api/state[?season=YYYY]
```

Single composite response giving the frontend everything it currently
derives from the three CSVs. Defaults to the current season. Shape
along these lines (final names align with `index.html`'s existing
variables so the cutover is near-mechanical):

```json
{
  "season": 2026,
  "draftComplete": true,
  "owners": [
    {
      "owner": "...",
      "driver": "...",
      "seasonTotal": 0,
      "pickNumber": 1,
      "draftPosition": 1
    }
  ],
  "nextRace": {
    "race_id": 0,
    "race_name": "...",
    "track_name": "...",
    "race_date": "...",
    "start_time_utc": "..."
  },
  "lastRace": {
    "race_id": 0,
    "race_name": "...",
    "track_name": "...",
    "race_date": "...",
    "lap_times_archived_at": null
  }
}
```

Fresh on every request (no edge cache) so a draft pick propagates
within one reconcile cycle.

```
GET /api/health
```

Sanity check + last-reconcile timestamp, row counts, R2 object count.

API responses must set CORS headers permitting the GitHub Pages /
custom-domain origin so `index.html` can fetch them from the browser.

## Mutation routes (operator-only)

```
POST /reconcile              run the sheet→D1 reconciler now
POST /archive-lap-times      fetch & store lap-times.json for a given
                             race_id (idempotent overwrite, resets the
                             D1 archived flag)
POST /backfill?year=YYYY     fetch race_list_basic.json for that year,
                             reconcile every race into D1, and pull
                             lap-times.json for each completed race
                             into R2.
```

All mutation routes require a shared-secret header
(`wrangler secret put BACKEND_SECRET`). Document in `worker/README.md`.

## Reconciler requirements

- Idempotent — running it twice in a row yields zero new writes.
- UPSERT (`INSERT ... ON CONFLICT`) keyed by natural keys, e.g.
  `(season, race_id, owner_id)`. Don't autoincrement everything.
- Driver-name matching reuses the alias map and period-stripping
  `cleanName()` from `index.html` — extract to a shared module (e.g.
  `worker/src/lib/clean-name.ts`).
- Standings rows whose points cell isn't numeric are skipped (matches
  the frontend's behavior).
- Failure of any source CSV must not corrupt previously-good D1 data:
  build into local vars first, write only on full success.

## Frontend cutover (the index.html change)

Done as the **final** phase, only after `/api/state` is verified
working against live data.

- Replace the three `fetchCSV()` calls in `loadOwnerInfo()` with one
  fetch of `/api/state`. Rebuild `ownerList`, `ownerInfo`,
  `draftComplete` from the response — keep the existing variable
  names and shapes so `renderDraftBoard`, `renderAwaiting`, and
  `renderRaceView` don't have to change.
- Schedule / next-race / last-race info comes from the same response;
  `fetchSchedule()` and its 30-min cache go away.
- NASCAR `live-feed.json`, per-race `live-feed`, and `live_points.json`
  continue to be fetched client-side as today — no change to
  `renderRaceView`'s NASCAR calls.
- `DRIVER_ALIASES` and `cleanName()` remain in `index.html` (still
  needed for matching feed driver names against the API's canonical
  names).
- Remove the dead CSV-fetching code in the same commit as the
  cutover, **not before** — so a rollback is a single revert.
- Add a top-of-script constant for the API base URL so the user can
  flip between dev (`wrangler dev` URL) and prod easily.

## Legacy backfill

Decision now, import later. NASCAR's per-year `race_list_basic.json`
makes the NASCAR backfill cheap — `POST /backfill?year=YYYY` handles
it via the same reconciler. League historical (old spreadsheets) is
the variable cost: column layouts and rosters likely differ across
seasons, so that's an ad-hoc import per season later. **Do not block
the MVP on historical league data.**

## Implementation order

1. Create branch: `claude/cloudflare-backend-<suffix>`.
2. Scaffold `worker/` with `wrangler.toml` and a minimal Hono (or raw
   `fetch` handler) skeleton.
3. Walk user through: `wrangler login`, `wrangler d1 create <dbname>`,
   `wrangler r2 bucket create <bucketname>`. Paste IDs into
   `wrangler.toml`.
4. Propose D1 schema with `season` on every table. **Pause for user
   review** before applying migrations.
5. Apply migrations (`wrangler d1 migrations apply`).
6. Implement the sheet→D1 reconciler + `POST /reconcile`. Test with
   `wrangler dev` + `curl`.
7. Add the `* * * * *` cron. Deploy. Verify it ticks (Cloudflare
   dashboard → Workers → Triggers).
8. Implement post-race lap-times archive: races table gets
   `lap_times_archived_at` and `r2_key` columns; reconciler fetches
   once per finished race and writes to R2. Add
   `POST /archive-lap-times` for manual replay.
9. Implement `GET /api/state`. Verify the response matches what
   `index.html` currently computes from the CSVs (spot-check a few
   owners).
10. Implement `POST /backfill?year=YYYY`. Demonstrate against a past
    season.
11. Cut `index.html` over to `/api/state`. Single commit. Verify
    against live league data before merging.
12. `worker/README.md` documenting routes, secrets, schema, R2
    layout, CORS origin, and how to run/replay locally.

## Do not

- Do not change the league's draft workflow. The Google Sheet
  remains the source of truth in this phase.
- Do not modify `index.html` in any phase except the final cutover
  (step 11). Even then, only the data-fetching layer changes — UI,
  columns, modes, alias map, helpers, and formatting all stay.
- Do not remove CSV-fetching code in `index.html` before `/api/state`
  is verified, so a single-commit rollback is possible.
- Do not add transformations in the cron hot path that risk the
  10 ms free-tier CPU budget.
- Do not proxy NASCAR live feeds through the Worker in this project
  — they stay client-side.
- Do not poll `cf.nascar.com/live/feeds/live-feed.json` from the
  Worker. Live-race detection in the Worker is schedule-derived.
- Do not commit secrets or R2 access keys.
- Do not introduce queues, Durable Objects, a second Worker, feature
  flags, or a framework beyond Hono (or raw `fetch`). Budget for MVP
  is "boring and small."

## Open questions to resolve with the user before coding

- Proposed D1 schema sketch (4–6 tables, `season` on every table,
  designed to accept future direct-from-drafting-UI writes). Approve
  before migrations.
- Whether the races table also denormalizes `track_name`,
  `race_type_id`, and `winner_driver_id` from the schedule
  (recommended: yes — cheap, saves joins).
- Final shape and field names of `GET /api/state`. The sketch above
  is a starting point; align it with the variable names already in
  `index.html` so the cutover is a near-mechanical swap.
- The deployed Worker's URL/domain (`workers.dev` subdomain vs.
  custom) — needed to set the CORS allowlist and the `API_BASE_URL`
  constant in `index.html`.
