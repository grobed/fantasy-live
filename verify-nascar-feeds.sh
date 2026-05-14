#!/usr/bin/env bash
# verify-nascar-feeds.sh
#
# Probe every cf.nascar.com endpoint documented in nascar-feeds.md and report
# HTTP status, response size, and top-level JSON keys for each.
#
# Requires: curl, python3. No third-party packages.
#
# Usage:
#   ./verify-nascar-feeds.sh                # probes current calendar year, Cup series, first completed race
#   ./verify-nascar-feeds.sh 2024           # specific year
#   ./verify-nascar-feeds.sh 2024 1 5544    # specific year / series / race_id (skips auto-discovery)
#
# Behavior:
#   - Auto-discovers a real, completed race_id from race_list_basic.json
#     unless YEAR/SERIES/RACE are all provided on the command line.
#   - Each probe runs against cf.nascar.com with a browser-like User-Agent
#     and Referer header, which is what Cloudflare expects.
#   - For each URL prints: HTTP status, body size, content-type, and (if JSON)
#     either the top-level object keys or the array length.

set -u

YEAR="${1:-$(date +%Y)}"
SERIES="${2:-1}"
RACE="${3:-}"

UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
REFERER="https://www.nascar.com/"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Find a working Python. On Windows `python3` is often a Store-install stub
# that prints an installer message and exits non-zero, so we test each
# candidate by actually running it.
PY=""
for cand in python3 python py; do
  if command -v "$cand" >/dev/null 2>&1; then
    # `py` needs `-3`; everything else takes plain `-c`.
    if [ "$cand" = "py" ]; then
      if py -3 -c "import sys" >/dev/null 2>&1; then
        PY="py -3"; break
      fi
    else
      if "$cand" -c "import sys" >/dev/null 2>&1; then
        PY="$cand"; break
      fi
    fi
  fi
done
if [ -z "$PY" ]; then
  echo "ERROR: no working Python interpreter found (tried python3, python, py -3)." >&2
  echo "Install Python 3 (https://www.python.org/downloads/) and re-run." >&2
  exit 1
fi
echo "Using Python: $PY"

# Pretty-print one probe.
# args: $1 label, $2 URL
probe() {
  local label="$1" url="$2" body="$TMP/body.json"
  local http size ctype keys
  read -r http size ctype < <(
    curl -sS \
      -A "$UA" \
      -H "Accept: application/json" \
      -H "Referer: $REFERER" \
      -o "$body" \
      -w "%{http_code} %{size_download} %{content_type}\n" \
      "$url" || echo "000 0 -"
  )

  keys="$($PY - "$body" <<'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1], 'rb') as f:
        d = json.load(f)
except Exception as e:
    print(f"(not JSON: {type(e).__name__})")
    sys.exit(0)
if isinstance(d, dict):
    ks = list(d.keys())
    print("keys=" + ",".join(ks[:8]) + (f" (+{len(ks)-8} more)" if len(ks) > 8 else ""))
elif isinstance(d, list):
    print(f"array len={len(d)}" + (f"; item0 keys=" + ",".join(list(d[0].keys())[:6]) if d and isinstance(d[0], dict) else ""))
else:
    print(f"scalar: {type(d).__name__}")
PY
)"
  [ -z "$keys" ] && keys="(empty)"

  printf '%-40s  HTTP=%s  SIZE=%-8s  %s\n' "$label" "$http" "$size" "$keys"
  printf '  %s\n' "$url"
  printf '  %s\n\n' "$keys"
}

# ---- auto-discover a real race_id if not given ----------------------------
if [ -z "$RACE" ]; then
  echo "Discovering a real race_id from /cacher/${YEAR}/race_list_basic.json ..."
  curl -sS -A "$UA" -H "Accept: application/json" -H "Referer: $REFERER" \
       -o "$TMP/sched.json" \
       "https://cf.nascar.com/cacher/${YEAR}/race_list_basic.json"

  RACE="$($PY - "$TMP/sched.json" "$SERIES" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(""); sys.exit(0)
series = f"series_{sys.argv[2]}"
races = d.get(series, []) or []
done = [r for r in races if r.get("winner_driver_id")]
if done:
    print(done[0].get("race_id", ""))
