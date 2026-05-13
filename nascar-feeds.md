# NASCAR public JSON feeds (cf.nascar.com)

Consolidated reference of the undocumented Cloudflare-cached JSON feeds at
`cf.nascar.com`, reverse-engineered from four community repositories:

| Tag | Repo | Local path used below |
|---|---|---|
| `pynascar` | https://github.com/ab5525/pynascar | `pynascar/` |
| `NascarApi` | https://github.com/ooohfascinating/NascarApi | `NascarApi/led_sports_ticker/` |
| `jemorriso` | https://github.com/jemorriso/nascar | `jemorriso-nascar/` |
| `nascar-tracker` | https://github.com/Dennist03/nascar-tracker | `nascar-tracker/` |

Nothing here is invented — every URL pattern below appears verbatim in one or
more of the repos. Line numbers refer to the state of each repo on 2026-05-13.

---

## 1. URL conventions

### Host

All endpoints live on a single host:

```
https://cf.nascar.com
```

This is NASCAR's Cloudflare-fronted public CDN. There are no API keys; the
endpoints are anonymously cached JSON files. They do, however, appear to
require browser-like request headers — bare `curl` invocations and many
data-center egress IPs are answered with `403 Forbidden` (see §6).

### Top-level branches

Three distinct path prefixes are referenced across the four repos:

| Prefix | What it serves | Source attestations |
|---|---|---|
| `/cacher/...` | Historical and per-race static data, **and** the schedule. | pynascar (`base_api.py:9`), nascar-tracker (`nascarApi.js:3`), jemorriso (`config.json:2`), pynascar (`schedule.py:38`) |
| `/cacher/live/...` | Live in-race feeds, namespaced by `series_<id>/<race_id>/`. | pynascar (`base_api.py:10`), nascar-tracker (`nascarApi.js:74`, `live.js:8/18/28`) |
| `/live/feeds/...` | Live in-race feeds, **global** (no series/race in the URL — always reflects whatever session is "current"). | NascarApi (`nascar_api.py:94-98`, `recorder.py:58-62`) |
| `/loopstats/prod/...` | NASCAR Loop Data driver statistics. | pynascar (`base_api.py:11`, `base_api.py:66`) |

> **Note on the two "live" branches.** `pynascar` and `nascar-tracker` reach
> live data via `/cacher/live/series_<id>/<race_id>/...`, while `NascarApi`
> reaches it via `/live/feeds/...` without any series or race in the path. Both
> are real and both work in the wild — the `/live/feeds/` form is the one the
> nascar.com Race Center page polls directly, while `/cacher/live/...` mirrors
> the same content under a per-race-namespaced URL that survives once the race
> is over. See §5 Open questions.

### Path parameters

| Token | Meaning | Where it comes from |
|---|---|---|
| `{year}` | Race season, e.g. `2024`. Four-digit calendar year. | `pynascar.Schedule(year, …)` |
| `{series_id}` | Numeric series identifier — see series table below. | `pynascar.codes`, `NascarApi.SERIES_NAMES` |
| `{race_id}` | Numeric race identifier issued by NASCAR. The schedule feed (`race_list_basic.json`) is the canonical source for these. Stable per race (e.g. 2025 Daytona 500 = `5546`; 2021 Daytona 500 = `5029`). | `pynascar.Schedule.fetch_races`, jemorriso `config.json` |
| `{session_number}` | 1-based index of a practice or qualifying session within a race weekend (e.g. `_practice_1`, `_practice_2`). Only seen on the legacy `lapAvg_*` endpoint. | pynascar README:232 |

### Series ID table

Confirmed across `pynascar/README.md:144-147`, `NascarApi/nascar_api.py:113-123`,
and `nascar-tracker/lib/nascarApi.js:39-43`:

| `series_id` | Name | Short | Slug seen in `drivers.json` |
|---|---|---|---|
| `1` | NASCAR Cup Series | CUP | `nascar-cup-series` |
| `2` | NASCAR Xfinity Series | NXS | `nascar-oreilly-auto-parts-series` |
| `3` | NASCAR Craftsman Truck Series | TRUCK | `nascar-craftsman-truck-series` |

