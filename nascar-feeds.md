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
Endpoints were live-verified on **2026-05-14** with the `verify-nascar-feeds.sh`
script in this directory; see §6 for the actual probe results.

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
> reaches it via `/live/feeds/...` without any series or race in the path.
> **Verification (2026-05-14) shows they are byte-for-byte aliases at the
> global level:** `cf.nascar.com/cacher/live/live-feed.json` returned the
> same 490-byte payload as `cf.nascar.com/live/feeds/live-feed.json`, and
> `live-points.json` matched at 23 651 bytes across both paths. Likewise
> `cf.nascar.com/cacher/{year}/{series}/{race}/lap-times.json` and
> `cf.nascar.com/cacher/live/series_{series}/{race}/lap-times.json` returned
> identical 305 115-byte payloads. The series-namespaced live form survives
> in the cache once a race ends; the unnamespaced global form always reflects
> the most recent session.

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
| `/{year}/{series_id}/{race_id}/lap-times.json` | Per-driver per-lap timing. Top-level keys **verified 2026-05-14**: `laps` (array of `{ NASCARDriverID, Number, FullName, Manufacturer, Laps: [{ Lap, LapTime, RunningPos }] }`) **and** `flags` (a green/yellow/red ledger that none of the four repos consume). | `pynascar/src/pynascar/core/base_api.py:45`; `jemorriso-nascar/config.json:2`; `jemorriso-nascar/src/nascar/nascar.py:39-40,75-79` |
| `/{year}/{series_id}/{race_id}/lap-notes.json` | Race-control event log (the "events" feed): flag changes, warm-up notes, free-text comments per lap. Verified response: single-key `{ laps: [...] }`. Columns post-processing: `Lap`, `Flag_State`, `Flag`, `note`, `driver_ids`. | `pynascar/src/pynascar/core/base_api.py:61`; `pynascar/README.md:185-191` |

Examples:
- `https://cf.nascar.com/cacher/2024/1/5544/lap-times.json`
- `https://cf.nascar.com/cacher/2024/1/5544/lap-notes.json`
- jemorriso ships a hard-coded known-good URL: `https://cf.nascar.com/cacher/2021/1/5029/lap-times.json` (2021 Daytona 500, Cup).

### 2.3 Pit data

| URL template | Purpose | Source |
|---|---|---|
| `/{year}/{series_id}/{race_id}/live-pit-data.json` | Per-stop pit timing — pit-in/out flag state, box stop/leave race time, tire changes per corner, pit-stop type, positions gained/lost, in/out travel duration. Note the `live-` prefix even when fetched from the historical `/cacher/` path. **2026-05-14 verification returned HTTP 403** for `cacher/2026/1/5593/live-pit-data.json` — see §7 open question #11; this endpoint may not be published immediately after every race. | `pynascar/src/pynascar/core/base_api.py:53`; columns documented at `pynascar/README.md:102-103` |

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
| `/drivers.json` | Master driver roster across all series. **Verified 2026-05-14:** response is wrapped as `{ status, message, response: [...] }`; the driver array is in `response`. (`nascar-tracker/backend/routes/drivers.js:45` defensively reads `raw.response \|\| raw` to handle both this envelope and an older bare-array shape.) Per-driver fields: `Nascar_Driver_ID`, `First_Name`, `Last_Name`, `Team`, `Manufacturer` (CDN PNG URL — manufacturer extracted from filename), `Image`, `Image_Transparent`, `Badge_Image`, `Driver_Series` (slug — see series table). | `nascar-tracker/backend/routes/drivers.js:34-62`; `nascar-tracker/README.md:66` |

Example: `https://cf.nascar.com/cacher/drivers.json`

### 2.6 Legacy practice lap averages (deprecated path)

| URL template | Purpose | Source |
|---|---|---|
| `/{year}/{series_id}/{race_id}/lapAvg_nxs_practice_{session_number}.json` | Older endpoint that exposed practice lap averages. The `nxs` token in the filename hints at series-specific naming (`cup`, `nxs`, `trucks`); the `_n` is the practice session index. **Verified 2026-05-14: the 2019 Xfinity reference still returns HTTP 200 (12 262 bytes, an array of 30 driver entries with keys `Number, NASCARDriverID, Driver, FullName, Manufacturer, Sponsor`).** Whether current-year analogues are published is untested. | `pynascar/README.md:232` |

