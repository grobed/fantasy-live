import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, getSeason, getSeriesId } from './env';
import { reconcile } from './reconcile';
import { refreshScheduleIfStale, refreshSchedule } from './schedule-sync';
import { archivePending, archiveRace, archiveFinishedForSeason } from './archive';
import { buildState } from './state';
import { getMeta } from './lib/meta';

const app = new Hono<{ Bindings: Env }>();

// CORS for the browser-facing read API only. Origin comes from CORS_ORIGIN
// (default "*"); set it to the GitHub Pages / custom-domain origin.
app.use(
  '/api/*',
  cors({
    origin: (_origin, c) => c.env.CORS_ORIGIN || '*',
    allowMethods: ['GET', 'OPTIONS'],
  }),
);

app.get('/', (c) => c.text('fantasy-live worker'));

// ---- Read-only API (consumed by index.html) ------------------------------

app.get('/api/state', async (c) => {
  const q = c.req.query('season');
  const n = q ? Number(q) : NaN;
  const season = Number.isInteger(n) ? n : undefined;
  const state = await buildState(c.env, season);
  c.header('Cache-Control', 'no-store'); // fresh every request
  return c.json(state);
});

app.get('/api/health', async (c) => {
  const season = getSeason(c.env);
  const db = c.env.DB;
  const counts: Record<string, number> = {};
  for (const t of ['owners', 'standings', 'picks', 'draft_order', 'races'] as const) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE season = ?1`).bind(season).first<{ n: number }>();
    counts[t] = row ? row.n : 0;
  }
  let r2Objects = 0;
  try {
    const list = await c.env.ARCHIVE.list({ prefix: `lap-times/${season}/` });
    r2Objects = list.objects.length;
  } catch (e) {
    console.error('R2 list failed:', e);
  }
  c.header('Cache-Control', 'no-store');
  return c.json({
    ok: true,
    season,
    counts,
    lastReconcile: await getMeta(db, 'last_reconcile_at'),
    scheduleRefreshed: await getMeta(db, 'schedule_refreshed_at'),
    r2Objects,
  });
});

// ---- Mutation routes (operator-only, shared-secret) ----------------------

function requireSecret(c: any): Response | null {
  const expected = c.env.BACKEND_SECRET as string | undefined;
  if (!expected) return c.json({ error: 'BACKEND_SECRET not configured' }, 503);
  if (c.req.header('x-backend-secret') !== expected) return c.json({ error: 'unauthorized' }, 401);
  return null;
}

app.post('/reconcile', async (c) => {
  const denied = requireSecret(c);
  if (denied) return denied;
  // Schedule refresh is best-effort: a NASCAR 403/outage must not block the
  // sheet->D1 mirror. Reconcile is the point of this route.
  const scheduleError = await tryRefreshSchedule(c.env);
  const result = await reconcile(c.env);
  return c.json({ ok: true, ...result, scheduleError });
});

app.post('/archive-lap-times', async (c) => {
  const denied = requireSecret(c);
  if (denied) return denied;
  const raceId = Number(c.req.query('race_id'));
  if (!Number.isInteger(raceId)) return c.json({ error: 'race_id query param required' }, 400);
  const season = getSeason(c.env);
  const key = await archiveRace(c.env, season, getSeriesId(c.env), raceId);
  return c.json({ ok: true, race_id: raceId, r2_key: key });
});

app.post('/backfill', async (c) => {
  const denied = requireSecret(c);
  if (denied) return denied;
  const year = Number(c.req.query('year'));
  if (!Number.isInteger(year)) return c.json({ error: 'year query param required' }, 400);
  const races = await refreshSchedule(c.env, year);
  const archived = await archiveFinishedForSeason(c.env, year);
  return c.json({ ok: true, year, races, archived });
});

// ---- Cron ----------------------------------------------------------------

// Best-effort schedule refresh: log + swallow so NASCAR-side failures never
// block the sheet mirror. Returns an error string (for the /reconcile
// response) or null.
async function tryRefreshSchedule(env: Env): Promise<string | null> {
  try {
    await refreshScheduleIfStale(env);
    return null;
  } catch (e) {
    console.error('schedule refresh failed (non-fatal):', e);
    return String(e instanceof Error ? e.message : e);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron !== '* * * * *') return;
    // Each step is independent: a failure in one must not abort the others.
    await tryRefreshSchedule(env);
    try {
      await reconcile(env);
    } catch (e) {
      console.error('reconcile failed:', e);
    }
    try {
      await archivePending(env);
    } catch (e) {
      console.error('archive failed:', e);
    }
  },
};
