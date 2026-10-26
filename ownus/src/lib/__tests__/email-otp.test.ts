import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, before, after, beforeEach } from 'node:test';
import {
  REGISTER_WITH_PROOF_SQL,
  generateOtp,
  hashClientAddress,
  hashEmailOtp,
  hashProof,
  maskEmail,
  normalizeEmail,
  normalizeOtp,
  parseProof,
  registrationOtpRequired,
  sendEmailOtp,
  verifyEmailOtp,
  type GatewayDb,
} from '../email-otp.ts';

/**
 * The web gateway can answer sign-up itself, so it must enforce the same e-mail proof as the NestJS API. The SQL here is the text the route
 * sends, run against in-memory PostgreSQL (PGlite from the repository root install) on the REAL migration that creates the table. If PGlite is
 * not installed the database tests are skipped, never passed.
 */
const ENV = { JWT_ACCESS_SECRET: 'known-answer-secret-not-a-real-one' } as NodeJS.ProcessEnv;
const MIGRATION = path.resolve(import.meta.dirname, '../../../../apps/api/src/database/migrations/0026_email_otp_challenges.sql');

describe('gateway e-mail code: pure helpers', () => {
  it('known-answer vectors identical to the API package (apps/api email-otp.util.spec.ts)', () => {
    assert.equal(hashEmailOtp('user@example.com', 'REGISTER', '123456', ENV), 'a5693aa3b1e342b78ee6eb108b4c207795554197d8d6971904e6fcd2bfb49d1d');
    assert.equal(hashProof('proof-secret-value'), '2920973f72027b062d6768a08d153feb4cf549e6047001751ba1dbc9cb394781');
    assert.equal(hashClientAddress('203.0.113.7', ENV), 'f13739026d3df149673d91213d001e88');
    assert.equal(hashClientAddress('unknown', ENV), null);
  });

  it('normalises like the API', () => {
    assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
    for (const bad of ['', 'a@b', 'a b@x.com', 'a@@x.com', null, 5]) assert.equal(normalizeEmail(bad as any), null);
    assert.equal(normalizeOtp('123 456'), '123456');
    assert.equal(normalizeOtp('12345'), null);
    assert.match(generateOtp(), /^\d{6}$/);
    assert.equal(maskEmail('ada@example.com'), 'a***a@e***e.com');
    const id = '11111111-2222-4333-8444-555555555555';
    assert.equal(parseProof(`${id}.${'A'.repeat(43)}`)?.id, id);
    assert.equal(parseProof('garbage'), null);
  });

  it('production cannot switch the requirement off', () => {
    assert.equal(registrationOtpRequired({ NODE_ENV: 'production', REQUIRE_REGISTRATION_OTP: 'false' } as any), true);
    assert.equal(registrationOtpRequired({ NODE_ENV: 'development', REQUIRE_REGISTRATION_OTP: 'false' } as any), false);
    assert.equal(registrationOtpRequired({ NODE_ENV: 'development' } as any), true);
  });
});

