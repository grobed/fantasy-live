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
| `/cacher/...` | Historical and per-race static data, **and** the schedule, drivers, and tracks tables. | pynascar (`base_api.py:9`), nascar-tracker (`nascarApi.js:3`), jemorriso (`config.json:2`), pynascar (`schedule.py:38`), NascarApi (`NewEndpointsDiscovered.MD`) |
| `/cacher/live/...` | Live in-race feeds, namespaced by `series_<id>/<race_id>/`. | pynascar (`base_api.py:10`), nascar-tracker (`nascarApi.js:74`, `live.js:8/18/28`), NascarApi (`LivePitData`) |
| `/live/feeds/...` | Live in-race feeds. Mostly *global* (no series/race in URL — always reflects the "current" session), with one series-namespaced variant: `live/feeds/series_{series}/{race}/live_points.json` (note the **underscore** in the filename — see §4). | NascarApi (`nascar_api.py:94-98`, `recorder.py:58-62`, `LivePointsData`) |
| `/loopstats/prod/...` | NASCAR Loop Data driver statistics. | pynascar (`base_api.py:11`, `base_api.py:66`), NascarApi (`LoopStats`, `NewEndpointsDiscovered.MD`) |

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
| `/{year}/{series_id}/{race_id}/lap-times.json` | Per-driver per-lap timing. Top-level keys **verified 2026-05-14**: `laps` (array of `{ NASCARDriverID, Number, FullName, Manufacturer, RunningPos, Laps: [{ Lap, LapTime, LapSpeed, RunningPos }] }`) **and** `flags` (a green/yellow/red ledger that none of the four repos consume). `NascarApi/LapTimes` schema confirms the per-`Lap` `LapSpeed` field that pynascar does not expose. | `pynascar/src/pynascar/core/base_api.py:45`; `jemorriso-nascar/config.json:2`; `jemorriso-nascar/src/nascar/nascar.py:39-40,75-79`; `NascarApi/LapTimes` |
| `/{year}/{series_id}/{race_id}/lap-notes.json` | Race-control event log (the "events" feed): flag changes, warm-up notes, free-text comments per lap. Verified response: single-key `{ laps: { "<lap_number>": [{ FlagState, Note, NoteID, DriverIDs[] }] } }` per `NascarApi/LapNotes.MD`. The outer `laps` is a **map keyed by lap number** (as a string), not an array. pynascar post-process columns: `Lap`, `Flag_State`, `Flag`, `note`, `driver_ids`. | `pynascar/src/pynascar/core/base_api.py:61`; `pynascar/README.md:185-191`; `NascarApi/LapNotes.MD` |

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
| `/{year}/race_list_basic.json` | Complete season schedule for **all three series**. Top-level keys `series_1`, `series_2`, `series_3`; each is an array of races. Per-race fields (from `NascarApi/RaceListBasic`): `race_id`, `series_id`, `race_season`, `race_name`, `race_type_id`, `restrictor_plate`, `track_id`, `track_name`, `date_scheduled`, `race_date`, `qualifying_date`, `tunein_date`, `scheduled_distance`, `actual_distance`, `scheduled_laps`, `actual_laps`, `stage_1_laps`, `stage_2_laps`, `stage_3_laps`, `number_of_cars_in_field`, `pole_winner_driver_id`, `pole_winner_speed`, `pole_winner_laptime`, `number_of_lead_changes`, `number_of_leaders`, `number_of_cautions`, `number_of_caution_laps`, `average_speed`, `total_race_time`, `margin_of_victory`, `race_purse`, `race_comments`, `attendance`, `infractions[]`, `schedule[]` (per-event `{event_name, notes, start_time_utc, run_type}` — useful for practice/qualifying timing), `radio_broadcaster`, `television_broadcaster`, `satellite_radio_broadcaster`, `master_race_id`, `inspection_complete`, `playoff_round`, `is_qualifying_race`, `qualifying_race_no`, `qualifying_race_id`, `has_qualifying`, `winner_driver_id` (null until raced). **Race IDs are NOT sequential** (per `NascarApi/WeekendFeed.MD`). | `pynascar/src/pynascar/schedule.py:38`; `pynascar/src/pynascar/core/base_api.py:76`; `nascar-tracker/backend/lib/nascarApi.js:36`; `nascar-tracker/backend/routes/races.js:19`; `NascarApi/RaceListBasic` |

Examples:
- `https://cf.nascar.com/cacher/2024/race_list_basic.json`
- `https://cf.nascar.com/cacher/2023/race_list_basic.json` (referenced as a
  comment at `pynascar/src/pynascar/schedule.py:9`).