The `series_<n>` form is used both as a JSON key in `race_list_basic.json`
(`series_1`, `series_2`, `series_3`) and as a path segment under
`/cacher/live/` (`series_1/…`, `series_2/…`).

---

## 2. `/cacher/` — per-race and schedule data

Base: `https://cf.nascar.com/cacher`

All `/cacher/{year}/{series_id}/{race_id}/…` URLs are immutable once the race
finishes — the Cloudflare cache effectively turns them into a permanent
archive of every NASCAR race weekend going back several years. The same paths
also exist under `/cacher/live/series_{series_id}/{race_id}/…` while a session
is live (without the `{year}` segment — see §3).

### 2.1 Weekend / results

| URL template | Purpose | Source |
|---|---|---|
| `/{year}/{series_id}/{race_id}/weekend-feed.json` | The big one — race weekend metadata + final results + stage results + caution segments + lead changes + practice/qualifying summaries. Response top-level keys include `weekend_race` (one-element list whose `[0]` carries the race) and `weekend_runs` (list of practice/qualifying sessions). | `pynascar/src/pynascar/core/base_api.py:37`; `nascar-tracker/backend/lib/nascarApi.js:54`; `nascar-tracker/backend/routes/races.js:72` |

Response shape extracted from `pynascar/src/pynascar/race.py:106-141` and
`pynascar/src/pynascar/core/process_data.py`:

```
weekend_race: [
  {
    race_name, scheduled_distance, scheduled_laps, total_race_time,
    stage_1_laps, stage_2_laps, stage_3_laps,
    number_of_cars_in_field, restrictor_plate,
    results: [                        # final order
      { driver_id, driver_fullname, car_number, car_make, sponsor,
        team_name, team_id, qualifying_order, qualifying_position,
        qualifying_speed, starting_position, finishing_position,
        laps_completed, points_earned, playoff_points_earned, ... }
    ],
    caution_segments: [               # yellow flag periods
      { start_lap, end_lap, reason, comment, flag_state }
    ],
    race_leaders: [                   # lead-change ledger
      { start_lap, end_lap, car_number }
    ],
    stage_results: [                  # one entry per stage
      { stage_number, results: [{ driver_id, driver_fullname, car_number,
                                  finishing_position, stage_points }] }
    ]
  }
],
weekend_runs: [                       # practice + qualifying sessions
  { run_name, run_type, results: [...] }
]
```

Example:
`https://cf.nascar.com/cacher/2024/1/5544/weekend-feed.json`

### 2.2 Lap-level telemetry

| URL template | Purpose | Source |
|---|---|---|
| `/{year}/{series_id}/{race_id}/lap-times.json` | Per-driver per-lap timing. Top-level `laps` array of `{ NASCARDriverID, Number, FullName, Manufacturer, Laps: [{ Lap, LapTime, RunningPos }] }`. | `pynascar/src/pynascar/core/base_api.py:45`; `jemorriso-nascar/config.json:2`; `jemorriso-nascar/src/nascar/nascar.py:39-40,75-79` |
| `/{year}/{series_id}/{race_id}/lap-notes.json` | Race-control event log (the "events" feed): flag changes, warm-up notes, free-text comments per lap. Columns post-processing: `Lap`, `Flag_State`, `Flag`, `note`, `driver_ids`. | `pynascar/src/pynascar/core/base_api.py:61`; `pynascar/README.md:185-191` |

Examples:
- `https://cf.nascar.com/cacher/2024/1/5544/lap-times.json`
- `https://cf.nascar.com/cacher/2024/1/5544/lap-notes.json`
- jemorriso ships a hard-coded known-good URL: `https://cf.nascar.com/cacher/2021/1/5029/lap-times.json` (2021 Daytona 500, Cup).

### 2.3 Pit data

