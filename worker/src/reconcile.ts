// Sheet -> D1 reconciler. Idempotent; running it twice in a row yields zero new
// writes. UPSERTs keyed by natural keys. Builds everything into local vars
// first and writes only on full success, so a failed/empty CSV never corrupts
// previously-good D1 data. Mirrors the parsing in index.html's loadOwnerInfo().
import { Env, getSeason } from './env';
import { fetchCSV } from './lib/csv';
import { cleanName } from './lib/clean-name';
import { loadRaces, currentDraftRace } from './lib/races';
import { setMetaStmt } from './lib/meta';

export interface ReconcileResult {
  season: number;
  raceId: number | null;
  owners: number;
  picks: number;
  draftOrder: number;
}

export async function reconcile(env: Env): Promise<ReconcileResult> {
  const season = getSeason(env);
  const nowIso = new Date().toISOString();

  // All three tabs come from one sheet but need one request each. The
  // draft-order tab is optional, so a failure there yields an empty list
  // rather than sinking the whole load (matches the frontend).
  const [pickRows, standingRows, orderRows] = await Promise.all([
    fetchCSV(env.PICKS_CSV_URL),
    fetchCSV(env.STANDINGS_CSV_URL),
    fetchCSV(env.DRAFT_ORDER_CSV_URL).catch((e) => {
      console.error('Draft-order load failed:', e);
      return [] as string[][];
    }),
  ]);

  // Standings tab: col C = owner, col D = season points. Canonical owner list;
  // rows whose points cell isn't numeric are skipped.
  const totals: Record<string, number> = {};
  const ownersOrdered: { ownerId: string; display: string; points: number }[] = [];
  for (const r of standingRows) {
    const display = (r[2] || '').trim();
    const pts = Number(r[3]);
    if (display && !Number.isNaN(pts)) {
      const id = display.toLowerCase();
      if (!(id in totals)) {
        totals[id] = pts;
        ownersOrdered.push({ ownerId: id, display, points: pts });
      }
    }
  }
  // Refuse to write an empty roster -- a transient blip must not wipe owners.
  if (ownersOrdered.length === 0) throw new Error('no standings rows parsed');

  // Draft-order tab: single column of owner names in draft order. Match against
  // known owners (case-insensitive) so the "owner" header and stray cells are
  // ignored.
  const draftPos: Record<string, number> = {};
  let ord = 0;
  for (const r of orderRows) {
    const key = (r[0] || '').trim().toLowerCase();
    if (key && key in totals && !(key in draftPos)) draftPos[key] = ord++;
  }

  // Picks tab: col A = owner, col B = driver. Skip the label row and any owner
  // not present in standings (matches the frontend join).
  const picks: { ownerId: string; driver: string; order: number }[] = [];
  let seq = 0;
  for (const r of pickRows) {
    const owner = (r[0] || '').trim();
    const driver = cleanName(r[1]);
    if (!owner || !driver || owner.toLowerCase() === 'owner') continue;
    const id = owner.toLowerCase();
    if (!(id in totals)) continue;
    picks.push({ ownerId: id, driver, order: seq++ });
  }

  // Picks + draft order attach to the race currently being drafted for.
  const races = await loadRaces(env.DB, season);
  const draftRace = currentDraftRace(races, Date.now());
  const raceId = draftRace ? draftRace.race_id : null;

  const stmts: D1PreparedStatement[] = [];
  for (const o of ownersOrdered) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO owners (season, owner_id, display_name, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(season, owner_id) DO UPDATE SET display_name = ?3, updated_at = ?4`,
      ).bind(season, o.ownerId, o.display, nowIso),
    );
    stmts.push(
      env.DB.prepare(
        `INSERT INTO standings (season, owner_id, season_points, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(season, owner_id) DO UPDATE SET season_points = ?3, updated_at = ?4`,
      ).bind(season, o.ownerId, o.points, nowIso),
    );
  }

  if (raceId != null) {
    // Mirror the active race only: drop rows no longer in the sheet, then
    // upsert. Past races' picks/draft-order are never touched -> history is
    // preserved while the current draft stays a faithful mirror.
    const pickIds = picks.map((p) => p.ownerId);
    stmts.push(deleteExcept(env.DB, 'picks', season, raceId, pickIds));
    for (const p of picks) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO picks (season, race_id, owner_id, driver_name, pick_order, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(season, race_id, owner_id)
           DO UPDATE SET driver_name = ?4, pick_order = ?5, updated_at = ?6`,
        ).bind(season, raceId, p.ownerId, p.driver, p.order, nowIso),
      );
    }

    const orderIds = Object.keys(draftPos);
    stmts.push(deleteExcept(env.DB, 'draft_order', season, raceId, orderIds));
    for (const id of orderIds) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO draft_order (season, race_id, owner_id, draft_position, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(season, race_id, owner_id)
           DO UPDATE SET draft_position = ?4, updated_at = ?5`,
        ).bind(season, raceId, id, draftPos[id], nowIso),
      );
    }
  }

  stmts.push(setMetaStmt(env.DB, 'last_reconcile_at', nowIso));
  await env.DB.batch(stmts);

  return { season, raceId, owners: ownersOrdered.length, picks: picks.length, draftOrder: Object.keys(draftPos).length };
}

// DELETE rows for (season, race_id) whose owner_id is not in `ids`. With an
// empty list, deletes every row for the race. `table` is an internal literal,
// never user input.
function deleteExcept(
  db: D1Database,
  table: 'picks' | 'draft_order',
  season: number,
  raceId: number,
  ids: string[],
): D1PreparedStatement {
  if (ids.length === 0) {
    return db.prepare(`DELETE FROM ${table} WHERE season = ?1 AND race_id = ?2`).bind(season, raceId);
  }
  const placeholders = ids.map((_, i) => `?${i + 3}`).join(', ');
  return db
    .prepare(`DELETE FROM ${table} WHERE season = ?1 AND race_id = ?2 AND owner_id NOT IN (${placeholders})`)
    .bind(season, raceId, ...ids);
}
