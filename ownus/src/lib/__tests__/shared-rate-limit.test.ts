import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HIT_SQL, counterKey, createSharedLimiter, type CounterPool } from '../shared-rate-limit.ts';

/** A pool whose rows behave like the real table: one counter per key, shared by every limiter built on it. */
function fakePool() {
  const rows = new Map<string, number>();
  const seen: unknown[][] = [];
  const pool: CounterPool = {
    async query(sql, params) {
      if (sql !== HIT_SQL) return { rows: [] };
      seen.push(params);
      const key = String(params[0]);
      rows.set(key, (rows.get(key) ?? 0) + 1);
      return { rows: [{ hits: rows.get(key)! }] };
    },
  };
  return { pool, rows, seen };
}

describe('shared gateway rate limiter', () => {
  it('counts in the shared store: two instances together reach the limit', async () => {
    const { pool } = fakePool();
    const instanceA = createSharedLimiter(() => pool);
    const instanceB = createSharedLimiter(() => pool);
    assert.equal(await instanceA('login:ip:1.2.3.4', 3, 60000), false);
    assert.equal(await instanceB('login:ip:1.2.3.4', 3, 60000), false);
    assert.equal(await instanceA('login:ip:1.2.3.4', 3, 60000), false);
    assert.equal(await instanceB('login:ip:1.2.3.4', 3, 60000), true, 'the 4th request across both instances is limited');
    assert.equal(await instanceA('login:ip:9.9.9.9', 3, 60000), false, 'another subject has its own count');
  });

  it('never stores the raw address or e-mail: the key is a SHA-256 digest', async () => {
    const { pool, seen } = fakePool();
    await createSharedLimiter(() => pool)('login:acct:person@example.com', 5, 1000);
    const stored = String(seen[0][0]);
    assert.match(stored, /^[0-9a-f]{64}$/);
    assert.equal(stored, counterKey('login:acct:person@example.com'));
    assert.doesNotMatch(stored, /example/);
  });

  it('falls back to per-instance memory when the store fails, and keeps limiting', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const broken: CounterPool = { query: async () => { throw new Error('relation "rate_limit_counters" does not exist'); } };
      const limited = createSharedLimiter(() => broken);
      assert.equal(await limited('k', 2, 60000), false);
      assert.equal(await limited('k', 2, 60000), false);
      assert.equal(await limited('k', 2, 60000), true);
    } finally {
      console.warn = warn;
    }
  });

  it('uses memory when there is no database at all, and starts a new window after it ends', async () => {
    let t = 1_000;
    const limited = createSharedLimiter(() => null, () => t);
    assert.equal(await limited('k', 1, 1000), false);
    assert.equal(await limited('k', 1, 1000), true);
    t += 1500;
    assert.equal(await limited('k', 1, 1000), false);
  });

  it('retries the store after the pause instead of staying on memory forever', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      let t = 0;
      let failing = true;
      let calls = 0;
      const pool: CounterPool = { query: async () => { calls++; if (failing) throw new Error('down'); return { rows: [{ hits: 1 }] }; } };
      const limited = createSharedLimiter(() => pool, () => t);
      await limited('k', 5, 1000);
      await limited('k', 5, 1000);
      assert.equal(calls, 1, 'no further queries during the pause');
      failing = false;
      t += 31_000;
      await limited('k', 5, 1000);
      assert.equal(calls, 2);
    } finally {
      console.warn = warn;
    }
  });
});