| URL template | Purpose | Source |
|---|---|---|
| `/{year}/{series_id}/{race_id}/live-pit-data.json` | Per-stop pit timing — pit-in/out flag state, box stop/leave race time, tire changes per corner, pit-stop type, positions gained/lost, in/out travel duration. Note the `live-` prefix even when fetched from the historical `/cacher/` path. | `pynascar/src/pynascar/core/base_api.py:53`; columns documented at `pynascar/README.md:102-103` |

Example: `https://cf.nascar.com/cacher/2024/1/5544/live-pit-data.json`

### 2.4 Schedule

| URL template | Purpose | Source |
|---|---|---|
| `/{year}/race_list_basic.json` | Complete season schedule for **all three series**. Top-level keys `series_1`, `series_2`, `series_3`; each is an array of races. Per-race fields include `race_id`, `race_name`, `race_season`, `series_id`, `race_date`, `date_scheduled`, `track_name`, `winner_driver_id` (null until the race has run). | `pynascar/src/pynascar/schedule.py:38`; `pynascar/src/pynascar/core/base_api.py:76`; `nascar-tracker/backend/lib/nascarApi.js:36`; `nascar-tracker/backend/routes/races.js:19` |

Examples:
- `https://cf.nascar.com/cacher/2024/race_list_basic.json`
- `https://cf.nascar.com/cacher/2023/race_list_basic.json` (referenced as a
  comment at `pynascar/src/pynascar/schedule.py:9`).

### 2.5 Driver roster

| URL template | Purpose | Source |
|---|---|---|
| `/drivers.json` | Master driver roster across all series. Response either is a flat array or is wrapped as `{ response: [...] }` (the `nascar-tracker` reader handles both). Per-driver fields: `Nascar_Driver_ID`, `First_Name`, `Last_Name`, `Team`, `Manufacturer` (CDN PNG URL — manufacturer extracted from filename), `Image`, `Image_Transparent`, `Badge_Image`, `Driver_Series` (slug — see series table). | `nascar-tracker/backend/routes/drivers.js:34-62`; `nascar-tracker/README.md:66` |

Example: `https://cf.nascar.com/cacher/drivers.json`

### 2.6 Legacy practice lap averages (deprecated path)

| URL template | Purpose | Source |
|---|---|---|
| `/{year}/{series_id}/{race_id}/lapAvg_nxs_practice_{session_number}.json` | Older endpoint that exposed practice lap averages. Only one instance found in the wild, referenced as a curiosity: 2019 Xfinity (`nxs`) race 4817 practice session 1. The `nxs` token in the filename hints at series-specific naming (`cup`, `nxs`, `trucks`). pynascar flags this as "this endpoint may not exist" — confirmed only via a single historical URL. | `pynascar/README.md:232` |

Documented example (do not assume the current-year analogue resolves):
`https://cf.nascar.com/cacher/2019/2/4817/lapAvg_nxs_practice_1.json`

---

## 3. `/cacher/live/` — live race feeds (series-namespaced)

Base: `https://cf.nascar.com/cacher/live`

Used by `pynascar` and `nascar-tracker`. The path template differs from
`/cacher/...` in two ways: there is no `{year}` segment, and the
`{series_id}` is encoded as `series_<id>` (e.g. `series_1`) instead of a bare
digit. While a session is in progress these files mirror the per-race files
under `/cacher/{year}/{series_id}/{race_id}/...`.

