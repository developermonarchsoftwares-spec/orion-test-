import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolConfig, isLocalDatabaseUrl } from '../db.ts';

const remote = 'postgresql://u:p@ep-example-pooler.c-2.us-east-2.aws.neon.tech/db';

describe('gateway database connection configuration', () => {
  it('returns null (no database) when nothing is configured', () => {
    assert.equal(buildPoolConfig({}), null);
    assert.equal(buildPoolConfig({ DATABASE_URL: '   ' }), null);
  });

  it('verifies the server certificate for a remote database', () => {
    const c = buildPoolConfig({ DATABASE_URL: remote })!;
    assert.deepEqual(c.ssl, { rejectUnauthorized: true });
  });

  it('a connection-string sslmode cannot weaken verification', () => {
    for (const qs of ['sslmode=no-verify', 'sslmode=disable', 'sslmode=require&uselibpqcompat=true', 'ssl=false']) {
      const c = buildPoolConfig({ DATABASE_URL: `${remote}?${qs}&application_name=gw` })!;
      assert.deepEqual(c.ssl, { rejectUnauthorized: true });
      assert.ok(!/sslmode|uselibpqcompat|ssl=/.test(c.connectionString!));
      assert.ok(c.connectionString!.includes('application_name=gw'));
    }
  });

  it('only a local database runs without TLS', () => {
    assert.equal(buildPoolConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5432/d' })!.ssl, false);
    assert.equal(isLocalDatabaseUrl('postgresql://u:p@localhost.evil.com/d'), false);
    assert.equal(isLocalDatabaseUrl('nope'), false);
  });

  it('GATEWAY_DATABASE_URL takes precedence over DATABASE_URL', () => {
    const c = buildPoolConfig({ GATEWAY_DATABASE_URL: 'postgresql://gw:p@localhost:5432/gwdb', DATABASE_URL: remote })!;
    assert.match(c.connectionString!, /gw:p@localhost:5432\/gwdb/);
  });

  it('bounds connections and statements', () => {
    const c = buildPoolConfig({ DATABASE_URL: remote })!;
    assert.equal(c.max, 3);
    assert.equal(c.statement_timeout, 20000);
    assert.equal(c.connectionTimeoutMillis, 10000);
  });

  it('never carries a certificate-verification bypass in source', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../db.ts', import.meta.url)), 'utf8');
    assert.ok(!/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/.test(src));
  });
});