### 2.5 Driver roster

| URL template | Purpose | Source |
|---|---|---|
| `/drivers.json` | Master driver roster across all series. **Verified 2026-05-14:** response is wrapped as `{ status, message, response: [...] }`; the driver array is in `response`. (`nascar-tracker/backend/routes/drivers.js:45` defensively reads `raw.response \|\| raw` to handle both this envelope and an older bare-array shape.) Per-driver fields: `Nascar_Driver_ID`, `First_Name`, `Last_Name`, `Team`, `Manufacturer` (CDN PNG URL — manufacturer extracted from filename), `Image`, `Image_Transparent`, `Badge_Image`, `Driver_Series` (slug — see series table). | `nascar-tracker/backend/routes/drivers.js:34-62`; `nascar-tracker/README.md:66` |

Example: `https://cf.nascar.com/cacher/drivers.json`

### 2.6 Tracks database

| URL template | Purpose | Source |
|---|---|---|
| `/tracks.json` | Complete database of **49 NASCAR tracks**. Response wrapped as `{ items: [...] }`. Per-track fields: `track_id`, `track_name`, `track_surface` (Asphalt/Concrete/Dirt), `track_type` (Short Track / Intermediate / Superspeedway / Road Course), `track_banking` (banking degrees per turn/straight), `year_built`, `track_description`, `city`, `state`, `frontstretch_length`, `backstretch_length`, `seating_capacity`, `capacity`, `track_owner`, `races`, `length` (miles), `zip`, `address`, `caution_car_speed`, `track_image`, `track_image_thumbnail`, `track_logo`, `track_major_events`, `track_num_turns`, `tickets_url`, `tickets_url_new_window`, `track_url`, `track_url_new_window`, `hide_track_from_site`. **This is the missing piece for resolving the numeric `track_id` returned by `live-feed.json`.** | `NascarApi/NewEndpointsDiscovered.MD:109-144` |

Example: `https://cf.nascar.com/cacher/tracks.json`

### 2.7 Legacy practice lap averages (deprecated path)

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
| `/series_{series_id}/{race_id}/live-pit-data.json` | Live pit stop data. Survives in the CDN for *some* completed races but not all — the 2023 Xfinity race 5314 (`cacher/live/series_2/5314/live-pit-data.json`) returns 200, but the 2026 Daytona 500 (Cup race 5593) returned 403. | **403** for race 5593 / **200** for race 5314 (user-reported) — see open question #11 | `pynascar/src/pynascar/core/base_api.py:51` |
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
| `/live-stage-points.json` | Live stage-points-only standings. | **200** — 8 950 B, array of 2 (one entry per stage), item keys `race_id, run_id, stage_number, results`. `results[]` items: `{position, vehicle_number, driver_id, full_name, stage_points}`. | `NascarApi/led_sports_ticker/nascar_api.py:98`; `recorder.py:62`; `replay.py:200`; `NascarApi/NewEndpointsDiscovered.MD:7-23` |
| `/series_{series_id}/{race_id}/live_points.json` | **Series-namespaced live points feed under `/live/feeds/`** — referenced only in `NascarApi/LivePointsData`. Note the **underscore in the filename** (`live_points.json`, not `live-points.json` with a hyphen) and that this is the only `/live/feeds/...` URL with a series/race in the path. **Verified 2026-05-14 as a distinct dataset from the global `live-points.json`:** 31 312 bytes / 61 entries vs the global feed's 23 651 bytes / 46 entries. Same item-level keys (`bonus_points, car_number, delta_leader, delta_next, first_name, driver_id, …`) but more rows — most likely the full race-day points roster (every driver who started race 5593) versus the global feed's season top-46. | **200** — 31 312 B, array of **61** items (cf. 46 for the global `live-points.json`). | `NascarApi/LivePointsData` |

Payload shape of `live-feed.json` (per `nascar_api.py:178-237` and the
field-by-field tables in `NascarApi/LiveFeed.MD` and
`NascarApi/NewEndpointsDiscovered.MD:147-211`):

