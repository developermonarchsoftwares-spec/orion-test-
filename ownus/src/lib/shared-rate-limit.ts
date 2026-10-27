import { createHash } from 'crypto';

/**
 * Rate limiting for the gateway's own handlers that survives serverless hosting. Counters live in Postgres (`rate_limit_counters`), so every
 * function instance counts into the same row; a per-instance memory counter is only the fallback when the database or the table is
 * unavailable, so a limiter problem never becomes a sign-in outage. The API uses the same table and SQL (apps/api/src/common/throttler).
 * Keys are hashed: the table never holds an e-mail address or an IP address.
 */

export interface CounterPool {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<{ hits: number | string }> }>;
}

export const HIT_SQL = `INSERT INTO rate_limit_counters (key, hits, reset_at)
VALUES ($1, 1, now() + ($2::int * interval '1 millisecond'))
ON CONFLICT (key) DO UPDATE SET
  hits = CASE WHEN rate_limit_counters.reset_at <= now() THEN 1 ELSE rate_limit_counters.hits + 1 END,
  reset_at = CASE WHEN rate_limit_counters.reset_at <= now() THEN now() + ($2::int * interval '1 millisecond') ELSE rate_limit_counters.reset_at END
RETURNING hits, (EXTRACT(EPOCH FROM (reset_at - now())) * 1000)::int AS ms_left`;

const CLEANUP_SQL = `DELETE FROM rate_limit_counters WHERE reset_at < now() - interval '1 hour'`;
const DB_TIMEOUT_MS = 1500;
const RETRY_DB_AFTER_MS = 30_000;

export const counterKey = (key: string): string => createHash('sha256').update(`gateway:${key}`).digest('hex');

/** Returns an async `isLimited(key, limit, windowMs)`: true once more than `limit` requests have been seen in the window. */
export function createSharedLimiter(getPool: () => CounterPool | null, now: () => number = Date.now) {
  const memory = new Map<string, { count: number; resetAt: number }>();
  let dbDownUntil = 0;

  const viaMemory = (k: string, limit: number, windowMs: number): boolean => {
    const t = now();
    if (memory.size > 10_000) for (const [mk, v] of memory) if (v.resetAt < t) memory.delete(mk);
    const entry = memory.get(k);
    if (!entry || t > entry.resetAt) {
      memory.set(k, { count: 1, resetAt: t + windowMs });
      return false;
    }
    if (entry.count >= limit) return true;
    entry.count++;
    return false;
  };

  return async function isLimited(key: string, limit: number, windowMs: number): Promise<boolean> {
    const k = counterKey(key);
    const pool = getPool();
    if (pool && now() >= dbDownUntil) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const res = await Promise.race([
          pool.query(HIT_SQL, [k, Math.max(1, Math.floor(windowMs))]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('rate limit store timed out')), DB_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        const row = res.rows[0];
        if (!row) throw new Error('rate limit store returned no row');
        if (Math.random() < 0.01) void pool.query(CLEANUP_SQL, []).catch(() => undefined);
        return Number(row.hits) > limit;
      } catch (err) {
        dbDownUntil = now() + RETRY_DB_AFTER_MS;
        console.warn(`[RATE_LIMIT] shared store unavailable, counting in memory for ${RETRY_DB_AFTER_MS / 1000}s: ${(err as Error).message}`);
      }
    }
    return viaMemory(k, limit, windowMs);
  };
}
