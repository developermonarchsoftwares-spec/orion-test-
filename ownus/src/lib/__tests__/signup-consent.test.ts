import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, before, after, beforeEach } from 'node:test';
import { parseProof, sendEmailOtp, verifyEmailOtp, type GatewayDb } from '../email-otp.ts';
import { REGISTER_WITH_PROOF_SQL_CONSENT, SIGNUP_CONSENT_ROWS_SQL, parseSignupConsents, signupConsentRequired } from '../signup-consent.ts';

/**
 * DPDP Act sign-up consent in the web gateway. The SQL is the text the route sends, run on in-memory PostgreSQL (PGlite) against the REAL
 * migrations that create the tables. If PGlite is not installed the database tests are skipped, never passed.
 */
const ENV = { JWT_ACCESS_SECRET: 'known-answer-secret-not-a-real-one' } as NodeJS.ProcessEnv;
const MIGRATIONS = path.resolve(import.meta.dirname, '../../../../apps/api/src/database/migrations');
const ddl = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint').join('\n');
const ALL = [{ purpose: 'ACCOUNT_SERVICE', granted: true }, { purpose: 'PRODUCT_UPDATES', granted: true }, { purpose: 'MARKETING', granted: false }];

describe('sign-up consent: pure rules', () => {
  it('is required in production whatever the switch says, and can be switched off elsewhere', () => {
    assert.equal(signupConsentRequired({ NODE_ENV: 'production', REQUIRE_SIGNUP_CONSENT: 'false' } as any), true);
    assert.equal(signupConsentRequired({ NODE_ENV: 'development', REQUIRE_SIGNUP_CONSENT: 'false' } as any), false);
    assert.equal(signupConsentRequired({ NODE_ENV: 'development' } as any), true);
  });
  it('only a real boolean true consents to the account purpose', () => {
    for (const bad of ['true', 1, false, null, undefined, [], 'ACCOUNT_SERVICE']) assert.equal(parseSignupConsents({ ACCOUNT_SERVICE: bad }).accountService, false, String(bad));
    assert.equal(parseSignupConsents(undefined).accountService, false);
    assert.equal(parseSignupConsents({ ACCOUNT_SERVICE: true }).accountService, true);
  });
  it('keeps explicit optional choices, refusals included, and ignores everything else', () => {
    const r = parseSignupConsents({ ACCOUNT_SERVICE: true, PRODUCT_UPDATES: true, MARKETING: false, ANALYTICS: true, SALE_SHARING: true, EXTRA: 1 });
    assert.deepEqual(r.rows, ALL);
    assert.deepEqual(parseSignupConsents({ ACCOUNT_SERVICE: true, MARKETING: 'yes' }).rows, [{ purpose: 'ACCOUNT_SERVICE', granted: true }]);
    assert.deepEqual(parseSignupConsents({ MARKETING: true }).rows, [{ purpose: 'MARKETING', granted: true }]);
  });
});