```
{
  race_id, run_id, run_name, series_id, run_type,        # session identity
  track_id, track_name, track_length,
  lap_number, laps_in_race, laps_to_go,                  # race state
  flag_state,              # 0 NONE 1 GREEN 2 YEL 3 RED 4 WHT 5 CHK 8 HOT 9 COLD
  elapsed_time, time_of_day, time_of_day_os,             # timing (ISO + secs)
  number_of_caution_segments, number_of_caution_laps,
  number_of_lead_changes, number_of_leaders,
  avg_diff_1to3,                                          # gap between P1-P3
  stage: { stage_num, finish_at_lap, laps_in_stage },
  vehicles: [
    { vehicle_number, vehicle_manufacturer, sponsor_name, # identity
      driver: { driver_id, full_name, first_name, last_name, is_in_chase },
      running_position, starting_position, status,
      is_on_track, is_on_dvp,                             # DVP = damaged vehicle policy
      laps_completed, vehicle_elapsed_time,
      last_lap_time, last_lap_speed,
      best_lap, best_lap_time, best_lap_speed,
      average_running_position, average_speed,
      average_restart_speed, fastest_laps_run, laps_position_improved,
      delta,                                              # gap to leader (sec)
      passes_made, times_passed, passing_differential, quality_passes,
      position_differential_last_10_percent,
      qualifying_status,
      laps_led: [{ start_lap, end_lap }],
      pit_stops: [...] }
  ]
}
```

`live-flag-data.json` per-entry fields (from `NascarApi/LiveFlagData.MD`):