Verified live (2026-05-14):
`https://cf.nascar.com/cacher/2019/2/4817/lapAvg_nxs_practice_1.json` →
`HTTP 200`, 12 262 B, array of 30 items.

---

## 3. `/cacher/live/` — live race feeds (series-namespaced)

Base: `https://cf.nascar.com/cacher/live`

Used by `pynascar` and `nascar-tracker`. The path template differs from
`/cacher/...` in two ways: there is no `{year}` segment, and the
`{series_id}` is encoded as `series_<id>` (e.g. `series_1`) instead of a bare
digit. While a session is in progress these files mirror the per-race files
under `/cacher/{year}/{series_id}/{race_id}/...`.

| URL template | Purpose | Verified 2026-05-14 (race 5593) | Source |
|---|---|---|---|
| `/series_{series_id}/{race_id}/weekend-feed.json` | Live equivalent of §2.1. Updated mid-race. | **403** (after race ended) | `pynascar/src/pynascar/core/base_api.py:35` |
| `/series_{series_id}/{race_id}/lap-times.json` | Live equivalent of §2.2 lap-times. | **200** — 305 115 B, byte-identical to `cacher/2026/1/5593/lap-times.json`. The series-namespaced live form is preserved in the CDN after the race. | `pynascar/src/pynascar/core/base_api.py:43` |
| `/series_{series_id}/{race_id}/lap-notes.json` | Live equivalent of §2.2 lap-notes (race-control event log). | **403** (after race ended) | `pynascar/src/pynascar/core/base_api.py:59` |
| `/series_{series_id}/{race_id}/live-pit-data.json` | Live pit stop data. | **403** (after race ended) | `pynascar/src/pynascar/core/base_api.py:51` |
| `/series_{series_id}/{race_id}/live-feed.json` | "Advanced driver stat" / per-vehicle live state — current running position, lap, flag, etc. See §4 for the response shape (same payload as `/live/feeds/live-feed.json`). pynascar uses this URL to populate `driver_data.driver_stats_advanced`. | **200** — 18 777 B; keys include `lap_number, elapsed_time, flag_state, race_id, run_id, laps_in_race, laps_to_go, vehicles, …` (+14 more). This is the final-frame snapshot the CDN keeps after the race. | `pynascar/src/pynascar/core/base_api.py:71`; column list in `pynascar/README.md:112-113` |
| `/live-feed.json` | Global live feed at the `/cacher/live/` root (no `series_x/race_id/`). **Confirmed live 2026-05-14** — returns the same 490-byte payload as `/live/feeds/live-feed.json`, demonstrating the two paths are aliases. | **200** — 490 B, same keys as the series-namespaced live-feed. | `nascar-tracker/backend/lib/nascarApi.js:74` |
| `/live-points.json` | Live points standings (post-2024 stage points + race-day points). Used as the standings source by `nascar-tracker`. | **200** — 23 651 B, array of 46 items with keys `bonus_points, car_number, delta_leader, delta_next, first_name, driver_id, …`. Byte-identical to `/live/feeds/live-points.json`. | `nascar-tracker/backend/routes/live.js:18`; `nascar-tracker/backend/routes/standings.js:10` |
| `/live-pit-data.json` | Same content as the series-namespaced pit feed above, but at the global `/cacher/live/` root (no `series_x/race_id/`). | **200** — empty array (no live race in progress at probe time). | `nascar-tracker/backend/routes/live.js:28` |

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