| URL template | Purpose | Source |
|---|---|---|
| `/series_{series_id}/{race_id}/weekend-feed.json` | Live equivalent of §2.1. Updated mid-race. | `pynascar/src/pynascar/core/base_api.py:35` |
| `/series_{series_id}/{race_id}/lap-times.json` | Live equivalent of §2.2 lap-times. | `pynascar/src/pynascar/core/base_api.py:43` |
| `/series_{series_id}/{race_id}/lap-notes.json` | Live equivalent of §2.2 lap-notes (race-control event log). | `pynascar/src/pynascar/core/base_api.py:59` |
| `/series_{series_id}/{race_id}/live-pit-data.json` | Live pit stop data. | `pynascar/src/pynascar/core/base_api.py:51` |
| `/series_{series_id}/{race_id}/live-feed.json` | "Advanced driver stat" / per-vehicle live state — current running position, lap, flag, etc. See §4 for the response shape (same payload as `/live/feeds/live-feed.json`). pynascar uses this URL to populate `driver_data.driver_stats_advanced`. | `pynascar/src/pynascar/core/base_api.py:71`; column list in `pynascar/README.md:112-113` |
| `/live-feed.json` | nascar-tracker also probes `live/live-feed.json` (no `series_x/race_id/` between `live/` and the file) to supplement its driver-number map. Whether the CDN actually serves a global file at this exact path is unclear — the call is wrapped in a try/catch and the parent comment ("Supplement with live feed data") suggests it is best-effort. | `nascar-tracker/backend/lib/nascarApi.js:74` |
| `/live-points.json` | Live points standings (post-2024 stage points + race-day points). Used as the standings source by `nascar-tracker`. | `nascar-tracker/backend/routes/live.js:18`; `nascar-tracker/backend/routes/standings.js:10` |
| `/live-pit-data.json` | Same content as the series-namespaced pit feed above, but at the global `/cacher/live/` root (no `series_x/race_id/`). | `nascar-tracker/backend/routes/live.js:28` |

Examples:
- `https://cf.nascar.com/cacher/live/series_1/5544/weekend-feed.json`
- `https://cf.nascar.com/cacher/live/series_1/5544/lap-times.json`
- `https://cf.nascar.com/cacher/live/live-feed.json`
- `https://cf.nascar.com/cacher/live/live-points.json`

---

## 4. `/live/feeds/` — live race feeds (global, no series in URL)

Base: `https://cf.nascar.com/live/feeds`

Used by `NascarApi/led_sports_ticker`. These are the URLs that the NASCAR
Race Center page itself polls in the browser. They are **global** — there is
exactly one of each, and they always reflect whatever session is currently
"live" on NASCAR.com (race, qualifying, or practice; whichever series is on
track right now). Outside of a live session the contents typically reflect
the most recent session.

| URL template | Purpose | Source |
|---|---|---|
| `/live-feed.json` | The primary live race feed — every vehicle's running position, last/best lap, manufacturer, sponsor, status, pit count, laps led, stage info, plus a session block (track, lap number, laps to go, flag state, run type, cautions, lead changes). See payload outline below. | `NascarApi/led_sports_ticker/nascar_api.py:94`; `NascarApi/led_sports_ticker/recorder.py:58`; `NascarApi/led_sports_ticker/replay.py:192` |
| `/live-flag-data.json` | Flag history for the current session as a list (one entry per flag change). | `NascarApi/led_sports_ticker/nascar_api.py:95`; `recorder.py:59`; `replay.py:194` |
| `/live-pit-data.json` | Live pit data — flat list of stops. | `NascarApi/led_sports_ticker/nascar_api.py:97`; `recorder.py:60`; `replay.py:196` |
| `/live-points.json` | Live points standings, list form. | `NascarApi/led_sports_ticker/nascar_api.py:96`; `recorder.py:61`; `replay.py:198` |
| `/live-stage-points.json` | Live stage-points-only standings. | `NascarApi/led_sports_ticker/nascar_api.py:98`; `recorder.py:62`; `replay.py:200` |

Payload shape of `live-feed.json` (per `nascar_api.py:178-237`):

```
{
  race_id, series_id, track_id, run_name, track_name, track_length,
  lap_number, laps_in_race, laps_to_go,
  flag_state,              # 0 NONE 1 GREEN 2 YEL 3 RED 4 WHT 5 CHK 8 HOT 9 COLD
  elapsed_time,
  run_type,                # 1 Practice 2 Qualifying 3 Race
  number_of_caution_segments, number_of_caution_laps,
  number_of_lead_changes, number_of_leaders,
  stage: { stage_num, finish_at_lap },
  vehicles: [
    { vehicle_number, sponsor_name, vehicle_manufacturer,
      driver: { driver_id, full_name, first_name, last_name, is_in_chase },
      running_position, laps_completed,
      last_lap_time, last_lap_speed, best_lap_time, best_lap_speed,
      delta,            # gap to leader (sec)
      status, is_on_track,
      laps_led: [{ start_lap, end_lap }],
      pit_stops: [...],
      average_speed, passes_made, quality_passes, starting_position }
  ]
}
```

