import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

/** The pg pool surface this needs; kept narrow so tests can pass a stub. */
export interface CounterPool {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<{ hits: number; ms_left: number }> }>;
}

/**
 * One atomic statement: start a window, or add a hit to the running one, and say how many hits it holds and how long it has left.
 * Same SQL as the web gateway's limiter (ownus/src/lib/shared-rate-limit.ts), so both count into the same rows.
 */
export const HIT_SQL = `INSERT INTO rate_limit_counters (key, hits, reset_at)
VALUES ($1, 1, now() + ($2::int * interval '1 millisecond'))
ON CONFLICT (key) DO UPDATE SET
  hits = CASE WHEN rate_limit_counters.reset_at <= now() THEN 1 ELSE rate_limit_counters.hits + 1 END,
  reset_at = CASE WHEN rate_limit_counters.reset_at <= now() THEN now() + ($2::int * interval '1 millisecond') ELSE rate_limit_counters.reset_at END
RETURNING hits, (EXTRACT(EPOCH FROM (reset_at - now())) * 1000)::int AS ms_left`;

const CLEANUP_SQL = `DELETE FROM rate_limit_counters WHERE reset_at < now() - interval '1 hour'`;
const DB_TIMEOUT_MS = 1500;
const RETRY_DB_AFTER_MS = 30_000;

export const counterKey = (throttlerName: string, key: string): string => createHash('sha256').update(`${throttlerName}:${key}`).digest('hex');

/**
 * Throttler storage that keeps the counters in Postgres, so every serverless instance counts into the same place. If the database or the
 * table is unavailable it falls back to per-instance memory (the previous behaviour) and retries the database later: a limiter outage
 * must never become a sign-in outage.
 */
export class DbThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(DbThrottlerStorage.name);
  private readonly memory = new Map<string, { hits: number; resetAt: number }>();
  private dbDownUntil = 0;

  constructor(private readonly pool: CounterPool | null, private readonly now: () => number = Date.now) {}

  async increment(key: string, ttl: number, limit: number, _blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const k = counterKey(throttlerName, key);
    let hits: number;
    let msLeft: number;
    const viaDb = await this.hitDb(k, ttl);
    if (viaDb) ({ hits, msLeft } = viaDb);
    else ({ hits, msLeft } = this.hitMemory(k, ttl));
    const isBlocked = hits > limit;
    const secondsLeft = Math.max(1, Math.ceil(msLeft / 1000));
    return { totalHits: hits, timeToExpire: secondsLeft, isBlocked, timeToBlockExpire: isBlocked ? secondsLeft : 0 };
  }

  private async hitDb(k: string, ttl: number): Promise<{ hits: number; msLeft: number } | null> {
    if (!this.pool || this.now() < this.dbDownUntil) return null;
    try {
      const res = await Promise.race([
        this.pool.query(HIT_SQL, [k, Math.max(1, Math.floor(ttl))]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('rate limit store timed out')), DB_TIMEOUT_MS).unref?.()),
      ]);
      const row = res.rows[0];
      if (!row) throw new Error('rate limit store returned no row');
      if (Math.random() < 0.01) void this.pool.query(CLEANUP_SQL, []).catch(() => undefined);
      return { hits: Number(row.hits), msLeft: Number(row.ms_left) };
    } catch (err) {
      this.dbDownUntil = this.now() + RETRY_DB_AFTER_MS;
      this.logger.warn(`Shared rate limit store unavailable, counting in memory for ${RETRY_DB_AFTER_MS / 1000}s: ${(err as Error).message}`);
      return null;
    }
  }

  private hitMemory(k: string, ttl: number): { hits: number; msLeft: number } {
    const now = this.now();
    if (this.memory.size > 10_000) for (const [mk, v] of this.memory) if (v.resetAt <= now) this.memory.delete(mk);
    const entry = this.memory.get(k);
    if (!entry || entry.resetAt <= now) {
      this.memory.set(k, { hits: 1, resetAt: now + ttl });
      return { hits: 1, msLeft: ttl };
    }
    entry.hits += 1;
    return { hits: entry.hits, msLeft: entry.resetAt - now };
  }
}