| URL template | Purpose | Verified 2026-05-14 (no race in progress) | Source |
|---|---|---|---|
| `/live-feed.json` | The primary live race feed — every vehicle's running position, last/best lap, manufacturer, sponsor, status, pit count, laps led, stage info, plus a session block (track, lap number, laps to go, flag state, run type, cautions, lead changes). See payload outline below. | **200** — 490 B (idle / between sessions); keys: `lap_number, elapsed_time, flag_state, race_id, run_id, laps_in_race, laps_to_go, vehicles, …` (+14 more). Identical payload to `/cacher/live/live-feed.json`. | `NascarApi/led_sports_ticker/nascar_api.py:94`; `NascarApi/led_sports_ticker/recorder.py:58`; `NascarApi/led_sports_ticker/replay.py:192` |
| `/live-flag-data.json` | Flag history for the current session as a list (one entry per flag change). | **200** — empty array `[]` while idle. | `NascarApi/led_sports_ticker/nascar_api.py:95`; `recorder.py:59`; `replay.py:194` |
| `/live-pit-data.json` | Live pit data — flat list of stops. | **200** — empty array `[]` while idle. | `NascarApi/led_sports_ticker/nascar_api.py:97`; `recorder.py:60`; `replay.py:196` |
| `/live-points.json` | Live points standings, list form. | **200** — 23 651 B, array of 46 entries (Cup-series season-points snapshot). Byte-identical to `/cacher/live/live-points.json`. | `NascarApi/led_sports_ticker/nascar_api.py:96`; `recorder.py:61`; `replay.py:198` |
| `/live-stage-points.json` | Live stage-points-only standings. | **200** — 8 950 B, array of 2 (one entry per stage), item keys `race_id, run_id, stage_number, results`. | `NascarApi/led_sports_ticker/nascar_api.py:98`; `recorder.py:62`; `replay.py:200` |

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
| `/{year}/{series_id}/{race_id}.json` | Per-race Loop Data driver stats — the NASCAR Loop scoring metrics: `start_position`, `mid_position`, `position`, `closing_position`, `closing_laps_diff`, `best_position`, `worst_position`, `avg_position`, `passes_green_flag`, `passing_diff`, `passed_green_flag`, `quality_passes`, `fast_laps`, `top15_laps`, `lead_laps`, `laps`, `rating`. **Verified 2026-05-14: the response is a single-element JSON array, not a bare object** — `[{ race_id, race_name, series_id, sch_laps, act_laps, drivers: [...] }]`. The per-driver stats list lives in `drivers`. | `pynascar/src/pynascar/core/base_api.py:11, 66`; columns at `pynascar/README.md:109-110` |

Note the `prod` segment in the path and the bare `{race_id}.json` filename —
this branch does **not** follow the `/{year}/{series_id}/{race_id}/<file>.json`
nesting convention that everything else under `/cacher/` uses.

Example: `https://cf.nascar.com/loopstats/prod/2024/1/5544.json`

---

## 6. Endpoint verification (2026-05-14)

Probed with `verify-nascar-feeds.sh` from a residential connection, sending
`User-Agent: Mozilla/5.0 … Chrome/124.0 …` and `Referer: https://www.nascar.com/`.
Parameters: `year=2026`, `series_id=1` (Cup), `race_id=5593` (auto-discovered:
first completed Cup race of the 2026 season, per `race_list_basic.json`).
**No race was in progress at probe time** — live feeds therefore reflect the
idle / between-sessions state.

### `/cacher/` branch

| URL | HTTP | Size | Top-level shape |
|---|---|---|---|
| `cacher/2026/race_list_basic.json` | 200 | 189 511 | `{series_1, series_2, series_3}` |
| `cacher/drivers.json` | 200 | 1 390 912 | `{status, message, response}` (driver array in `response`) |
| `cacher/2026/1/5593/weekend-feed.json` | 200 | 50 025 | `{weekend_race, weekend_runs}` |
| `cacher/2026/1/5593/lap-times.json` | 200 | 305 115 | `{laps, flags}` |
| `cacher/2026/1/5593/lap-notes.json` | 200 | 13 924 | `{laps}` |
| `cacher/2026/1/5593/live-pit-data.json` | **403** | 243 | (Cloudflare error body) — see open question #11 |
| `cacher/2019/2/4817/lapAvg_nxs_practice_1.json` | 200 | 12 262 | array len=30, item keys `{Number, NASCARDriverID, Driver, FullName, Manufacturer, Sponsor}` — **legacy endpoint still alive** |

### `/cacher/live/` branch — series-namespaced