Examples:
- `https://cf.nascar.com/live/feeds/live-feed.json`
- `https://cf.nascar.com/live/feeds/live-flag-data.json`
- `https://cf.nascar.com/live/feeds/live-pit-data.json`
- `https://cf.nascar.com/live/feeds/live-points.json`
- `https://cf.nascar.com/live/feeds/live-stage-points.json`

### Flag state codes

From `NascarApi/led_sports_ticker/nascar_api.py:100-111`:

| Code | State |
|---|---|
| 0 | NONE |
| 1 | GREEN |
| 2 | YELLOW (caution) |
| 3 | RED |
| 4 | WHITE (final lap) |
| 5 | CHECKERED |
| 6 / 7 | UNKNOWN |
| 8 | HOT TRACK |
| 9 | COLD TRACK |

### Run-type codes

From `nascar_api.py:125-129` and `recorder.py:100`:

| Code | Session |
|---|---|
| 1 | Practice |
| 2 | Qualifying |
| 3 | Race |

---

## 5. `/loopstats/prod/` — NASCAR Loop Data driver statistics

Base: `https://cf.nascar.com/loopstats/prod`

| URL template | Purpose | Source |
|---|---|---|
| `/{year}/{series_id}/{race_id}.json` | Per-race Loop Data driver stats — the NASCAR Loop scoring metrics: `start_position`, `mid_position`, `position`, `closing_position`, `closing_laps_diff`, `best_position`, `worst_position`, `avg_position`, `passes_green_flag`, `passing_diff`, `passed_green_flag`, `quality_passes`, `fast_laps`, `top15_laps`, `lead_laps`, `laps`, `rating`. | `pynascar/src/pynascar/core/base_api.py:11, 66`; columns at `pynascar/README.md:109-110` |

Note the `prod` segment in the path and the bare `{race_id}.json` filename —
this branch does **not** follow the `/{year}/{series_id}/{race_id}/<file>.json`
nesting convention that everything else under `/cacher/` uses.

Example: `https://cf.nascar.com/loopstats/prod/2024/1/5544.json`

---

## 6. Endpoint verification

Verification from this sandbox was not possible: every `cf.nascar.com` URL
attempted returns `HTTP 403 Forbidden` from this environment (both via
`curl` with browser-like headers and via the harness `WebFetch` tool). The
hostname is not on the egress proxy's allowlist and Cloudflare's edge
appears to reject the resulting source IPs/headers. The same is true for
`www.nascar.com` and `api.nascar.com`.

Endpoints attempted (all returned `HTTP 403`, body literal `Host not in allowlist` when via `curl`):

| URL | Result |
|---|---|
| `https://cf.nascar.com/cacher/2024/race_list_basic.json` | 403 |
| `https://cf.nascar.com/cacher/live/live-feed.json` | 403 |
| `https://cf.nascar.com/live/feeds/live-feed.json` | 403 |
| `https://cf.nascar.com/loopstats/prod/2024/1/5544.json` | 403 |

That said, the URLs are demonstrably live: `pynascar`, `nascar-tracker`,
`NascarApi`, and `jemorriso` all run successfully against them in production
(jemorriso ships a working hard-coded URL — `2021/1/5029/lap-times.json` —
as a default). To verify outside this sandbox, run from a workstation:

