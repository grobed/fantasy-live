// Tiny key/value table for reconcile + schedule-refresh timestamps.

export function setMetaStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
  const now = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`,
    )
    .bind(key, value, now);
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM meta WHERE key = ?1`).bind(key).first<{ value: string }>();
  return row ? row.value : null;
}