| URL | HTTP | Size | Top-level shape |
|---|---|---|---|
| `cacher/live/series_1/5593/weekend-feed.json` | **403** | 263 | — |
| `cacher/live/series_1/5593/lap-times.json` | 200 | 305 115 | `{laps, flags}` (byte-identical to `cacher/2026/1/5593/lap-times.json` — confirmed alias) |
| `cacher/live/series_1/5593/lap-notes.json` | **403** | 243 | — |
| `cacher/live/series_1/5593/live-pit-data.json` | **403** | 243 | — |
| `cacher/live/series_1/5593/live-feed.json` | 200 | 18 777 | `{lap_number, elapsed_time, flag_state, race_id, run_id, laps_in_race, laps_to_go, vehicles, …}` (22 keys; full final-frame snapshot) |

### `/cacher/live/` branch — global (no series/race in URL)

| URL | HTTP | Size | Top-level shape |
|---|---|---|---|
| `cacher/live/live-feed.json` | 200 | 490 | same 22 keys as above (small payload because idle / empty vehicle list) |
| `cacher/live/live-points.json` | 200 | 23 651 | array len=46, item keys `{bonus_points, car_number, delta_leader, delta_next, first_name, driver_id, …}` |
| `cacher/live/live-pit-data.json` | 200 | 2 | empty array `[]` |

### `/live/feeds/` branch

| URL | HTTP | Size | Top-level shape |
|---|---|---|---|
| `live/feeds/live-feed.json` | 200 | 490 | same 22 keys; **byte-identical to `cacher/live/live-feed.json`** |
| `live/feeds/live-flag-data.json` | 200 | 2 | empty array `[]` |
| `live/feeds/live-pit-data.json` | 200 | 2 | empty array `[]` |
| `live/feeds/live-points.json` | 200 | 23 651 | array len=46; **byte-identical to `cacher/live/live-points.json`** |
| `live/feeds/live-stage-points.json` | 200 | 8 950 | array len=2 (one entry per stage), item keys `{race_id, run_id, stage_number, results}` |

### `/loopstats/prod/` branch

| URL | HTTP | Size | Top-level shape |
|---|---|---|---|
| `loopstats/prod/2026/1/5593.json` | 200 | 6 332 | array len=1, item keys `{race_id, race_name, series_id, sch_laps, act_laps, drivers}` — **note: returns an array, not a single object** |

### Idle-state behavior summary

