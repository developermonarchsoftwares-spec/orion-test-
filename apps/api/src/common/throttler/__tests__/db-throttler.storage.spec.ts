import { DbThrottlerStorage, HIT_SQL, counterKey, CounterPool } from '../db-throttler.storage';

const sharedPool = () => {
  const hits = new Map<string, number>();
  const pool: CounterPool = {
    query: async (sql, params) => {
      if (sql !== HIT_SQL) return { rows: [] };
      const k = String(params[0]);
      hits.set(k, (hits.get(k) ?? 0) + 1);
      return { rows: [{ hits: hits.get(k)!, ms_left: 42_000 }] };
    },
  };
  return pool;
};

describe('DbThrottlerStorage', () => {
  it('shares counts between instances and blocks once the limit is passed', async () => {
    const pool = sharedPool();
    const a = new DbThrottlerStorage(pool);
    const b = new DbThrottlerStorage(pool);
    expect((await a.increment('route-ip', 60000, 2, 60000, 'default')).isBlocked).toBe(false);
    expect((await b.increment('route-ip', 60000, 2, 60000, 'default')).isBlocked).toBe(false);
    const third = await a.increment('route-ip', 60000, 2, 60000, 'default');
    expect(third).toMatchObject({ totalHits: 3, isBlocked: true, timeToExpire: 42, timeToBlockExpire: 42 });
  });

  it('stores only a SHA-256 of the key', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ hits: 1, ms_left: 1000 }] });
    await new DbThrottlerStorage({ query }).increment('203.0.113.9', 1000, 5, 1000, 'default');
    expect(query.mock.calls[0][1][0]).toBe(counterKey('default', '203.0.113.9'));
    expect(query.mock.calls[0][1][0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to memory when the table is missing, then keeps limiting', async () => {
    const pool: CounterPool = { query: jest.fn().mockRejectedValue(new Error('relation does not exist')) };
    const s = new DbThrottlerStorage(pool);
    const r1 = await s.increment('k', 60000, 1, 60000, 'default');
    const r2 = await s.increment('k', 60000, 1, 60000, 'default');
    expect(r1.isBlocked).toBe(false);
    expect(r2.isBlocked).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('works with no database pool', async () => {
    const s = new DbThrottlerStorage(null);
    expect((await s.increment('k', 1000, 1, 1000, 'default')).totalHits).toBe(1);
  });
});