elif races:
    print(races[0].get("race_id", ""))
PY
)"

  if [ -z "$RACE" ]; then
    echo "  (could not auto-discover; falling back to known-good 2021/1/5029 — Daytona 500)"
    YEAR=2021; SERIES=1; RACE=5029
  else
    echo "  -> using race_id=$RACE (year=$YEAR, series=$SERIES)"
  fi
  echo
fi

echo "================================================================"
echo " Probing with: year=$YEAR  series_id=$SERIES  race_id=$RACE"
echo "================================================================"
echo

# ---- /cacher/ historical / per-race ---------------------------------------
echo "--- /cacher/  (historical & schedule) ---"
probe "schedule"               "https://cf.nascar.com/cacher/${YEAR}/race_list_basic.json"
probe "drivers roster"         "https://cf.nascar.com/cacher/drivers.json"
probe "weekend-feed"           "https://cf.nascar.com/cacher/${YEAR}/${SERIES}/${RACE}/weekend-feed.json"
probe "lap-times"              "https://cf.nascar.com/cacher/${YEAR}/${SERIES}/${RACE}/lap-times.json"
probe "lap-notes (events)"     "https://cf.nascar.com/cacher/${YEAR}/${SERIES}/${RACE}/lap-notes.json"
probe "live-pit-data (race)"   "https://cf.nascar.com/cacher/${YEAR}/${SERIES}/${RACE}/live-pit-data.json"
probe "legacy lapAvg (Xfin19)" "https://cf.nascar.com/cacher/2019/2/4817/lapAvg_nxs_practice_1.json"

# ---- /cacher/live/  series-namespaced live --------------------------------
echo "--- /cacher/live/  (live, series-namespaced) ---"
probe "live weekend-feed"      "https://cf.nascar.com/cacher/live/series_${SERIES}/${RACE}/weekend-feed.json"
probe "live lap-times"         "https://cf.nascar.com/cacher/live/series_${SERIES}/${RACE}/lap-times.json"
probe "live lap-notes"         "https://cf.nascar.com/cacher/live/series_${SERIES}/${RACE}/lap-notes.json"
probe "live pit-data (race)"   "https://cf.nascar.com/cacher/live/series_${SERIES}/${RACE}/live-pit-data.json"
probe "live-feed (race)"       "https://cf.nascar.com/cacher/live/series_${SERIES}/${RACE}/live-feed.json"

# ---- /cacher/live/  global (no series/race) -------------------------------
echo "--- /cacher/live/  (live, global) ---"
probe "global live-feed"       "https://cf.nascar.com/cacher/live/live-feed.json"
probe "global live-points"     "https://cf.nascar.com/cacher/live/live-points.json"
probe "global live-pit-data"   "https://cf.nascar.com/cacher/live/live-pit-data.json"

# ---- /live/feeds/  global live --------------------------------------------
echo "--- /live/feeds/  (live, global, NascarApi form) ---"
probe "live-feed"              "https://cf.nascar.com/live/feeds/live-feed.json"
probe "live-flag-data"         "https://cf.nascar.com/live/feeds/live-flag-data.json"
probe "live-pit-data"          "https://cf.nascar.com/live/feeds/live-pit-data.json"
probe "live-points"            "https://cf.nascar.com/live/feeds/live-points.json"
probe "live-stage-points"      "https://cf.nascar.com/live/feeds/live-stage-points.json"

# ---- /loopstats/prod/  driver loop stats ----------------------------------
echo "--- /loopstats/prod/  (NASCAR Loop Data driver stats) ---"
probe "loop stats"             "https://cf.nascar.com/loopstats/prod/${YEAR}/${SERIES}/${RACE}.json"

echo "Done."
echo
echo "Notes:"
echo " - 403 on every URL usually means Cloudflare doesn't like your egress IP"
echo "   or headers. Try from a residential IP, or set the Accept-Language"
echo "   header too. Browsers send Referer: https://www.nascar.com/."
echo " - For /live/feeds/* and /cacher/live/*: between races the payload"
echo "   either reflects the last session or comes back empty/404."
echo " - For /cacher/{year}/{series}/{race}/*: future races return 404"
echo "   until NASCAR publishes that weekend; past races are immutable."
