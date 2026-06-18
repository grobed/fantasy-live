// Post-race lap-times archive. After a race finishes, fetch lap-times.json once
// and write it to R2, then stamp the D1 race row. The D1 flag (not trust) gates
// the NASCAR hit: skipped if lap_times_archived_at is set, capped to one
// attempt per cron tick per race, with a 24h give-up window after race start.
import { Env, getSeason, getSeriesId } from './env';
import { fetchLapTimes } from './lib/nascar';
import { loadRaces, raceTime, RaceRow } from './lib/races';

// A race is assumed finished this long after its green flag if NASCAR hasn't
// yet published winner_driver_id (schedule-derived; we never poll live-feed).
const RACE_DONE_AFTER_MS = 4 * 60 * 60 * 1000;
// Stop trying once this long has passed since the race start.
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

export async function archivePending(env: Env): Promise<{ archived: number[] }> {
  const season = getSeason(env);
  const seriesId = getSeriesId(env);
  const now = Date.now();
  const races = await loadRaces(env.DB, season);

  const archived: number[] = [];
  for (const r of races) {
    if (r.lap_times_archived_at) continue;
    if (!isFinished(r, now)) continue;
    try {
      await archiveRace(env, season, seriesId, r.race_id);
      archived.push(r.race_id);
    } catch (e) {
      console.error(`archive race ${r.race_id} failed:`, e);
    }
  }
  return { archived };
}

function isFinished(r: RaceRow, now: number): boolean {
  const t = raceTime(r);
  if (Number.isNaN(t) || t > now) return false; // not started
  if (now - t > GIVE_UP_AFTER_MS) return false; // give-up window passed
  return r.winner_driver_id != null || now - t > RACE_DONE_AFTER_MS;
}

// Fetch lap-times.json and overwrite the R2 object, then (re)stamp the D1 row.
// Idempotent: re-running overwrites the same key and re-sets the flag.
export async function archiveRace(
  env: Env,
  season: number,
  seriesId: number,
  raceId: number,
): Promise<string> {
  const body = await fetchLapTimes(season, seriesId, raceId);
  const key = `lap-times/${season}/series_${seriesId}/${raceId}/lap-times.json`;
  await env.ARCHIVE.put(key, body, { httpMetadata: { contentType: 'application/json' } });
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE races SET lap_times_archived_at = ?1, r2_key = ?2, updated_at = ?1
     WHERE season = ?3 AND race_id = ?4`,
  )
    .bind(nowIso, key, season, raceId)
    .run();
  return key;
}

// Used by /backfill: archive every already-finished race for a season that
// lacks an archive. Best-effort; per-race failures are logged, not fatal.
export async function archiveFinishedForSeason(
  env: Env,
  season: number,
): Promise<number[]> {
  const seriesId = getSeriesId(env);
  const now = Date.now();
  const races = await loadRaces(env.DB, season);
  const archived: number[] = [];
  for (const r of races) {
    if (r.lap_times_archived_at) continue;
    const t = raceTime(r);
    if (Number.isNaN(t) || t > now) continue;
    // Backfill ignores the 24h window -- it intentionally reaches old races.
    const finished = r.winner_driver_id != null || now - t > RACE_DONE_AFTER_MS;
    if (!finished) continue;
    try {
      await archiveRace(env, season, seriesId, r.race_id);
      archived.push(r.race_id);
    } catch (e) {
      console.error(`backfill archive race ${r.race_id} failed:`, e);
    }
  }
  return archived;
}