```
[
  { lap_number,                          # lap the flag was thrown
    flag_state,                          # see flag-state table above
    elapsed_time,                        # seconds since start of race
    beneficiary,                         # purpose unconfirmed
    comment,                             # has stage information
    time_of_day,                         # seconds since midnight
    time_of_day_os }                     # Zulu / ISO timestamp
]
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
| `/{year}/{series_id}/{race_id}.json` | Per-race Loop Data driver stats. **Verified 2026-05-14: response is a single-element JSON array** — `[{ race_id, race_name, series_id, sch_laps, act_laps, drivers: [...] }]`. The per-driver list is in `drivers`. **Raw JSON keys (per `NascarApi/NewEndpointsDiscovered.MD:220-237`)** are abbreviated: `driver_id`, `start_ps`, `mid_ps`, `ps`, `closing_ps`, `closing_laps_diff`, `best_ps`, `worst_ps`, `avg_ps`, `passes_gf`, `passing_diff`, `passed_gf`, `quality_passes`, `fast_laps`, `top15_laps`, `lead_laps`, `laps`, `rating`. pynascar renames these to `start_position`, `mid_position`, `position`, etc. when building the DataFrame. | `pynascar/src/pynascar/core/base_api.py:11, 66`; columns at `pynascar/README.md:109-110`; raw JSON keys at `NascarApi/NewEndpointsDiscovered.MD:220-237`; `NascarApi/LoopStats` |

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
| `cacher/tracks.json` | 200 | 55 311 | `{items: [...]}` (49 tracks) |
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
| `live/feeds/series_1/5593/live_points.json` | 200 | 31 312 | array len=**61** (cf. 46 for global `live-points.json`); same item-level keys — **not** an alias of the global feed |

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
| `/cacher/live/series_X/{race}/*` (post-race) | `lap-times.json` and `live-feed.json` reliably survive in the CDN. `weekend-feed.json` and `lap-notes.json` returned 403 for race 5593. `live-pit-data.json` is **race-specific**: returned 200 for 2023 Xfinity race 5314 but 403 for the 2026 Daytona 500. The `/cacher/{year}/…` mirror is the more durable archive for the file types it covers. |
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

3. **[partially resolved] `live-pit-data.json` at three roots** — global
   paths (`/cacher/live/live-pit-data.json`, `/live/feeds/live-pit-data.json`)
   both work and return identical empty arrays when idle. The per-race
   series-namespaced path
   (`/cacher/live/series_{n}/{race}/live-pit-data.json`) is **inconsistent
   across races**: it returned 200 for the 2023 Xfinity race 5314 but 403 for
   the 2026 Cup race 5593. Hypotheses below (see #11).

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

7. **[resolved] Track ID resolution.** `cf.nascar.com/cacher/tracks.json`
   exists and is the canonical lookup table for the `track_id` returned by
   `live-feed.json` — 49 entries with banking, length, surface, capacity,
   etc. Documented in `NascarApi/NewEndpointsDiscovered.MD:109-144` but not
   consumed by any of the four codebases (they all keep local lookup tables).

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

11. **[ongoing] `live-pit-data.json` availability is race-specific.**
    Confirmed working: `cacher/live/series_2/5314/live-pit-data.json` (2023
    Xfinity, returns 200). Confirmed 403: `cacher/2026/1/5593/live-pit-data.json`
    *and* `cacher/live/series_1/5593/live-pit-data.json` (2026 Cup Daytona
    500). So pit data is published at the series-namespaced `cacher/live/`
    path for at least some completed races — pynascar's choice of this URL
    (`base_api.py:51`) is correct, but coverage isn't 100%. Possible
    explanations:
    - **Age/cache:** older races stay warm in the cache; very recent races may
      not have been backfilled when probed.
    - **Race-specific publishing gaps:** the Daytona 500 is sometimes
      red-flagged for rain or run on a Monday; NASCAR's data feeds have a
      history of being patchy for rain-affected races.
    - **Filename variants:** an archival `pit-data.json` (no `live-` prefix)
      may also exist for races where `live-pit-data.json` was never
      finalized — none of the four repos reference such a filename.
    Worth re-running the verification against several older Cup races
    (e.g. `./verify-nascar-feeds.sh 2024 1 5544`) and a few rain-affected
    races to triangulate. The `cacher/{year}/{series}/{race}/live-pit-data.json`
    path appears to share the same coverage gaps as its
    `cacher/live/series_X/{race}/` sibling.

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
    distinct from `race_id`, which is the weekend itself. The
    `race_list_basic.json` per-race `schedule[]` array contains a per-event
    `run_type` (`{event_name, notes, start_time_utc, run_type}`) which
    cross-references this.

15. **[partially resolved] Filename naming inconsistency on `/live/feeds/`.**
    The series-namespaced URL on this branch
    (`live/feeds/series_{series}/{race}/live_points.json`, per
    `NascarApi/LivePointsData`) uses an **underscore** in the filename,
    whereas every other live points URL uses a hyphen
    (`live-points.json`). The underscored URL **is real** (verified
    2026-05-14, 200, 31 312 B) and serves a **larger 61-row dataset** than
    the global 46-row hyphenated `live-points.json` — so it's a distinct
    endpoint, not a typo. Open: what exactly distinguishes the 15 extra
    rows? Probably non-top-46 / non-points-eligible drivers who still
    competed in the race. Worth diffing the two payloads.

16. **[new] `tracks.json` is not consumed by any of the four repos.** Each
    keeps its own local track table (e.g.
    `nascar-tracker/backend/lib/trackCoordinates.js`,
    `pynascar/src/pynascar/definitions.py:tracks_map`). The 49-track CDN
    table would be the right source of truth for surface/banking/length
    lookups in new code.

17. **[new] Reference race for verification.** Race ID 5314 is the 2023
    Xfinity Bristol Night Race (per `NascarApi/LapNotes.MD` — "Xfinity race
    from last year" relative to 2023 documentation). User-reported as a
    known-good case for `cacher/live/series_2/5314/live-pit-data.json` and
    referenced verbatim in `NascarApi/LapNotes.MD`, `NascarApi/LapTimes`,
    `NascarApi/LivePitData`, `NascarApi/LivePointsData`, and
    `NascarApi/LoopStats`. The 2024 Cup Bristol race (race 5392, Food City
    500) is referenced in `NascarApi/WeekendFeed.MD` as another known-good
    case.

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
- `NascarApi/NewEndpointsDiscovered.MD` — the most comprehensive single
  document found, captured during 2026-02-04 Bowman Gray practice; provides
  `tracks.json`, full field tables for `live-feed`, `live-points`,
  `live-stage-points`, drivers envelope, and raw loop-stats JSON keys.
- `NascarApi/LiveFeed.MD` — markdown spec for `live-feed.json` fields,
  including an example payload from race 5593 / run 1 / Bowman Gray practice.
- `NascarApi/LiveFlagData.MD` — per-entry fields for `live-flag-data.json`.
- `NascarApi/LapTimes` — `cacher/2023/2/5314/lap-times.json` schema example;
  documents the per-`Lap` `LapSpeed` field.
- `NascarApi/LapNotes.MD` — `cacher/2023/2/5314/lap-notes.json` schema; shows
  `laps` is a map keyed by lap number string.
- `NascarApi/LivePitData` — points at
  `cacher/live/series_2/5314/live-pit-data.json` as a known-good URL.
- `NascarApi/LivePointsData` — points at the **underscored** per-race form
  `live/feeds/series_2/5314/live_points.json`.
- `NascarApi/LoopStats` — points at `loopstats/prod/2023/2/5314.json`.
- `NascarApi/RaceListBasic` — full per-race field set for
  `race_list_basic.json`, including the `schedule[]` block.
- `NascarApi/SeriesID` and `NascarApi/FlagState.MD` — series-id and
  flag-state code tables (same as `nascar_api.py`'s in-code constants).
- `NascarApi/WeekendFeed.MD` — `cacher/2024/1/5392/weekend-feed.json` (Food
  City 500) and the explicit note that **race IDs are not sequential**.
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
