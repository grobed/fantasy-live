// Mirror NASCAR's race_list_basic.json into the races table. Gated to at most
// once per 6 hours on the cron hot path (schedule changes rarely); /backfill
// calls refreshSchedule directly with force semantics.
import { Env, getSeason, getSeriesId } from './env';
import { fetchScheduleJson } from './lib/nascar';
import { raceStartUtc } from './lib/schedule';
import { getMeta, setMetaStmt } from './lib/meta';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export async function refreshScheduleIfStale(env: Env): Promise<number> {
  const last = await getMeta(env.DB, 'schedule_refreshed_at');
  if (last && Date.now() - new Date(last).getTime() < SIX_HOURS_MS) return 0;
  return refreshSchedule(env, getSeason(env));
}

// Upsert every race for `year`'s league series. Deliberately does NOT touch
// lap_times_archived_at / r2_key, so a schedule refresh never clears an
// archive flag.
export async function refreshSchedule(env: Env, year: number): Promise<number> {
  const seriesId = getSeriesId(env);
  const data = await fetchScheduleJson(year);
  const races: any[] = data[`series_${seriesId}`] || [];
  const nowIso = new Date().toISOString();

  const stmts: D1PreparedStatement[] = [];
  for (const r of races) {
    if (r.race_id == null) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO races
           (season, race_id, series_id, race_name, track_name, race_type_id,
            race_date, start_time_utc, winner_driver_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(season, race_id) DO UPDATE SET
           series_id = ?3, race_name = ?4, track_name = ?5, race_type_id = ?6,
           race_date = ?7, start_time_utc = ?8, winner_driver_id = ?9,
           updated_at = ?10`,
      ).bind(
        year,
        r.race_id,
        seriesId,
        r.race_name ?? null,
        r.track_name ?? null,
        r.race_type_id ?? null,
        r.race_date ?? null,
        raceStartUtc(r),
        r.winner_driver_id ?? null,
        nowIso,
      ),
    );
  }
  // Only stamp the refresh marker for the current season's gate.
  if (year === getSeason(env)) stmts.push(setMetaStmt(env.DB, 'schedule_refreshed_at', nowIso));
  if (stmts.length) await env.DB.batch(stmts);
  return races.length;
}