| Endpoint family | Behavior between races |
|---|---|
| `/cacher/drivers.json` | Always full roster. |
| `/cacher/{year}/race_list_basic.json` | Always present; `winner_driver_id` is null/missing for not-yet-run races. |
| `/cacher/{year}/{series}/{race}/*` | For past races: full results (verified above). For future races: expect 404. `live-pit-data.json` may 403 (see open question #11). |
| `/cacher/live/series_X/{race}/*` (post-race) | `lap-times.json` and `live-feed.json` survive; `weekend-feed.json`, `lap-notes.json`, `live-pit-data.json` all 403 once the live session is over. The `/cacher/{year}/…` mirror is the durable archive. |
| `/cacher/live/*` and `/live/feeds/*` (global) | Always 200. Empty arrays (`[]`) for flag/pit feeds when idle; minimal payload for `live-feed.json` (lap_number=0, vehicles=[]); standings carry the latest season totals. |
| `/loopstats/prod/{year}/{series}/{race}.json` | Populated after race scoring; expect 403/404 for not-yet-scored races. |

To re-verify, run `./verify-nascar-feeds.sh` (autodetect) or pass explicit
parameters, e.g. `./verify-nascar-feeds.sh 2024 1 5544`. The script uses
only `curl` and Python 3 (no third-party deps) and handles Windows'
`python3` → `python` → `py -3` interpreter resolution automatically.

---

## 7. Open questions / quirks

Items resolved by the 2026-05-14 verification are marked **[resolved]**.

1. **[resolved] Two distinct "live" branches** — `/cacher/live/live-feed.json`
   and `/live/feeds/live-feed.json` are **byte-for-byte aliases** (both 490 B
   in this probe; same 22 top-level keys). Likewise `live-points.json` is
   identical at 23 651 B across the two roots. They are the same files served
   under two paths.

2. **[resolved] `nascar-tracker`'s use of `cacher/live/live-feed.json`** is a
   real, supported endpoint — not a try/catch curiosity. It returns the same
   payload as `/live/feeds/live-feed.json`.

3. **[resolved] `live-pit-data.json` at three roots** — global paths
   (`/cacher/live/live-pit-data.json`, `/live/feeds/live-pit-data.json`) both
   work and return identical empty arrays when idle. The per-race
   series-namespaced path (`/cacher/live/series_{n}/{race}/live-pit-data.json`)
   returns **403 after the race ends**; it apparently exists only during the
   live session window.

4. **Schedule endpoint per-series filtering happens client-side.**
   `race_list_basic.json` is a single document keyed by `series_1/2/3`. No
   per-series schedule URL is referenced in any repo, and no narrower variant
   was probed.

5. **[resolved] Legacy `lapAvg_nxs_practice_{n}.json`** — the 2019 Xfinity
   reference is **still live in 2026** (HTTP 200, 12 262 bytes, array of 30
   driver entries). Whether `lapAvg_cup_practice_n` and `lapAvg_trucks_practice_n`
   filename analogues exist, and whether current-year practice sessions are
   published under this filename pattern, is still untested.

6. **[resolved] `drivers.json` response wrapping.** Confirmed envelope as of
   2026-05-14: `{ status, message, response: [...] }`. `nascar-tracker`'s
   `raw.response || raw` fallback handles both this current shape and an
   older bare-array form.

7. **Track ID resolution.** `live-feed.json` returns a numeric `track_id`, but
   no repo references a `/cacher/.../tracks.json` or similar endpoint — track
   names are looked up locally (`nascar-tracker/backend/lib/trackCoordinates.js`,
   `pynascar/src/pynascar/definitions.py:tracks_map`). If a tracks feed
   exists on cf.nascar.com it has not been reverse-engineered in any of these
   repos.

8. **No standings / season-points endpoint independent of `live-points.json`.**
   `nascar-tracker` derives season standings purely from the live points file
   (`backend/routes/standings.js`). The 23 651-byte payload observed contains
   46 driver entries with `bonus_points`, `delta_leader`, `delta_next`, etc.
   — sufficient for full standings. Whether a per-race historical points file
   exists is unknown.

9. **No `api.nascar.com` or `www.nascar.com/json/` endpoint referenced** in
   any of the four repos despite the user's prompt mentioning them. Only
   `cf.nascar.com` is in use.

10. **Cloudflare egress sensitivity.** Many datacenter IPs receive 403 from
    Cloudflare regardless of headers. Verification typically works from a
    residential / consumer ISP IP with a browser-like `User-Agent` and
    `Referer: https://www.nascar.com/` (this combination succeeded for the
    2026-05-14 probe). Adding `Accept-Language` may help marginal cases.

11. **[new] `/cacher/{year}/{series}/{race}/live-pit-data.json` returned 403**
    for race 5593 (a completed Cup race, with weekend-feed/lap-times/lap-notes
    all returning 200). Either (a) NASCAR doesn't publish pit data archives
    for every race, (b) it's published under a different filename
    post-race (the `live-` prefix is suspicious — there may be a separate
    archival `pit-data.json`), or (c) it lags the other archives. pynascar
    nevertheless treats this URL as the historical pit source
    (`base_api.py:53`). Worth retrying on multiple races and checking whether
    `/cacher/{year}/{series}/{race}/pit-data.json` (no `live-` prefix) exists.

12. **[new] `loopstats/prod/{year}/{series}/{race}.json` returns a
    single-element JSON array, not a bare object.** The race metadata
    (`race_id, race_name, series_id, sch_laps, act_laps`) and the per-driver
    stats list (`drivers`) all sit inside the array's only element.
    pynascar's `process_data.process_driver_data` evidently strips that outer
    array before iterating; any new consumer needs to do the same.

13. **[new] `lap-times.json` has a top-level `flags` key alongside `laps`.**
    None of the four repos consume `flags` (they get flag data either from
    `lap-notes.json` or from `live-flag-data.json`). It's a free,
    pre-correlated flag-state-per-lap stream worth investigating.

14. **[new] `live-feed.json` has a top-level `run_id`** in addition to
    `race_id`. The same `run_id` appears inside `live-stage-points.json`
    items. `run_id` looks like an identifier for the specific session
    (practice 1 / practice 2 / qualifying / race) within the race weekend —
    distinct from `race_id`, which is the weekend itself. Not consumed by
    any of the four repos.

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