describe('sign-up consent: written with the account', () => {
  let pg: any = null;
  let skipReason = '';
  let gdb: GatewayDb;
  const sent: Array<{ email: string; code: string }> = [];
  const mailer = async (email: string, code: string) => (sent.push({ email, code }), true);
  const proofFor = async (email: string) => {
    await sendEmailOtp(gdb, { email, ip: '203.0.113.7', accountExists: async () => false, mailer } as any, ENV);
    const code = [...sent].reverse().find((s) => s.email === email)!.code;
    return String((await verifyEmailOtp(gdb, { email, otp: code }, ENV)).body.verificationToken);
  };
  const register = async (email: string, token: string, rows = ALL, id = crypto.randomUUID()) => {
    const p = parseProof(token);
    if (!p) return [];
    return (await pg.query(REGISTER_WITH_PROOF_SQL_CONSENT, [id, email, 'hash', 'Ada', 'L', 'Ada L', null, null, '{}', p.id, p.hash, JSON.stringify(rows), '2026-10-07', '203.0.113.7', 'jest'])).rows;
  };
  const ledger = async () => (await pg.query('SELECT * FROM consent_records ORDER BY purpose')).rows;

  before(async () => {
    try {
      const mod: any = await import('@electric-sql/pglite');
      pg = new mod.PGlite();
      await pg.exec(ddl('0026_email_otp_challenges.sql'));
      // only the consent_records table, taken verbatim from the real migration (the rest of 0023 alters tables this test does not create)
      await pg.exec(ddl('0023_privacy_compliance.sql').match(/CREATE TABLE IF NOT EXISTS "consent_records" \([\s\S]*?\);/)![0]);
      await pg.exec(`CREATE TABLE users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text, first_name text, last_name text, display_name text,
        organization_name text, phone_number text, role text, status text, provider text, metadata jsonb, is_email_verified boolean DEFAULT false,
        email_verified_at timestamptz, created_at timestamptz, updated_at timestamptz);`);
      gdb = {
        query: async (t, p = []) => (await pg.query(t, p)).rows,
        transaction: (fn) => pg.transaction((tx: any) => fn(async (t: string, p: unknown[] = []) => (await tx.query(t, p)).rows)),
      };
    } catch (e: any) {
      skipReason = `PGlite not available: ${e?.code ?? e?.message ?? 'import failed'}`;
    }
  });
  after(async () => {
    await pg?.close?.();
  });
  beforeEach(async () => {
    sent.length = 0;
    if (pg) await pg.exec('DELETE FROM email_otp_challenges; DELETE FROM consent_records; DELETE FROM users;');
  });

  it('creates the account and every consent row in one statement', async (t) => {
    if (!pg) return t.skip(skipReason);
    const token = await proofFor('ada@example.com');
    const out = await register('ada@example.com', token);
    assert.equal(out.length, 1);
    const rows = await ledger();
    assert.deepEqual(rows.map((r: any) => `${r.purpose}:${r.granted}`), ['ACCOUNT_SERVICE:true', 'MARKETING:false', 'PRODUCT_UPDATES:true']);
    for (const r of rows) {
      assert.equal(r.user_id, out[0].id);
      assert.equal(r.source, 'signup');
      assert.equal(r.policy_version, '2026-10-07');
      assert.equal(r.ip_address, '203.0.113.7');
    }
  });

  it('a proof that is not acceptable creates neither account nor consent', async (t) => {
    if (!pg) return t.skip(skipReason);
    const token = await proofFor('ada@example.com');
    assert.equal((await register('other@example.com', token)).length, 0);
    assert.equal((await register('ada@example.com', `${crypto.randomUUID()}.${'A'.repeat(43)}`)).length, 0);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
    assert.equal((await ledger()).length, 0);
  });

  it('a refused insert (duplicate address) leaves no consent rows and does not spend the proof', async (t) => {
    if (!pg) return t.skip(skipReason);
    const first = await proofFor('ada@example.com');
    assert.equal((await register('ada@example.com', first)).length, 1);
    await pg.exec('DELETE FROM email_otp_challenges');
    const second = await proofFor('ada@example.com');
    await assert.rejects(register('ada@example.com', second, ALL, crypto.randomUUID()));
    assert.equal((await ledger()).length, 3, 'only the first account has consent rows');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM email_otp_challenges WHERE proof_consumed_at IS NOT NULL')).rows[0].n, 0, 'the proof is still unspent');
  });

  it('the development path (no sign-up code) writes the same rows', async (t) => {
    if (!pg) return t.skip(skipReason);
    const id = crypto.randomUUID();
    await pg.query(`INSERT INTO users (id, email) VALUES ($1, 'dev@example.com')`, [id]);
    await pg.query(SIGNUP_CONSENT_ROWS_SQL, [id, JSON.stringify(ALL), '2026-10-07', null, 'jest']);
    assert.equal((await ledger()).length, 3);
  });
});

describe('sign-up consent: the route', () => {
  const route = fs.readFileSync(path.resolve(import.meta.dirname, '../../app/api/v1/[...path]/route.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = route.indexOf('async function handleRegister');
  const body = route.slice(start, route.indexOf('\nasync function ', start + 10) > 0 ? route.indexOf('\nasync function ', start + 10) : undefined);
  it('refuses an account without consent before any database work, and writes consent with the account', () => {
    assert.ok(body.includes('parseSignupConsents(body?.consents)'));
    assert.ok(body.includes("errorCode: 'CONSENT_REQUIRED'"));
    assert.ok(body.indexOf('CONSENT_REQUIRED') < body.indexOf('hashPassword('), 'checked before the password is hashed');
    assert.ok(body.includes('REGISTER_WITH_PROOF_SQL_CONSENT'));
    assert.ok(body.includes('SIGNUP_CONSENT_ROWS_SQL'));
  });
});
