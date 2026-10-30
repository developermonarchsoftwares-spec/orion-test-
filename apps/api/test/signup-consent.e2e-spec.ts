import supertest from 'supertest';
const request = (supertest as any).default || supertest;
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { eq } from 'drizzle-orm';
import { TestAppHelper } from './helpers/test-app.helper';
import * as schema from '../src/database/schema';

/**
 * DPDP Act: an account is created together with the person's explicit consent, over HTTP on the real application. The consent requirement is
 * switched on here (the shared test setup switches it off, like the sign-up code requirement); in production it cannot be switched off.
 */
describe('Sign-up consent (DPDP Act)', () => {
  let testApp: TestAppHelper;
  let app: INestApplication;
  const previous = process.env.REQUIRE_SIGNUP_CONSENT;
  const tag = `consent.${Date.now()}`;
  const emails: string[] = [];
  let seq = 0;
  const api = () => request(app.getHttpServer());
  const unwrap = (res: any) => res.body.data || res.body;
  const errorOf = (res: any) => res.body?.errorCode || res.body?.error?.errorCode || res.body?.details?.errorCode;
  const newEmail = () => {
    const e = `${tag}.u${++seq}@orion-test.io`;
    emails.push(e);
    return e;
  };
  const register = (email: string, extra: Record<string, unknown> = {}) => {
    (app.get(ThrottlerStorage) as any).storage.clear();
    return api().post('/api/v1/auth/register').send({ email, password: 'ConsentPass123!', firstName: 'Con', lastName: 'Sent', ...extra });
  };
  const userOf = async (email: string) => ((await (testApp.db as any).select().from(schema.users).where(eq(schema.users.email, email))) as any[])[0];
  const ledger = async (userId: string) => (await (testApp.db as any).select().from(schema.consentRecords).where(eq(schema.consentRecords.userId, userId))) as any[];

  beforeAll(async () => {
    process.env.REQUIRE_SIGNUP_CONSENT = 'true';
    testApp = new TestAppHelper();
    app = await testApp.init();
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.REQUIRE_SIGNUP_CONSENT;
    else process.env.REQUIRE_SIGNUP_CONSENT = previous;
    await testApp.cleanupUsers(emails);
    await testApp.close();
  });

  it('refuses sign-up with no consent, and creates no account', async () => {
    const email = newEmail();
    const res = await register(email);
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('CONSENT_REQUIRED');
    expect(await userOf(email)).toBeUndefined();
  });

  it('only a real boolean true counts: the text "true", false and optional-only choices are refused', async () => {
    for (const consents of [{ ACCOUNT_SERVICE: 'true' }, { ACCOUNT_SERVICE: false }, { ACCOUNT_SERVICE: 1 }, { MARKETING: true, PRODUCT_UPDATES: true }, []]) {
      const email = newEmail();
      const res = await register(email, { consents });
      expect(res.status).toBe(400);
      expect(await userOf(email)).toBeUndefined();
    }
  });

  it('records every choice with the account, including a refusal, with the policy version and where it came from', async () => {
    const email = newEmail();
    const res = await register(email, { consents: { ACCOUNT_SERVICE: true, PRODUCT_UPDATES: true, MARKETING: false } });
    expect(res.status).toBe(201);
    const user = await userOf(email);
    const rows = await ledger(user.id);
    expect(rows.map((r) => `${r.purpose}:${r.granted}`).sort()).toEqual(['ACCOUNT_SERVICE:true', 'MARKETING:false', 'PRODUCT_UPDATES:true']);
    for (const r of rows) {
      expect(r.source).toBe('signup');
      expect(r.policyVersion).toBeTruthy();
    }
    // the person sees the same state through the privacy API
    const token = unwrap(res).tokens?.accessToken ?? unwrap(res).accessToken;
    const state = unwrap(await api().get('/api/v1/privacy/consents').set('Authorization', `Bearer ${token}`)).consents;
    expect(state.ACCOUNT_SERVICE.granted).toBe(true);
    expect(state.PRODUCT_UPDATES.granted).toBe(true);
    expect(state.MARKETING.granted).toBe(false);
  });

  it('an optional purpose that was not sent is not recorded as a choice', async () => {
    const email = newEmail();
    expect((await register(email, { consents: { ACCOUNT_SERVICE: true } })).status).toBe(201);
    expect((await ledger((await userOf(email)).id)).map((r) => r.purpose)).toEqual(['ACCOUNT_SERVICE']);
  });

  it('a refused duplicate sign-up leaves no consent rows behind', async () => {
    const email = newEmail();
    expect((await register(email, { consents: { ACCOUNT_SERVICE: true } })).status).toBe(201);
    const before = (await (testApp.db as any).select().from(schema.consentRecords)).length;
    const again = await register(email, { consents: { ACCOUNT_SERVICE: true, MARKETING: true } });
    expect(again.status).toBe(409);
    expect((await (testApp.db as any).select().from(schema.consentRecords)).length).toBe(before);
  });
});