describe('gateway e-mail code: store against PostgreSQL', () => {
  let pg: any = null;
  let skipReason = '';
  let gdb: GatewayDb;
  let sent: Array<{ email: string; code: string }> = [];
  let mailOk = true;
  const mailer = async (email: string, code: string) => {
    if (!mailOk) return false;
    sent.push({ email, code });
    return true;
  };
  const exists = (set: Set<string>) => async (e: string) => set.has(e);
  const send = (email: string, extra: Record<string, unknown> = {}, accounts = new Set<string>()) =>
    sendEmailOtp(gdb, { email, ip: '203.0.113.7', accountExists: exists(accounts), mailer, ...extra } as any, ENV);
  const verify = (email: string, otp: string) => verifyEmailOtp(gdb, { email, otp }, ENV);
  const lastCode = (email: string) => [...sent].reverse().find((s) => s.email === email)!.code;
  const register = async (email: string, token: string, id = crypto.randomUUID()) => {
    const p = parseProof(token);
    if (!p) return [];
    return (await pg.query(REGISTER_WITH_PROOF_SQL, [id, email, 'hash', 'Ada', 'L', 'Ada L', null, null, '{}', p.id, p.hash])).rows;
  };

  before(async () => {
    try {
      const mod: any = await import('@electric-sql/pglite');
      pg = new mod.PGlite();
      const ddl = fs.readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint').join('\n');
      await pg.exec(ddl);
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
    sent = [];
    mailOk = true;
    if (pg) await pg.exec('DELETE FROM email_otp_challenges; DELETE FROM users;');
  });

  it('sends one code to the typed address and stores only a keyed hash', async (t) => {
    if (!pg) return t.skip(skipReason);
    const r = await send('Ada@Example.com');
    assert.equal(r.status, 200);
    assert.equal(r.body.expiresInSeconds, 300);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].email, 'ada@example.com');
    const rows = (await pg.query('SELECT * FROM email_otp_challenges')).rows;
    assert.equal(rows.length, 1);
    assert.match(rows[0].otp_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(rows[0]).includes(sent[0].code));
    assert.ok(!JSON.stringify(r.body).includes(sent[0].code));
    assert.equal(rows[0].otp_hash, hashEmailOtp('ada@example.com', 'REGISTER', sent[0].code, ENV));
  });

  it('refuses a malformed address or an unknown purpose and sends nothing', async (t) => {
    if (!pg) return t.skip(skipReason);
    assert.equal((await send('nope')).status, 400);
    assert.equal((await send('ada@example.com', { purpose: 'LOGIN' })).status, 400);
    assert.equal(sent.length, 0);
  });

  it('enforces the 60 second cooldown, replaces the earlier code, and caps a day at 10 and a network at 20 an hour', async (t) => {
    if (!pg) return t.skip(skipReason);
    assert.equal((await send('ada@example.com')).status, 200);
    const early = await send('ada@example.com');
    assert.equal(early.status, 429);
    assert.equal(early.body.errorCode, 'OTP_RESEND_COOLDOWN');
    assert.equal(sent.length, 1);
    const first = lastCode('ada@example.com');
    await pg.exec(`UPDATE email_otp_challenges SET created_at = created_at - interval '2 minutes'`);
    assert.equal((await send('ada@example.com')).status, 200);
    assert.equal((await pg.query(`SELECT count(*)::int AS n FROM email_otp_challenges WHERE invalidated_at IS NULL AND consumed_at IS NULL`)).rows[0].n, 1);
    const second = lastCode('ada@example.com');
    if (first !== second) assert.equal((await verify('ada@example.com', first)).status, 400);
    assert.equal((await verify('ada@example.com', second)).status, 200);

    for (let i = 0; i < 10; i++) {
      await pg.exec(`UPDATE email_otp_challenges SET created_at = created_at - interval '2 minutes'`);
      assert.equal((await send('bob@example.com')).status, 200);
    }
    await pg.exec(`UPDATE email_otp_challenges SET created_at = created_at - interval '2 minutes'`);
    const over = await send('bob@example.com');
    assert.equal(over.status, 429);
    assert.equal(over.body.errorCode, 'OTP_DAILY_LIMIT');

    await pg.exec('DELETE FROM email_otp_challenges');
    for (let i = 0; i < 20; i++) assert.equal((await send(`u${i}@example.com`)).status, 200);
    const net = await send('u99@example.com');
    assert.equal(net.status, 429);
    assert.equal(net.body.errorCode, 'OTP_RATE_LIMITED');
  });

  it('a mail failure is a 503, leaves no row, and does not start a cooldown', async (t) => {
    if (!pg) return t.skip(skipReason);
    mailOk = false;
    const r = await send('ada@example.com');
    assert.equal(r.status, 503);
    assert.equal(r.body.errorCode, 'EMAIL_DELIVERY_FAILED');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM email_otp_challenges')).rows[0].n, 0);
    mailOk = true;
    assert.equal((await send('ada@example.com')).status, 200);
  });

  it('an address that already has an account gets the same answer, no mail, and the same lockout', async (t) => {
    if (!pg) return t.skip(skipReason);
    const accounts = new Set(['ada@example.com']);
    const a = await send('ada@example.com', {}, accounts);
    const b = await send('new@example.com', {}, accounts);
    assert.equal(a.status, b.status);
    assert.deepEqual(Object.keys(a.body).sort(), Object.keys(b.body).sort());
    assert.deepEqual(sent.map((s) => s.email), ['new@example.com']);
    const errs: string[] = [];
    for (const c of ['000001', '000002', '000003', '000004', '000005']) errs.push(String((await verify('ada@example.com', c)).body.errorCode));
    assert.deepEqual(errs, ['OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID', 'OTP_ATTEMPTS_EXCEEDED']);
  });

  it('an address that already has an account is told by e-mail why no code arrives, and the answer stays identical', async (t) => {
    if (!pg) return t.skip(skipReason);
    const accounts = new Set(['ada@example.com']);
    const notices: string[] = [];
    const existingAccountMailer = async (e: string) => {
      notices.push(e);
      return true;
    };
    const a = await send('ada@example.com', { existingAccountMailer }, accounts);
    const b = await send('new@example.com', { existingAccountMailer }, accounts);
    assert.equal(a.status, b.status);
    assert.deepEqual(Object.keys(a.body).sort(), Object.keys(b.body).sort());
    assert.deepEqual(notices, ['ada@example.com']); // the notice goes to the existing address only
    assert.deepEqual(sent.map((s) => s.email), ['new@example.com']); // and only the new address receives a code
    // a failing notice never changes what the visitor sees
    const failing = async () => {
      throw new Error('provider down');
    };
    const c = await send('ada2@example.com', { existingAccountMailer: failing }, new Set(['ada2@example.com']));
    assert.equal(c.status, 200);
  });

  it('verifies the right code once; wrong, expired, reused and locked codes fail', async (t) => {
    if (!pg) return t.skip(skipReason);
    await send('ada@example.com');
    const good = lastCode('ada@example.com');
    const wrong = good === '000000' ? '111111' : '000000';
    const w = await verify('ada@example.com', wrong);
    assert.equal(w.status, 400);
    assert.equal((w.body.details as any).attemptsRemaining, 4);
    const ok = await verify('ada@example.com', good);
    assert.equal(ok.status, 200);
    assert.match(String(ok.body.verificationToken), /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/);
    assert.equal(ok.body.accessToken, undefined);
    assert.equal((await verify('ada@example.com', good)).status, 400); // replay

    await pg.exec('DELETE FROM email_otp_challenges');
    await send('lock@example.com');
    const g2 = lastCode('lock@example.com');
    const w2 = g2 === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) await verify('lock@example.com', w2);
    assert.equal((await verify('lock@example.com', w2)).status, 429);
    assert.equal((await verify('lock@example.com', g2)).body.errorCode, 'OTP_ATTEMPTS_EXCEEDED');

    await pg.exec('DELETE FROM email_otp_challenges');
    await send('exp@example.com');
    const g3 = lastCode('exp@example.com');
    await pg.exec(`UPDATE email_otp_challenges SET expires_at = now() - interval '1 second'`);
    assert.equal((await verify('exp@example.com', g3)).body.errorCode, 'OTP_EXPIRED');
  });

  it('parallel correct submissions: exactly one succeeds; parallel guesses never exceed the limit', async (t) => {
    if (!pg) return t.skip(skipReason);
    await send('ada@example.com');
    const good = lastCode('ada@example.com');
    const results = await Promise.all(Array.from({ length: 6 }, () => verify('ada@example.com', good)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    await pg.exec('DELETE FROM email_otp_challenges');
    await send('g@example.com');
    const g = lastCode('g@example.com');
    const bad = g === '000000' ? '111111' : '000000';
    await Promise.all(Array.from({ length: 20 }, () => verify('g@example.com', bad)));
    assert.ok((await pg.query('SELECT attempts FROM email_otp_challenges')).rows[0].attempts <= 5);
  });

  it('the account is created only with a live, unspent proof for exactly that address, and only once', async (t) => {
    if (!pg) return t.skip(skipReason);
    await send('ada@example.com');
    const token = String((await verify('ada@example.com', lastCode('ada@example.com'))).body.verificationToken);
    assert.equal((await register('other@example.com', token)).length, 0); // another address
    assert.equal((await register('ada@example.com', `${crypto.randomUUID()}.${'A'.repeat(43)}`)).length, 0); // a made-up proof
    assert.equal((await register('ada@example.com', token)).length, 1);
    const u = (await pg.query(`SELECT is_email_verified, email_verified_at FROM users WHERE email = 'ada@example.com'`)).rows[0];
    assert.equal(u.is_email_verified, true);
    assert.ok(u.email_verified_at);
    assert.equal((await register('ada@example.com', token)).length, 0); // spent
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
  });

  it('a code that was sent but never verified is no proof, and an expired proof is refused', async (t) => {
    if (!pg) return t.skip(skipReason);
    await send('ada@example.com');
    const row = (await pg.query('SELECT id FROM email_otp_challenges')).rows[0];
    assert.equal((await register('ada@example.com', `${row.id}.${'A'.repeat(43)}`)).length, 0);
    const token = String((await verify('ada@example.com', lastCode('ada@example.com'))).body.verificationToken);
    await pg.exec(`UPDATE email_otp_challenges SET proof_expires_at = now() - interval '1 second'`);
    assert.equal((await register('ada@example.com', token)).length, 0);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  });

  it('a failed insert (duplicate address) rolls the proof back, so it is not used up', async (t) => {
    if (!pg) return t.skip(skipReason);
    await send('ada@example.com');
    const token = String((await verify('ada@example.com', lastCode('ada@example.com'))).body.verificationToken);
    await pg.query(`INSERT INTO users (id, email) VALUES ($1, 'ada@example.com')`, [crypto.randomUUID()]);
    await assert.rejects(() => register('ada@example.com', token));
    const row = (await pg.query('SELECT proof_consumed_at FROM email_otp_challenges')).rows[0];
    assert.equal(row.proof_consumed_at, null);
  });
});