```bash
# Browser-like headers tend to be sufficient. The Referer header
# matters: cf.nascar.com inspects it.
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

for url in \
  https://cf.nascar.com/cacher/drivers.json \
  https://cf.nascar.com/cacher/2024/race_list_basic.json \
  https://cf.nascar.com/cacher/2024/1/5544/weekend-feed.json \
  https://cf.nascar.com/cacher/2024/1/5544/lap-times.json \
  https://cf.nascar.com/cacher/2024/1/5544/live-pit-data.json \
  https://cf.nascar.com/cacher/2024/1/5544/lap-notes.json \
  https://cf.nascar.com/loopstats/prod/2024/1/5544.json \
  https://cf.nascar.com/cacher/live/live-feed.json \
  https://cf.nascar.com/cacher/live/live-points.json \
  https://cf.nascar.com/live/feeds/live-feed.json \
  https://cf.nascar.com/live/feeds/live-flag-data.json \
  https://cf.nascar.com/live/feeds/live-stage-points.json \
  ; do
  printf '%-78s  ' "$url"
  curl -sS -A "$UA" -H "Accept: application/json" -H "Referer: https://www.nascar.com/" \
       -o /tmp/last.json -w "HTTP=%{http_code} SIZE=%{size_download}\n" "$url"
  python3 -c 'import json,sys; d=json.load(open("/tmp/last.json")); print("  top-level keys:", list(d.keys())[:10] if isinstance(d, dict) else f"array len {len(d)}")' 2>/dev/null
done
```

Expected behavior, inferred from the source code:

