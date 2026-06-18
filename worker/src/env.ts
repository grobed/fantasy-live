// Worker bindings + vars. Mirrors [vars], [[d1_databases]] and [[r2_buckets]]
// in wrangler.toml, plus the BACKEND_SECRET set via `wrangler secret put`.
export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  SEASON?: string;
  LEAGUE_SERIES_ID?: string;
  CORS_ORIGIN?: string;
  PICKS_CSV_URL: string;
  STANDINGS_CSV_URL: string;
  DRAFT_ORDER_CSV_URL: string;
  BACKEND_SECRET?: string;
}

// Empty / invalid SEASON => current calendar year (UTC).
export function getSeason(env: Env): number {
  const s = (env.SEASON || '').trim();
  const n = s ? Number(s) : NaN;
  return Number.isInteger(n) && n > 2000 ? n : new Date().getUTCFullYear();
}

export function getSeriesId(env: Env): number {
  const n = Number(env.LEAGUE_SERIES_ID);
  return Number.isInteger(n) && n > 0 ? n : 1;
}