describe('gateway route wiring (structural guard)', () => {
  const route = fs.readFileSync(path.resolve(import.meta.dirname, '../../app/api/v1/[...path]/route.ts'), 'utf8');
  const fn = (name: string) => {
    const start = route.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const next = route.indexOf('\nasync function ', start + 10);
    return route.slice(start, next > 0 ? next : undefined);
  };

  it('native register demands the proof and spends it in the same statement as the insert', () => {
    const body = fn('handleRegister');
    assert.ok(body.includes('registrationOtpRequired()'));
    assert.ok(body.includes('EMAIL_OTP_REQUIRED'));
    assert.ok(body.includes('REGISTER_WITH_PROOF_SQL'));
    const plain = body.indexOf('INSERT INTO users');
    assert.ok(plain > body.indexOf('if (otpRequired && proof)'), 'the plain insert only exists in the branch that runs when OTP is switched off');
    assert.ok(plain > body.indexOf('} else {'), 'the plain insert sits in the else branch');
  });

  it('the code routes are dispatched and public', () => {
    assert.ok(route.includes("fullPath === 'auth/send-otp'") && route.includes("fullPath === 'auth/verify-otp'"));
    assert.ok(route.includes('handleSendOtp(req)') && route.includes('handleVerifyOtp(req)'));
    const policy = fs.readFileSync(path.resolve(import.meta.dirname, '../gateway-auth.ts'), 'utf8');
    assert.ok(policy.includes("'auth/send-otp'") && policy.includes("'auth/verify-otp'"));
  });
});
