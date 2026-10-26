import supertest from 'supertest';
const request = (supertest as any).default || supertest;
import { INestApplication, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { eq, like, sql } from 'drizzle-orm';
import { TestAppHelper } from './helpers/test-app.helper';
import * as schema from '../src/database/schema';
import { MailService, IMail } from '../src/auth/mail/mail.service';
import { EmailOtpService } from '../src/auth/services/email-otp.service';
import { UserRepository } from '../src/modules/user/user.repository';
import { DRIZZLE_DATABASE } from '../src/database/database.constants';

/**
 * Sign-up e-mail verification (6-digit code) on the real application over HTTP. The mail provider is replaced by an in-memory capture, so
 * nothing is ever sent; the code is read from the captured message exactly as a user would read it from their inbox. No test hook exists in
 * the application: the server has no way to reveal a code except by e-mail.
 */
describe('Sign-up e-mail verification code', () => {
  let testApp: TestAppHelper;
  let app: INestApplication;
  const api = () => request(app.getHttpServer());
  const unwrap = (res: any) => res.body.data || res.body;
  const errorOf = (res: any) => res.body?.errorCode || res.body?.error?.errorCode || res.body?.data?.errorCode || res.body?.details?.errorCode;
  const tag = `otp32.${Date.now()}`;
  const emails: string[] = [];
  let outbox: IMail[] = [];
  let failMail = false;
  let seq = 0;
  const previousFlag = process.env.REQUIRE_REGISTRATION_OTP;

  const newEmail = (label = 'u') => {
    const e = `${tag}.${label}${++seq}@orion-test.io`;
    emails.push(e);
    return e;
  };
  const clearLimits = () => (app.get(ThrottlerStorage) as any).storage.clear();
  const send = (email: string, extra: Record<string, unknown> = {}) => {
    clearLimits();
    return api().post('/api/v1/auth/send-otp').send({ email, ...extra });
  };
  const verify = (email: string, otp: string, extra: Record<string, unknown> = {}) => {
    clearLimits();
    return api().post('/api/v1/auth/verify-otp').send({ email, otp, ...extra });
  };
  const register = (email: string, verificationToken?: string, extra: Record<string, unknown> = {}) => {
    clearLimits();
    return api().post('/api/v1/auth/register').send({ email, password: 'OtpPass123!', firstName: 'Ot', lastName: 'P', ...(verificationToken ? { verificationToken } : {}), ...extra });
  };
  const codeFor = (email: string): string => {
    const mail = [...outbox].reverse().find((m) => m.to === email);
    if (!mail) throw new Error(`no code mail captured for ${email}`);
    const m = mail.text.match(/code is (\d{6})/);
    if (!m) throw new Error('code not found in mail text');
    return m[1];
  };
  const rows = (email: string) => (testApp.db as any).select().from(schema.emailOtpChallenges).where(eq(schema.emailOtpChallenges.email, email));
  const usersOf = (email: string) => (testApp.db as any).select().from(schema.users).where(eq(schema.users.email, email));
  /** A verified address: send, read the code from the mail, verify; returns the one-time proof. */
  const proofFor = async (email: string) => {
    expect((await send(email)).status).toBe(200);
    const res = await verify(email, codeFor(email));
    expect(res.status).toBe(200);
    return unwrap(res).verificationToken as string;
  };
  const backdate = (seconds: number) => (testApp.db as any).execute(sql`UPDATE email_otp_challenges SET created_at = created_at - make_interval(secs => ${seconds})`);

  beforeAll(async () => {
    process.env.REQUIRE_REGISTRATION_OTP = 'true';
    testApp = new TestAppHelper();
    app = await testApp.init();
    app.get(MailService).transport = {
      send: async (m) => {
        if (failMail) throw new Error('provider down');
        outbox.push(m);
      },
    };
  });
  beforeEach(async () => {
    outbox = [];
    failMail = false;
    await (testApp.db as any).execute(sql`DELETE FROM email_otp_challenges`);
  });
  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.REQUIRE_REGISTRATION_OTP;
    else process.env.REQUIRE_REGISTRATION_OTP = previousFlag;
    await testApp.cleanupUsers(emails);
    await testApp.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('sending the code', () => {
    it('1-2. a valid address gets one message, to exactly that address, with a 6-digit code, an expiry notice and a do-not-share warning', async () => {
      const email = newEmail();
      const res = await send(email);
      expect(res.status).toBe(200);
      const body = unwrap(res);
      expect(body).toMatchObject({ success: true, expiresInSeconds: 300, resendAfterSeconds: 60 });
      expect(body.message).toMatch(/if this email can be used/i);
      expect(body.maskedEmail).toMatch(/\*\*\*/);
      expect(body.maskedEmail).not.toContain(email.split('@')[0]);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].to).toBe(email);
      const code = codeFor(email);
      expect(code).toMatch(/^\d{6}$/);
      expect(outbox[0].text).toMatch(/5 minutes/);
      expect(outbox[0].text).toMatch(/never share/i);
      expect(outbox[0].html).toContain('Do not share this code');
      expect(outbox[0].html).toContain(`${code.slice(0, 3)} ${code.slice(3)}`);
      expect(outbox[0].subject).not.toContain(code); // the subject is shown on lock screens
      expect(outbox[0].sensitive).toBe(true);
      // the response never carries the code
      expect(JSON.stringify(res.body)).not.toContain(code);
    });

    it('addresses are normalised: case and surrounding spaces do not create a second identity', async () => {
      const email = newEmail();
      const res = await send(`  ${email.toUpperCase()}  `);
      expect(res.status).toBe(200);
      expect(outbox[0].to).toBe(email);
      expect(await rows(email)).toHaveLength(1);
    });

    it('rejects a malformed address, an unknown purpose and non-text values with a validation error, and sends nothing', async () => {
      for (const bad of ['', 'not-an-email', 'a@b', 'two@@x.com', 'sp ace@x.com', 'x'.repeat(260) + '@x.com']) {
        expect([400]).toContain((await send(bad)).status);
      }
      expect((await send(newEmail(), { purpose: 'LOGIN' })).status).toBe(400);
      expect((await send(12345 as any)).status).toBe(400);
      expect((await api().post('/api/v1/auth/send-otp').send({})).status).toBe(400);
      expect(outbox).toHaveLength(0);
    });

    it('stores only a keyed hash: no table value equals or contains the code, and the row is bound to the address and purpose', async () => {
      const email = newEmail();
      await send(email);
      const code = codeFor(email);
      const [row] = await rows(email);
      expect(row.otpHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(code);
      expect(row).toMatchObject({ purpose: 'REGISTER', attempts: 0, maxAttempts: 5, consumedAt: null });
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual(299_000);
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(301_000);
      expect(row.ipHash).toMatch(/^[0-9a-f]{32}$/); // a keyed digest, not the address
    });

    it('10. a mail-provider failure is a safe 503: no code, no row, no secret in the answer, and the user can retry at once', async () => {
      const email = newEmail();
      failMail = true;
      const res = await send(email);
      expect(res.status).toBe(503);
      expect(errorOf(res)).toBe('EMAIL_DELIVERY_FAILED');
      // only the fields written for the user: the request id (a UUID) can legitimately contain six digits in a row
      expect(`${res.body.message} ${res.body.errorCode}`).not.toMatch(/provider down|smtp|password|\d{6}/i);
      expect(await rows(email)).toHaveLength(0);
      failMail = false;
      expect((await send(email)).status).toBe(200); // not stuck behind a cooldown for a message that never left
      expect(outbox).toHaveLength(1);
    });

    it('a transport that is not configured (code only logged) is also a delivery failure, and the code is never written to the log', async () => {
      const mail = app.get(MailService);
      const saved = mail.transport;
      mail.transport = undefined;
      const lines: string[] = [];
      const spies = (['log', 'warn', 'error'] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation((msg: any) => void lines.push(String(msg))));
      try {
        const res = await send(newEmail());
        expect(res.status).toBe(503);
        const joined = lines.join('\n');
        expect(joined).toContain('withheld');
        expect(joined).not.toMatch(/\b\d{6}\b/);
      } finally {
        spies.forEach((s) => s.mockRestore());
        mail.transport = saved;
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('verifying the code', () => {
    it('3-4. the correct code verifies, creates NO account and NO session, and returns a one-time proof', async () => {
      const email = newEmail();
      await send(email);
      const res = await verify(email, codeFor(email));
      expect(res.status).toBe(200);
      const body = unwrap(res);
      expect(body).toMatchObject({ success: true, verified: true });
      expect(body.verificationToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/);
      expect(JSON.stringify(res.body)).not.toMatch(/accessToken|refreshToken|"user"/);
      expect(await usersOf(email)).toHaveLength(0);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('a pasted code with spaces or a dash is accepted', async () => {
      const email = newEmail();
      await send(email);
      const c = codeFor(email);
      expect((await verify(email, `${c.slice(0, 3)} ${c.slice(3)}`)).status).toBe(200);
    });

    it('5. a wrong code fails with the number of attempts left, and does not verify', async () => {
      const email = newEmail();
      await send(email);
      const good = codeFor(email);
      const wrong = good === '000000' ? '111111' : '000000';
      const r1 = await verify(email, wrong);
      expect(r1.status).toBe(400);
      expect(errorOf(r1)).toBe('OTP_INVALID');
      expect(r1.body.details?.attemptsRemaining ?? r1.body.error?.details?.attemptsRemaining).toBe(4);
      const r2 = await verify(email, wrong);
      expect(r2.body.details?.attemptsRemaining ?? r2.body.error?.details?.attemptsRemaining).toBe(3);
      expect(JSON.stringify(r2.body)).not.toContain(good);
      expect((await verify(email, 'abcdef')).status).toBe(400);
      expect((await verify(email, '12345')).status).toBe(400);
    });

    it('6. an expired code fails and says so', async () => {
      const email = newEmail();
      await send(email);
      await (testApp.db as any).execute(sql`UPDATE email_otp_challenges SET expires_at = now() - interval '1 second'`);
      const res = await verify(email, codeFor(email));
      expect(res.status).toBe(400);
      expect(errorOf(res)).toBe('OTP_EXPIRED');
    });

    it('7. a code cannot be used twice (replay)', async () => {
      const email = newEmail();
      await send(email);
      const code = codeFor(email);
      expect((await verify(email, code)).status).toBe(200);
      const again = await verify(email, code);
      expect(again.status).toBe(400);
      expect(errorOf(again)).toBe('OTP_INVALID');
    });

    it('8. after 5 wrong tries the code is locked: even the correct code no longer works', async () => {
      const email = newEmail();
      await send(email);
      const good = codeFor(email);
      const wrong = good === '000000' ? '111111' : '000000';
      for (let i = 0; i < 4; i++) expect(errorOf(await verify(email, wrong))).toBe('OTP_INVALID');
      const fifth = await verify(email, wrong);
      expect(fifth.status).toBe(429);
      expect(errorOf(fifth)).toBe('OTP_ATTEMPTS_EXCEEDED');
      const late = await verify(email, good);
      expect(late.status).toBe(429);
      expect(errorOf(late)).toBe('OTP_ATTEMPTS_EXCEEDED');
      const [row] = await rows(email);
      expect(row.lockedAt).not.toBeNull();
      expect(row.attempts).toBe(5); // never more than the limit, however many requests came
    });

    it('a code is bound to its address and purpose: another address, or another purpose, cannot use it', async () => {
      const a = newEmail('a');
      const b = newEmail('b');
      await send(a);
      await send(b);
      const codeA = codeFor(a);
      expect((await verify(b, codeA)).status).toBe(400);
      expect((await verify(a, codeA, { purpose: 'LOGIN' })).status).toBe(400);
      expect((await verify(a, codeA)).status).toBe(200);
    });

    it('verifying an address that was never sent a code is the same generic failure', async () => {
      const res = await verify(newEmail(), '123456');
      expect(res.status).toBe(400);
      expect(errorOf(res)).toBe('OTP_INVALID');
    });

    it('16a. two parallel submissions of the correct code: exactly one succeeds', async () => {
      const email = newEmail();
      await send(email);
      const code = codeFor(email);
      clearLimits();
      const results = await Promise.all(Array.from({ length: 6 }, () => api().post('/api/v1/auth/verify-otp').send({ email, otp: code })));
      const ok = results.filter((r) => r.status === 200);
      expect(ok).toHaveLength(1);
      expect(results.filter((r) => r.status !== 200).every((r) => [400, 429].includes(r.status))).toBe(true);
    });

    it('parallel guessing cannot exceed the attempt limit', async () => {
      const email = newEmail();
      await send(email);
      const good = codeFor(email);
      const wrong = good === '000000' ? '111111' : '000000';
      clearLimits();
      await Promise.all(Array.from({ length: 20 }, () => api().post('/api/v1/auth/verify-otp').send({ email, otp: wrong })));
      const [row] = await rows(email);
      expect(row.attempts).toBeLessThanOrEqual(5);
      expect((await verify(email, good)).status).toBe(429);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('resending', () => {
    it('9. a second request inside 60 seconds is refused with the wait time, and sends nothing', async () => {
      const email = newEmail();
      expect((await send(email)).status).toBe(200);
      const again = await send(email);
      expect(again.status).toBe(429);
      expect(errorOf(again)).toBe('OTP_RESEND_COOLDOWN');
      expect(again.body.details?.retryAfterSeconds ?? again.body.error?.details?.retryAfterSeconds).toBeGreaterThan(0);
      expect(outbox).toHaveLength(1);
    });

    it('after the cooldown a NEW code is issued; the earlier code stops working', async () => {
      const email = newEmail();
      await send(email);
      const first = codeFor(email);
      await backdate(61);
      expect((await send(email)).status).toBe(200);
      expect(outbox).toHaveLength(2);
      const second = codeFor(email);
      const live = (await rows(email)).filter((r: any) => !r.invalidatedAt && !r.consumedAt);
      expect(live).toHaveLength(1);
      if (first !== second) {
        expect((await verify(email, first)).status).toBe(400); // the replaced code is dead
      }
      expect((await verify(email, second)).status).toBe(200);
    });

    it('a verified address invalidates every other open code for it', async () => {
      const email = newEmail();
      await send(email);
      const code = codeFor(email);
      // another open code for the same address (as if two sends raced)
      await (testApp.db as any).execute(sql`INSERT INTO email_otp_challenges (email, purpose, otp_hash, expires_at) VALUES (${email}, 'REGISTER', ${'f'.repeat(64)}, now() + interval '5 minutes')`);
      expect((await rows(email)).filter((r: any) => !r.invalidatedAt && !r.consumedAt)).toHaveLength(2);
      // the newest row is the planted one, so the real code is no longer the live one; make the real one newest
      await (testApp.db as any).execute(sql`UPDATE email_otp_challenges SET created_at = created_at - interval '1 minute' WHERE otp_hash = ${'f'.repeat(64)}`);
      expect((await verify(email, code)).status).toBe(200);
      expect((await rows(email)).filter((r: any) => !r.invalidatedAt && !r.consumedAt)).toHaveLength(0);
    });

    it('18. at most 10 codes per address per day, even with the cooldown respected', async () => {
      const email = newEmail();
      for (let i = 0; i < 10; i++) {
        expect((await send(email)).status).toBe(200);
        await backdate(120);
      }
      const res = await send(email);
      expect(res.status).toBe(429);
      expect(errorOf(res)).toBe('OTP_DAILY_LIMIT');
    });

    it('18. at most 20 requests per network address per hour, across different addresses', async () => {
      for (let i = 0; i < 20; i++) expect((await send(newEmail('ip'))).status).toBe(200);
      const res = await send(newEmail('ip'));
      expect(res.status).toBe(429);
      expect(errorOf(res)).toBe('OTP_RATE_LIMITED');
    });

    it('the route also has a short-term request limit per client', async () => {
      (app.get(ThrottlerStorage) as any).storage.clear();
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await api().post('/api/v1/auth/send-otp').send({ email: 'not-an-email' })).status);
      expect(statuses).toContain(429);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('creating the account', () => {
    it('12. registration without a proof is refused: no account, no session', async () => {
      const email = newEmail();
      const res = await register(email);
      expect(res.status).toBe(403);
      expect(errorOf(res)).toBe('EMAIL_OTP_REQUIRED');
      expect(JSON.stringify(res.body)).not.toMatch(/accessToken|refreshToken/);
      expect(await usersOf(email)).toHaveLength(0);
      for (const bad of ['', 'garbage', 'x.y', '00000000-0000-4000-8000-000000000000.' + 'A'.repeat(43), '../../etc/passwd']) {
        const r = await register(email, bad);
        expect([400, 403]).toContain(r.status);
      }
      expect(await usersOf(email)).toHaveLength(0);
    });

    it('a verified address registers: account created with the address marked verified, session issued only now', async () => {
      const email = newEmail();
      const token = await proofFor(email);
      const res = await register(email, token);
      expect(res.status).toBe(201);
      const body = unwrap(res);
      expect(body.tokens.accessToken).toBeDefined();
      expect(body.user.email).toBe(email);
      expect(body.user.isEmailVerified).toBe(true);
      const [u] = await usersOf(email);
      expect(u.isEmailVerified).toBe(true);
      expect(u.emailVerifiedAt).not.toBeNull();
      // the new session works
      expect((await api().get('/api/v1/user/profile').set('Authorization', `Bearer ${body.tokens.accessToken}`)).status).toBe(200);
    });

    it('the proof is single use and tied to the address it was issued for', async () => {
      const a = newEmail('a');
      const b = newEmail('b');
      const tokenA = await proofFor(a);
      const wrongAddress = await register(b, tokenA);
      expect(wrongAddress.status).toBe(403);
      expect(await usersOf(b)).toHaveLength(0);
      expect((await register(a, tokenA)).status).toBe(201);
      const reuse = await register(newEmail('c'), tokenA);
      expect(reuse.status).toBe(403);
      const replay = await register(a, tokenA);
      expect([403, 409]).toContain(replay.status);
      expect(await usersOf(a)).toHaveLength(1);
    });

    it('11. a duplicate registration is refused and does not spend the proof', async () => {
      const email = newEmail();
      expect((await register(email, await proofFor(email))).status).toBe(201);
      await backdate(120);
      // an address that has an account can request a code (generic answer) but receives no code: only a notice that the account exists
      outbox = [];
      expect((await send(email)).status).toBe(200);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].text).not.toMatch(/\b\d{6}\b/);
      const dup = await register(email, 'any.' + 'A'.repeat(43));
      expect([403, 409]).toContain(dup.status);
      expect(await usersOf(email)).toHaveLength(1);
    });

    it('16b. eight parallel registrations with one proof create exactly one account and one session', async () => {
      const email = newEmail();
      const token = await proofFor(email);
      clearLimits();
      const results = await Promise.all(Array.from({ length: 8 }, () => api().post('/api/v1/auth/register').send({ email, password: 'OtpPass123!', firstName: 'Pa', lastName: 'R', verificationToken: token })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 201).every((r) => [403, 409].includes(r.status))).toBe(true);
      expect(await usersOf(email)).toHaveLength(1);
      expect(results.filter((r) => JSON.stringify(r.body).includes('accessToken'))).toHaveLength(1);
    });

    it('a failed creation does not use up the proof (it is spent inside the same transaction)', async () => {
      const email = newEmail();
      const token = await proofFor(email);
      const weak = await register(email, token, { password: 'short' }); // refused by validation before anything is spent
      expect(weak.status).toBe(400);
      expect((await register(email, token)).status).toBe(201);
    });

    it('the browser cannot assert verification: extra fields are refused and a proof for a different purpose or an unverified row is useless', async () => {
      const email = newEmail();
      const res = await register(email, undefined, { isEmailVerified: true, emailVerified: true, role: 'ADMIN' });
      expect([400, 403]).toContain(res.status);
      expect(await usersOf(email)).toHaveLength(0);
      // a proof-shaped token for a code that was sent but never verified
      await send(email);
      const [row] = await rows(email);
      const forged = `${row.id}.${'A'.repeat(43)}`;
      expect((await register(email, forged)).status).toBe(403);
      expect(await usersOf(email)).toHaveLength(0);
    });

    it('the proof expires', async () => {
      const email = newEmail();
      const token = await proofFor(email);
      await (testApp.db as any).execute(sql`UPDATE email_otp_challenges SET proof_expires_at = now() - interval '1 second'`);
      expect((await register(email, token)).status).toBe(403);
      expect(await usersOf(email)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('no session or access before verification; existing flows intact', () => {
    it('13-14. neither the code step nor the proof is a credential: protected routes stay closed', async () => {
      const email = newEmail();
      const token = await proofFor(email);
      for (const path of ['/api/v1/user/profile', '/api/v1/credit/wallet', '/api/v1/unlock/history', '/api/v1/exports/history']) {
        expect((await api().get(path)).status).toBe(401);
        expect((await api().get(path).set('Authorization', `Bearer ${token}`)).status).toBe(401);
      }
      expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: token })).status).toBe(401);
    });

    it('15. an existing user still signs in with the password; the code is not a way in, and a wrong password still fails', async () => {
      const email = newEmail();
      expect((await register(email, await proofFor(email))).status).toBe(201);
      clearLimits();
      expect((await api().post('/api/v1/auth/login').send({ email, password: 'OtpPass123!' })).status).toBe(200);
      expect((await api().post('/api/v1/auth/login').send({ email, password: 'wrong-Pass-1!' })).status).toBe(401);
      // a code alone (no password) is not accepted by login
      await backdate(120);
      await send(email);
      expect((await api().post('/api/v1/auth/login').send({ email, otp: '123456' })).status).toBe(400);
      expect((await api().post('/api/v1/auth/login').send({ email, verificationToken: 'a.b' })).status).toBe(400);
    });

    it('an address that already has an account gets the same answer shape and no code; guessing is limited the same way', async () => {
      const existing = newEmail('ex');
      expect((await register(existing, await proofFor(existing))).status).toBe(201);
      await backdate(120);
      outbox = [];
      const fresh = newEmail('fr');
      const a = await send(existing);
      const b = await send(fresh);
      expect(a.status).toBe(b.status);
      expect(Object.keys(unwrap(a)).sort()).toEqual(Object.keys(unwrap(b)).sort());
      expect(unwrap(a).message).toBe(unwrap(b).message);
      // the screen cannot tell the two apart, but the owner of the existing address is told by e-mail why no code comes: a notice with the
      // sign-in links and NO code, while only the new address receives a code
      expect(outbox.map((m) => m.to).sort()).toEqual([existing, fresh].sort());
      const notice = outbox.find((m) => m.to === existing) as IMail;
      const codeMail = outbox.find((m) => m.to === fresh) as IMail;
      expect(notice.sensitive).toBeFalsy();
      expect(notice.text).toMatch(/already exists/i);
      expect(notice.text).toMatch(/\/login/);
      expect(notice.text).not.toMatch(/\b\d{6}\b/);
      expect(notice.html).not.toMatch(/\b\d{6}\b/);
      expect(codeMail.text).toMatch(/\b\d{6}\b/);
      // a code guessed for the existing address fails like any other and locks after 5
      const codes = ['000001', '000002', '000003', '000004', '000005'];
      const errs: string[] = [];
      for (const c of codes) errs.push(errorOf(await verify(existing, c)));
      expect(errs.slice(0, 4)).toEqual(Array(4).fill('OTP_INVALID'));
      expect(errs[4]).toBe('OTP_ATTEMPTS_EXCEEDED');
      expect(await usersOf(existing)).toHaveLength(1);
    });

    it('17. the state lives in the database, not in the process: a different service instance over the same database completes the check', async () => {
      const email = newEmail();
      await send(email);
      const code = codeFor(email);
      // a "restarted" service: nothing carried over except the database
      const fresh = new EmailOtpService(app.get(DRIZZLE_DATABASE), app.get(UserRepository), app.get(MailService));
      const res = await fresh.verify(email, code, 'REGISTER', { ipAddress: '203.0.113.9' });
      expect(res.verified).toBe(true);
      expect(await register(email, res.verificationToken)).toMatchObject({ status: 201 });
    });

    it('no code appears in audit rows or in error bodies; the address is only a digest', async () => {
      const email = newEmail();
      await send(email);
      const code = codeFor(email);
      const wrong = code === '000000' ? '111111' : '000000';
      const bad = await verify(email, wrong);
      await verify(email, code);
      const audits = await (testApp.db as any).select().from(schema.auditLogs).where(like(schema.auditLogs.action, 'EMAIL_OTP%'));
      expect(audits.length).toBeGreaterThanOrEqual(3);
      // the values written to the audit rows (ids and timestamps are excluded: they can contain any six digits by chance)
      const dump = JSON.stringify(audits.map((a: any) => [a.action, a.newValues, a.oldValues, a.failureCategory]));
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(wrong);
      expect(dump).not.toContain(email);
      expect(JSON.stringify(bad.body)).not.toContain(code);
    });
  });
});
