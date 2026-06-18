// Builds GET /api/state -- the single composite response the frontend consumes
// in place of the three CSVs. Field names align with index.html's existing
// variables so the cutover is near-mechanical. Owners are returned pre-sorted
// in the same draft order index.html computes (draft order, then pick order,
// then standings order), so the frontend just reads them in sequence.
import { Env, getSeason } from './env';
import { loadRaces, nextRace, lastRace, currentDraftRace, RaceRow } from './lib/races';

export interface StateOwner {
  owner: string;
  driver: string | null;
  seasonTotal: number;
  pickNumber: number;
  draftPosition: number | null;
}

export async function buildState(env: Env, seasonArg?: number) {
  const season = seasonArg ?? getSeason(env);
  const now = Date.now();

  const races = await loadRaces(env.DB, season);
  const draftRace = currentDraftRace(races, now);
  const raceId = draftRace ? draftRace.race_id : null;

  const owners = ((
    await env.DB.prepare(
      `SELECT o.owner_id AS owner_id, o.display_name AS display_name,
              COALESCE(s.season_points, 0) AS season_points
       FROM owners o
       LEFT JOIN standings s ON s.season = o.season AND s.owner_id = o.owner_id
       WHERE o.season = ?1`,
    )
      .bind(season)
      .all()
  ).results || []) as Array<{ owner_id: string; display_name: string; season_points: number }>;

  const pickRows =
    raceId == null
      ? []
      : (((
          await env.DB.prepare(`SELECT owner_id, driver_name, pick_order FROM picks WHERE season = ?1 AND race_id = ?2`)
            .bind(season, raceId)
            .all()
        ).results || []) as Array<{ owner_id: string; driver_name: string; pick_order: number }>);

  const orderRows =
    raceId == null
      ? []
      : (((
          await env.DB.prepare(`SELECT owner_id, draft_position FROM draft_order WHERE season = ?1 AND race_id = ?2`)
            .bind(season, raceId)
            .all()
        ).results || []) as Array<{ owner_id: string; draft_position: number }>);

  const driverByOwner: Record<string, string> = {};
  const pickOrder: Record<string, number> = {};
  for (const p of pickRows) {
    driverByOwner[p.owner_id] = p.driver_name;
    pickOrder[p.owner_id] = p.pick_order;
  }
  const draftPos: Record<string, number> = {};
  for (const d of orderRows) draftPos[d.owner_id] = d.draft_position;

  // Replicate index.html's ordering exactly.
  const list = owners.map((o) => {
    const id = o.owner_id;
    const order =
      id in draftPos ? draftPos[id] : id in pickOrder ? 1e6 + pickOrder[id] : 2e6;
    return {
      owner: o.display_name,
      driver: driverByOwner[id] || null,
      seasonTotal: o.season_points,
      draftPosition: id in draftPos ? draftPos[id] : null,
      order,
    };
  });
  list.sort((a, b) => a.order - b.order);

  const ownersOut: StateOwner[] = list.map((o, i) => ({
    owner: o.owner,
    driver: o.driver,
    seasonTotal: o.seasonTotal,
    pickNumber: i + 1,
    draftPosition: o.draftPosition,
  }));

  const draftComplete = list.length > 0 && list.every((o) => o.driver);

  return {
    season,
    draftComplete,
    owners: ownersOut,
    nextRace: toNextRace(nextRace(races, now)),
    lastRace: toLastRace(lastRace(races, now)),
  };
}

function toNextRace(r: RaceRow | null) {
  if (!r) return null;
  return {
    race_id: r.race_id,
    race_name: r.race_name,
    track_name: r.track_name,
    race_date: r.race_date,
    start_time_utc: r.start_time_utc,
  };
}

function toLastRace(r: RaceRow | null) {
  if (!r) return null;
  return {
    race_id: r.race_id,
    race_name: r.race_name,
    track_name: r.track_name,
    race_date: r.race_date,
    lap_times_archived_at: r.lap_times_archived_at,
  };
}