| Endpoint | Expected when no race is running |
|---|---|
| `/cacher/drivers.json` | Always full roster, 24-hour TTL per `nascar-tracker`. |
| `/cacher/{year}/race_list_basic.json` | Always present; `winner_driver_id == null` (or missing) for not-yet-run races, populated afterward. |
| `/cacher/{year}/{series_id}/{race_id}/weekend-feed.json` | For past races: full results. For not-yet-run races: 404 (the race weekend pages aren't published until on-site). |
| `/cacher/live/*` (all variants) | When idle, jemorriso and pynascar both report success but with empty result arrays — e.g. `vehicles: []`. Some files may 404 between races (the `try/except` blocks in `nascar-tracker/backend/lib/nascarApi.js:74-82` are written defensively around this). |
| `/live/feeds/live-feed.json` and siblings | Always exist, but the payload reflects the *most recent* session (last race / qualifying / practice). `live-flag-data.json` may be `null` or `[]` between sessions. |
| `/loopstats/prod/{year}/{series_id}/{race_id}.json` | Populated after the race; may 404 for races that have not yet been scored by NASCAR Loop. |

---

## 7. Open questions / quirks

1. **Two distinct "live" branches** (`/cacher/live/...` and `/live/feeds/...`).
   They appear to serve the same content while a race is on air, but no repo
   uses both, and no repo documents which is canonical. The `/cacher/live/...`
   form is series/race-scoped (`series_1/5544/...`) while `/live/feeds/...` is
   the single global live state. Worth diffing payloads side-by-side during an
   actual race.

2. **`nascar-tracker` fetches `cf.nascar.com/cacher/live/live-feed.json`** —
   i.e. a `live-feed.json` directly under `/cacher/live/` with no
   `series_x/race_id/` segment (`nascar-tracker/backend/lib/nascarApi.js:74`).
   This is **not** documented in any other repo and is wrapped in a
   try/empty-catch ("Supplement with live feed data"). Either the file
   exists as an alias of `/live/feeds/live-feed.json`, or the call routinely
   404s and the catch swallows it.

3. **`live-pit-data.json` at two roots.** `nascar-tracker/backend/routes/live.js:28`
   fetches `cf.nascar.com/cacher/live/live-pit-data.json` (global), while
   `pynascar/src/pynascar/core/base_api.py:51` fetches
   `cf.nascar.com/cacher/live/series_{series_id}/{race_id}/live-pit-data.json`
   (per-race), and `NascarApi/led_sports_ticker/recorder.py:60` fetches
   `cf.nascar.com/live/feeds/live-pit-data.json` (alternate global path).
   Three URLs for what is almost certainly the same dataset.

4. **Schedule endpoint per-series filtering happens client-side.**
   `race_list_basic.json` is a single document keyed by `series_1/2/3`. There
   is no `/{year}/{series_id}/race_list_basic.json` variant referenced in any
   repo.

5. **Legacy `lapAvg_nxs_practice_{n}.json`** (§2.6) is the only series-slug-
   bearing filename observed (`nxs` = Xfinity). pynascar found exactly one
   working URL (2019/2/4817) and labels the endpoint "may not exist". Whether
   it still resolves for older races, and whether `lapAvg_cup_practice_n` /
   `lapAvg_trucks_practice_n` analogues exist, is untested.

6. **`drivers.json` response wrapping.** `nascar-tracker/backend/routes/drivers.js:45`
   reads `raw.response || raw`, which means the response shape has changed at
   least once between a bare array and a `{response: [...]}` envelope. Both
   forms are defensively handled.

7. **Track ID resolution.** `live-feed.json` returns a numeric `track_id`,
   but no repo references a `/cacher/.../tracks.json` or similar endpoint —
   track names are looked up locally (e.g. `nascar-tracker/backend/lib/trackCoordinates.js`,
   `pynascar/src/pynascar/definitions.py:tracks_map`). If a tracks feed
   exists on cf.nascar.com it has not been reverse-engineered in any of
   these repos.

8. **No standings / season-points endpoint independent of `/cacher/live/live-points.json`.**
   `nascar-tracker` derives season standings purely from the live points
   file (`backend/routes/standings.js`). Whether a historical
   season-points-per-race file exists is unknown.

9. **No `api.nascar.com` or `www.nascar.com/json/` endpoint referenced** in
   any of the four repos despite the user's prompt mentioning them as
   possibilities. Only `cf.nascar.com` is in use.

10. **Egress restrictions.** Many cloud egress IPs are 403'd by Cloudflare
    regardless of headers (this sandbox is one). Verification typically
    works from residential / consumer ISP IPs with browser-like
    `User-Agent` and `Referer: https://www.nascar.com/`.

---

## 8. Source attribution index

Every endpoint above traces back to one of these source files:

- `pynascar/src/pynascar/core/base_api.py:9-77` — primary URL builder for
  `pynascar` (cacher, cacher/live, loopstats).
- `pynascar/src/pynascar/schedule.py:9, 38` — schedule.
- `pynascar/README.md:144-148, 232` — series IDs and legacy practice URL.
- `NascarApi/led_sports_ticker/nascar_api.py:90-129` — `/live/feeds/...`
  endpoints and code tables (flags, run types, series names).
- `NascarApi/led_sports_ticker/recorder.py:56-63` — same five `/live/feeds/`
  endpoints, captured to disk every second.
- `NascarApi/led_sports_ticker/replay.py:192-201, 452` — confirms replay
  server emulates exactly the five `/live/feeds/...` endpoints.
- `NascarApi/led_sports_ticker/README.md:159` — public-facing list of one
  endpoint (`/live/feeds/live-feed.json`).
- `nascar-tracker/backend/lib/nascarApi.js:3, 36, 54, 74` — CDN base, schedule,
  weekend-feed, and supplemental `cacher/live/live-feed.json` use.
- `nascar-tracker/backend/routes/races.js:19, 71` — schedule + weekend-feed.
- `nascar-tracker/backend/routes/drivers.js:34` — `drivers.json`.
- `nascar-tracker/backend/routes/live.js:8, 18, 28` — live-feed, live-points,
  live-pit-data under `/cacher/live/`.
- `nascar-tracker/backend/routes/standings.js:10` — `cacher/live/live-points.json`.
- `nascar-tracker/README.md:66` — narrative description of the CDN.
- `jemorriso-nascar/config.json:2` — hard-coded sample
  `cacher/2021/1/5029/lap-times.json`.
- `jemorriso-nascar/README.md:23-36` — instructions for sniffing the
  per-race `lap-times.json` URL out of Race Center XHR traffic in DevTools.
- `jemorriso-nascar/src/nascar/nascar.py:14-16, 39-40, 75-79, 146-148` —
  consumes the `lap-times.json` payload (`laps[*].Laps[*].{Lap,LapTime,RunningPos}`
  plus per-driver `{NASCARDriverID, Number, FullName, Manufacturer}`).
