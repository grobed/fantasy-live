# fantasy-live Worker

A single Cloudflare Worker that mirrors the league's Google-Sheets state into
**D1** every minute, archives each race's `lap-times.json` into **R2** after the
checkered flag, and serves a read-only JSON API the frontend consumes.

NASCAR live feeds stay client-side (the browser fetches `cf.nascar.com`
directly); the Worker's only automated NASCAR traffic is a gated schedule
refresh and the per-race lap-times archive — a few hundred requests per year.

---

## Architecture at a glance

```
Google Sheet (3 CSV tabs) --reconcile (1/min)--> D1 ----/api/state----> index.html
NASCAR race_list_basic.json --schedule sync (<=1/6h)--> D1 (races)
NASCAR lap-times.json --archive once per finished race--> R2
```

- **D1** = relational mirror of league state: `owners`, `standings`, `picks`,
  `draft_order`, `races`, `meta`. Every table carries `season`. Natural keys
  only; draft picks keyed by `(season, race_id, owner_id)` with `pick_order`.
- **R2** = immutable per-race lap-times archive at
  `lap-times/{year}/series_{id}/{race_id}/lap-times.json`.
- KV is not used. There is no second Worker, no queue, no Durable Object.

---

## First-time setup (you run these — they need your Cloudflare login)

Each step that opens a browser or prints an id is called out. Run everything
from inside `worker/`.

1. **Install deps**

   ```sh
   cd worker
   npm install
   ```

2. **Log in to Cloudflare** (opens a browser for OAuth):

   ```sh
   npx wrangler login
   ```

3. **Create the D1 database** — this prints a `database_id`:

   ```sh
   npx wrangler d1 create fantasy_live
   ```

   Copy the printed `database_id` into `wrangler.toml` under `[[d1_databases]]`
   (replace `PASTE_D1_DATABASE_ID_HERE`).

4. **Create the R2 bucket** (the name must match `wrangler.toml`):

   ```sh
   npx wrangler r2 bucket create fantasy-live-archive
   ```

5. **Review the schema**, then apply migrations. Inspect
   `migrations/0001_init.sql` first.

   ```sh
   # local (creates a SQLite file under .wrangler for `wrangler dev`)
   npx wrangler d1 migrations apply fantasy_live --local
   # remote (the real D1 instance) — run after you're happy with the schema
   npx wrangler d1 migrations apply fantasy_live --remote
   ```

6. **Set the operator secret** (used by the mutation routes):

   ```sh
   npx wrangler secret put BACKEND_SECRET
   ```

   For local dev, copy `.dev.vars.example` to `.dev.vars` and set it there.

7. **Set the CORS origin.** Edit `CORS_ORIGIN` in `wrangler.toml` to your
   GitHub Pages / custom-domain origin (e.g. `https://grobed.github.io`). `*`
   is acceptable for this read-only public data.

---

## Local development

```sh
npx wrangler dev
```

Then exercise it (default local URL `http://localhost:8787`):

```sh
# seed the schedule + run a reconcile (needs BACKEND_SECRET in .dev.vars)
curl -X POST localhost:8787/reconcile -H "x-backend-secret: $BACKEND_SECRET"

curl 'localhost:8787/api/state' | jq
curl 'localhost:8787/api/health' | jq
```

`wrangler dev` does **not** run the cron on a schedule. Trigger the same work
manually with `POST /reconcile`, or test the scheduled handler with
`curl 'localhost:8787/__scheduled?cron=*+*+*+*+*'` (wrangler's test endpoint).

---

## Deploy

```sh
npx wrangler deploy
```

The Worker is published at `https://fantasy-live.<your-subdomain>.workers.dev`
(or your custom route). Verify the cron is registered: Cloudflare dashboard →
Workers & Pages → fantasy-live → **Triggers** → Cron should list `* * * * *`.

---

## Routes

### Read-only (CORS-enabled, no edge cache)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state[?season=YYYY]` | Composite league state for the frontend. Defaults to the current season. |
| `GET` | `/api/health` | `ok` flag, per-table row counts, last-reconcile + schedule-refresh timestamps, R2 object count. |

`/api/state` response shape:

```json
{
  "season": 2026,
  "draftComplete": true,
  "owners": [
    { "owner": "...", "driver": "...", "seasonTotal": 0, "pickNumber": 1, "draftPosition": 0 }
  ],
  "nextRace": { "race_id": 0, "race_name": "...", "track_name": "...", "race_date": "...", "start_time_utc": "..." },
  "lastRace": { "race_id": 0, "race_name": "...", "track_name": "...", "race_date": "...", "lap_times_archived_at": null }
}
```

Owners are returned **pre-sorted in draft order** (draft order → pick order →
standings order), matching how `index.html` orders `ownerList`. `pickNumber` is
the 1-based position in that ordered list (the value the live leaderboard shows
as "Pick").

### Mutation (operator-only — require `x-backend-secret: <BACKEND_SECRET>`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/reconcile` | Refresh schedule if stale, then run the sheet→D1 reconciler now. |
| `POST` | `/archive-lap-times?race_id=NNNN` | Fetch & store `lap-times.json` for a race (idempotent overwrite, re-stamps the D1 flag). |
| `POST` | `/backfill?year=YYYY` | Pull that year's `race_list_basic.json`, upsert every race into D1, and archive `lap-times.json` for every already-finished race. |

Example:

```sh
curl -X POST 'https://fantasy-live.<sub>.workers.dev/backfill?year=2025' \
  -H "x-backend-secret: $BACKEND_SECRET"
```

---

## Cron behavior & NASCAR hit budget

One schedule, `* * * * *`. Each tick:

1. **Schedule refresh** — only if `meta.schedule_refreshed_at` is older than
   6h (else a no-op). Fetches `race_list_basic.json` once.
2. **Reconcile** — fetch the 3 sheet CSVs, parse, diff, batched D1 writes.
   Idempotent; builds into local vars and writes only on full success so a
   failed CSV never corrupts good data.
3. **Archive** — for any race that has started, looks finished (NASCAR
   `winner_driver_id` present, or ≥4h since green flag) and lacks
   `lap_times_archived_at`, fetch `lap-times.json` once → R2 → stamp D1. A 24h
   give-up window after race start bounds retries.

Live-race detection is **schedule-derived**; the Worker never polls
`live-feed.json`. Request budget: 1,440 cron ticks/day, well under the 100K/day
free-tier limit; CPU per tick stays lean (CSV parse + diff + batched writes).

---

## Known risk: NASCAR CDN 403s from Worker egress

`cf.nascar.com` answers many datacenter IPs with `403` regardless of headers
(see `../nascar-feeds.md` §6/§10). The Worker sends browser-like headers
(`User-Agent`, `Referer: https://www.nascar.com/`), but Worker egress is
datacenter traffic and **may still be blocked**. If schedule refresh or
archiving 403s in production:

- Verify by checking `/api/health` (`scheduleRefreshed` / `r2Objects` stay
  empty) and the Worker logs (`npx wrangler tail`).
- Fallback: run the fetch from a residential IP and push the result via the
  operator routes, or archive manually with `POST /archive-lap-times`.

This is the main unknown that can only be confirmed against the live CDN.

---

## How current picks map to a race

The sheet's picks/draft-order tabs are reset each week and carry no race id.
The reconciler attaches the **current** sheet picks to the race currently being
drafted for — the next unrun race (or, at season's end, the most recent race).
Past races' picks are never rewritten, so D1 keeps per-race draft history while
the active draft stays a faithful mirror of the sheet.
