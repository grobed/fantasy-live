// Race-row helpers shared by the reconciler, archiver and the /api/state
// builder so they all agree on "which race are we drafting for" and on
// next/last race selection.

export interface RaceRow {
  season: number;
  race_id: number;
  series_id: number;
  race_name: string | null;
  track_name: string | null;
  race_type_id: number | null;
  race_date: string | null;
  start_time_utc: string | null;
  winner_driver_id: number | null;
  lap_times_archived_at: string | null;
  r2_key: string | null;
}

// Epoch ms for a race. Prefer the explicit UTC start; fall back to race_date.
export function raceTime(r: RaceRow): number {
  const s = r.start_time_utc || r.race_date;
  const t = s ? new Date(s).getTime() : NaN;
  return t;
}

// All races for a season, sorted oldest-first, dropping unparseable dates.
export async function loadRaces(db: D1Database, season: number): Promise<RaceRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM races WHERE season = ?1`)
    .bind(season)
    .all<RaceRow>();
  return (results || [])
    .filter((r) => !Number.isNaN(raceTime(r)))
    .sort((a, b) => raceTime(a) - raceTime(b));
}

export function nextRace(races: RaceRow[], now: number): RaceRow | null {
  const future = races.filter((r) => raceTime(r) > now);
  return future.length ? future[0] : null;
}

export function lastRace(races: RaceRow[], now: number): RaceRow | null {
  const past = races.filter((r) => raceTime(r) <= now);
  return past.length ? past[past.length - 1] : null;
}

// The race currently being drafted for: the next unrun race, else (end of
// season) the most recent one. Picks/draft-order from the sheet attach here.
export function currentDraftRace(races: RaceRow[], now: number): RaceRow | null {
  return nextRace(races, now) || (races.length ? races[races.length - 1] : null);
}
