import supertest from 'supertest';
const request = (supertest as any).default || supertest;
import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import { eq } from 'drizzle-orm';
import { TestAppHelper } from './helpers/test-app.helper';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../src/auth/decorators';
import * as schema from '../src/database/schema';

/**
 * Phase 5 authorization: function-level (every route, discovered from the running application so a new route cannot escape),
 * object-level (user A against user B's private records), mass assignment, and shared-lead versus customer-private data.
 */

interface IRoute {
  method: string;
  path: string;
  roles: string[];
  isPublic: boolean;
}

const HTTP: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * The complete set of routes that answer without a session. Anything added here is a deliberate decision: a route that becomes public
 * by accident fails the "public surface" test below until a reviewer adds it.
 */
const EXPECTED_PUBLIC: string[] = [
  'GET /api/v1',
  'GET /api/v1/admin/import/template',
  'GET /api/v1/admin/template/csv',
  'GET /api/v1/auth/google',
  'GET /api/v1/auth/google/callback',
  'GET /api/v1/auth/microsoft',
  'GET /api/v1/auth/microsoft/callback',
  'GET /api/v1/businesses/:id',
  'GET /api/v1/businesses/:id/related',
  'GET /api/v1/credit/config',
  'GET /api/v1/cron/:job', // Vercel Cron; needs `Bearer CRON_SECRET` (32+ characters), else 401, or 503 when unset
  'GET /api/v1/credit/packages',
  'GET /api/v1/discover/businesses/:slug',
  'GET /api/v1/discover/businesses/:slug/related',
  'GET /api/v1/discover/search',
  'GET /api/v1/discover/suggestions',
  'GET /api/v1/health',
  'GET /api/v1/health/:dependency',
  'GET /api/v1/health/live',
  'GET /api/v1/health/liveness',
  'GET /api/v1/health/readiness',
  'GET /api/v1/health/ready',
  'GET /api/v1/metrics', // needs METRICS_TOKEN or an admin bearer token, else 401
  'GET /api/v1/monitoring/dashboard', // an HTML shell with no data
  'POST /api/v1/admin/auth/logout',
  'POST /api/v1/admin/auth/send-otp',
  'POST /api/v1/admin/auth/verify-otp',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/mfa/login',
  'POST /api/v1/auth/oauth/token',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/resend-verification',
  'POST /api/v1/auth/reset-password',
  'POST /api/v1/auth/send-otp', // sign-up e-mail code: e-mails a code; answers identically for known and unknown addresses; limited per address, network and route
  'POST /api/v1/auth/verify-email',
  'POST /api/v1/auth/verify-otp', // checks the code (5 tries); returns a one-time proof, never a session
  'POST /api/v1/integrations/callbacks/:integrationId', // authenticated by HMAC signature
  'POST /api/v1/payments/webhook', // authenticated by the provider signature over the raw body
  // DPDP Act intake for people who may not have an account. Both are rate limited; the first also checks Turnstile when configured, and
  // the second acts only with the one-time secret e-mailed to the address (reviewed in DPDP_PROGRESS.md D17)
  'POST /api/v1/privacy-requests',
  'POST /api/v1/privacy-requests/verify',
];

describe('Authorization: function level, object level, mass assignment, shared-lead isolation', () => {
  let testApp: TestAppHelper;
  let app: INestApplication;
  const api = () => request(app.getHttpServer());
  const unwrap = (res: any) => res.body.data || res.body;
  const password = 'SecurePassword123!';
  const stamp = Date.now();
  const mail = (n: string) => `authz.${n}.${stamp}@orion-test.io`;
  const emails: string[] = [];
  const slugs: string[] = [];

  const newUser = async (name: string) => {
    const email = mail(name);
    emails.push(email);
    const res = await api().post('/api/v1/auth/register').send({ email, password, firstName: 'Az', lastName: name });
    expect(res.status).toBe(201);
    const d = unwrap(res);
    return { id: d.user.id as string, email, token: d.tokens.accessToken as string, auth: { Authorization: `Bearer ${d.tokens.accessToken}` } };
  };

  const discoverRoutes = (): IRoute[] => {
    const reflector = new Reflector();
    const routes: IRoute[] = [];
    for (const mod of app.get(ModulesContainer).values()) {
      for (const ctrl of mod.controllers.values()) {
        const type = ctrl.metatype as any;
        if (!type) continue;
        const base: string = Reflect.getMetadata(PATH_METADATA, type) ?? '';
        const bases = (Array.isArray(base) ? base : [base]).map(String);
        for (const name of Object.getOwnPropertyNames(type.prototype)) {
          const fn = type.prototype[name];
          if (typeof fn !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, fn);
          if (method === undefined || HTTP[method] === undefined) continue;
          const sub = Reflect.getMetadata(PATH_METADATA, fn) ?? '';
          const subs = (Array.isArray(sub) ? sub : [sub]).map(String);
          const roles = (reflector.getAllAndOverride<string[]>(ROLES_KEY, [fn, type]) ?? []).map(String);
          const isPublic = Boolean(reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [fn, type]));
          for (const b of bases) {
            for (const s of subs) {
              const path = `/api/v1/${b}/${s}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/api/v1';
              routes.push({ method: HTTP[method], path, roles, isPublic });
            }
          }
        }
      }
    }
    return routes;
  };
  const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, ZERO_UUID);
  const call = (r: IRoute, headers: Record<string, string> = {}) => {
    const verb = r.method.toLowerCase();
    return (api() as any)[verb](concrete(r.path)).set(headers).send(['get', 'delete'].includes(verb) ? undefined : {});
  };

  beforeAll(async () => {
    testApp = new TestAppHelper();
    app = await testApp.init();
  });
  beforeEach(() => (app.get(ThrottlerStorage) as any).storage.clear());
  afterAll(async () => {
    await testApp.cleanupBusinesses(slugs);
    await testApp.cleanupUsers(emails);
    await testApp.close();
  });

  describe('function level: every route, discovered from the running application', () => {
    let routes: IRoute[];
    let user: Awaited<ReturnType<typeof newUser>>;

    beforeAll(async () => {
      routes = discoverRoutes();
      user = await newUser('sweep');
    });

    it('finds the whole API surface (so the sweeps below are not vacuous)', () => {
      expect(routes.length).toBeGreaterThanOrEqual(190);
      expect(routes.filter((r) => r.roles.length > 0 && !r.isPublic).length).toBeGreaterThanOrEqual(70);
    });

    it('the public surface is exactly the reviewed set', () => {
      const actual = routes.filter((r) => r.isPublic).map((r) => `${r.method} ${r.path}`).sort();
      expect(actual).toEqual([...EXPECTED_PUBLIC].sort());
    });

    it('every non-public route refuses an anonymous caller with 401', async () => {
      const failures: string[] = [];
      for (const r of routes.filter((x) => !x.isPublic)) {
        const res = await call(r);
        if (res.status !== 401) failures.push(`${r.method} ${r.path} -> ${res.status}`);
      }
      expect(failures).toEqual([]);
    });

    it('every role-restricted route refuses an ordinary customer with 403', async () => {
      const failures: string[] = [];
      for (const r of routes.filter((x) => !x.isPublic && x.roles.length > 0)) {
        const res = await call(r, user.auth);
        if (res.status !== 403) failures.push(`${r.method} ${r.path} -> ${res.status}`);
      }
      expect(failures).toEqual([]);
    });

    it('a customer session is not an administrator session: a role claim in the request body or query changes nothing', async () => {
      const r = routes.find((x) => x.method === 'GET' && x.path === '/api/v1/credit/admin/packages')!;
      expect((await (api() as any).get(`${r.path}?role=ADMIN`).set(user.auth).set('X-User-Role', 'ADMIN')).status).toBe(403);
    });
  });

  describe('object level: user A against user B', () => {
    let a: Awaited<ReturnType<typeof newUser>>;
    let b: Awaited<ReturnType<typeof newUser>>;
    let exportId: string;
    let scheduleId: string;
    let integrationId: string;
    let invoiceId: string;

    beforeAll(async () => {
      a = await newUser('a');
      b = await newUser('b');

      const exp = await api().post('/api/v1/exports').set(a.auth).send({ dataset: 'saved-leads', format: 'csv' });
      expect([200, 201]).toContain(exp.status);
      // the response is the file itself, so the job id comes from the database
      exportId = (await testApp.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.userId, a.id)))[0]?.id;

      const sch = await api().post('/api/v1/exports/schedules').set(a.auth).send({ dataset: 'saved-leads', format: 'csv', frequency: 'WEEKLY' });
      expect([200, 201]).toContain(sch.status);
      scheduleId = unwrap(sch).id;

      // seeded directly: creating a webhook through the API would resolve a DNS name, and this suite makes no network calls
      const [integ] = await testApp.db
        .insert(schema.integrations)
        .values({ userId: a.id, type: 'WEBHOOK', name: 'A hook', targetUrl: 'https://hooks.example.org/a', events: ['lead.unlocked'], signingSecretEnc: 'sealed-test-value' })
        .returning();
      integrationId = integ.id;

      const [inv] = await testApp.db
        .insert(schema.invoices)
        .values({
          invoiceNumber: `INV-AZ-${stamp}`,
          userId: a.id,
          paymentId: `pay_az_${stamp}`,
          kind: 'TOPUP',
          description: 'A top-up',
          credits: 10,
          subtotalPaise: 1000,
          totalPaise: 1000,
        } as any)
        .returning();
      invoiceId = inv.id;
    });

    it('control: the owner can reach each of her own records (the denials below are not over-restriction)', async () => {
      expect(exportId).toBeDefined();
      expect((await api().get('/api/v1/exports/history').set(a.auth)).status).toBe(200);
      // the owner finds her export job: 200 with the file, or 410 when the stored file is no longer retained (as in this hermetic
      // environment); either way it is NOT the 404 a stranger gets, which is what the next test relies on
      expect([200, 410]).toContain((await api().get(`/api/v1/exports/${exportId}/download`).set(a.auth)).status);
      expect((await api().get(`/api/v1/integrations/${integrationId}`).set(a.auth)).status).toBe(200);
      expect((await api().get(`/api/v1/billing/invoices/${invoiceId}`).set(a.auth)).status).toBe(200);
      expect((await api().patch(`/api/v1/exports/schedules/${scheduleId}`).set(a.auth).send({ enabled: false })).status).toBe(200);
    });

    it("B cannot list, download or schedule against A's exports", async () => {
      const history = unwrap(await api().get('/api/v1/exports/history').set(b.auth));
      expect(JSON.stringify(history)).not.toContain(exportId);
      expect((await api().get(`/api/v1/exports/${exportId}/download`).set(b.auth)).status).toBe(404);
      const schedules = unwrap(await api().get('/api/v1/exports/schedules').set(b.auth));
      expect(JSON.stringify(schedules)).not.toContain(scheduleId);
      expect((await api().patch(`/api/v1/exports/schedules/${scheduleId}`).set(b.auth).send({ enabled: true })).status).toBe(404);
      expect((await api().delete(`/api/v1/exports/schedules/${scheduleId}`).set(b.auth)).status).toBe(404);
      const [still] = await testApp.db.select().from(schema.exportSchedules).where(eq(schema.exportSchedules.id, scheduleId));
      expect(still).toBeDefined();
    });

    it("B cannot read, change, test, rotate or delete A's integration, or see its deliveries", async () => {
      const id = integrationId;
      const verbs: Array<[string, string, object?]> = [
        ['get', `/api/v1/integrations/${id}`],
        ['patch', `/api/v1/integrations/${id}`, { name: 'taken over' }],
        ['delete', `/api/v1/integrations/${id}`],
        ['post', `/api/v1/integrations/${id}/rotate-secret`, {}],
        ['post', `/api/v1/integrations/${id}/test`, {}],
        ['get', `/api/v1/integrations/${id}/deliveries`],
        ['post', `/api/v1/integrations/${id}/deliveries/${ZERO_UUID}/redeliver`, {}],
        ['post', `/api/v1/integrations/${id}/sync`, {}],
        ['post', `/api/v1/integrations/${id}/validate`, {}],
      ];
      for (const [verb, url, body] of verbs) {
        const res = await (api() as any)[verb](url).set(b.auth).send(body);
        expect({ url, status: res.status }).toEqual({ url, status: 404 });
      }
      const list = unwrap(await api().get('/api/v1/integrations').set(b.auth));
      expect(JSON.stringify(list)).not.toContain(id);
      const [row] = await testApp.db.select().from(schema.integrations).where(eq(schema.integrations.id, id));
      expect(row.name).toBe('A hook'); // untouched
    });

    it("B cannot read A's invoices, as JSON or printable HTML", async () => {
      expect((await api().get(`/api/v1/billing/invoices/${invoiceId}`).set(b.auth)).status).toBe(404);
      expect((await api().get(`/api/v1/billing/invoices/${invoiceId}/html`).set(b.auth)).status).toBe(404);
      const list = unwrap(await api().get('/api/v1/billing/invoices').set(b.auth));
      expect(JSON.stringify(list)).not.toContain(invoiceId);
    });

    it('missing or malformed ids are refused with 404/400, never a success or a 500', async () => {
      const probes = [
        `/api/v1/exports/not-a-uuid/download`,
        `/api/v1/exports/${ZERO_UUID}/download`,
        `/api/v1/integrations/not-a-uuid`,
        `/api/v1/integrations/${ZERO_UUID}`,
        `/api/v1/billing/invoices/not-a-uuid`,
        `/api/v1/billing/invoices/${ZERO_UUID}`,
        `/api/v1/saved-searches/not-a-uuid`,
        `/api/v1/saved-searches/${ZERO_UUID}`,
      ];
      for (const url of probes) {
        const res = await api().get(url).set(a.auth);
        expect({ url, ok: [400, 404].includes(res.status) }).toEqual({ url, ok: true });
      }
    });
  });

  describe('shared lead versus customer-private data', () => {
    let a: Awaited<ReturnType<typeof newUser>>;
    let b: Awaited<ReturnType<typeof newUser>>;
    let businessId: string;
    let slug: string;
    const contactEmail = `shared.contact.${stamp}@lead-company.example`;

    beforeAll(async () => {
      a = await newUser('lead.a');
      b = await newUser('lead.b');
      slug = `authz-shared-${stamp}`;
      slugs.push(slug);
      const biz = await testApp.createTestBusiness({ slug, name: 'Shared Lead Co', contactEmail, contactPhone: '+91 9000000001' });
      businessId = biz.id;
    });

    it("the company record is shared and searchable by both customers, but each customer's unlock state is private", async () => {
      // both can see the same published company
      expect((await api().get(`/api/v1/discover/businesses/${slug}`).set(a.auth)).status).toBe(200);
      expect((await api().get(`/api/v1/discover/businesses/${slug}`).set(b.auth)).status).toBe(200);

      const unlock = await api().post('/api/v1/unlock/business').set(a.auth).send({ businessId });
      expect(unlock.status).toBe(200);
      expect(unwrap(unlock).business.contacts[0].email).toBe(contactEmail);

      // A's purchase does not unlock anything for B
      expect(unwrap(await api().get(`/api/v1/unlock/status/${businessId}`).set(a.auth)).isUnlocked).toBe(true);
      expect(unwrap(await api().get(`/api/v1/unlock/status/${businessId}`).set(b.auth)).isUnlocked).toBe(false);
      const bProfile = unwrap(await api().get(`/api/v1/discover/businesses/${slug}`).set(b.auth));
      expect(JSON.stringify(bProfile)).not.toContain(contactEmail);
      const anonProfile = unwrap(await api().get(`/api/v1/discover/businesses/${slug}`));
      expect(JSON.stringify(anonProfile)).not.toContain(contactEmail);

      // B's history, exports and wallet carry nothing of A's purchase
      const bHistory = unwrap(await api().get('/api/v1/unlock/history').set(b.auth));
      expect(JSON.stringify(bHistory)).not.toContain(contactEmail);
      expect(JSON.stringify(bHistory)).not.toContain(businessId);
      const aWallet = unwrap(await api().get('/api/v1/credit/wallet').set(a.auth));
      const bWallet = unwrap(await api().get('/api/v1/credit/wallet').set(b.auth));
      expect(aWallet.balance).toBe(4);
      expect(bWallet.balance).toBe(5);
    });

    it("B cannot obtain A's unlocked contact through the export or by unlocking-by-proxy (a userId in the body is refused)", async () => {
      const exp = await api().post('/api/v1/exports').set(b.auth).send({ dataset: 'unlocked-leads', format: 'csv' });
      expect([200, 201]).toContain(exp.status);
      expect(String(exp.text ?? '')).not.toContain(contactEmail); // the response body is B's own export
      const [bJob] = await testApp.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.userId, b.id));
      const download = await api().get(`/api/v1/exports/${bJob.id}/download`).set(b.auth);
      expect(String(download.text ?? '')).not.toContain(contactEmail);

      const proxy = await api().post('/api/v1/unlock/business').set(b.auth).send({ businessId, userId: a.id });
      expect(proxy.status).toBe(400); // forbidNonWhitelisted: ownership is never taken from the body
      expect(unwrap(await api().get(`/api/v1/unlock/status/${businessId}`).set(b.auth)).isUnlocked).toBe(false);
    });
  });

  describe('mass assignment: protected fields cannot be written through ordinary endpoints', () => {
    let u: Awaited<ReturnType<typeof newUser>>;
    const row = async () => (await testApp.db.select().from(schema.users).where(eq(schema.users.id, u.id)))[0];

    beforeAll(async () => {
      u = await newUser('mass');
    });

    it('profile update refuses role, status, credits, ownership and verification fields, and changes nothing', async () => {
      for (const body of [
        { role: 'SUPER_ADMIN' },
        { status: 'ACTIVE', isEmailVerified: true },
        { organizationId: ZERO_UUID },
        { id: ZERO_UUID },
        { email: 'someone.else@orion-test.io' },
        { passwordHash: 'x' },
        { balance: 1000000, purchasedCredits: 999 },
        { metadata: { activeSessionId: 'sess_forged' } },
        { twoFactorEnabled: false },
      ]) {
        const res = await api().patch('/api/v1/user/profile').set(u.auth).send(body);
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }
      const after = await row();
      expect(after.role).toBe('USER');
      expect(after.email).toBe(u.email);
      expect((after.metadata as any)?.activeSessionId).not.toBe('sess_forged');
    });

    it('control: the allowed profile fields still update', async () => {
      const res = await api().patch('/api/v1/user/profile').set(u.auth).send({ firstName: 'Renamed', jobTitle: 'Buyer' });
      expect(res.status).toBe(200);
      expect((await row()).firstName).toBe('Renamed');
    });

    it('settings update cannot write security state into the account metadata, and never echoes it back', async () => {
      const before = (await row()).metadata as Record<string, unknown>;
      for (const prefs of [
        { activeSessionId: 'sess_forged' },
        { mfaLastStep: 99999999999 },
        { passwordChangedAt: 1 },
        { role: 'ADMIN' },
        { timezone: 'UTC', activeSessionId: 'sess_forged' }, // one bad key rejects the whole request
        { resultsPerPage: 5 }, // wrong type
      ]) {
        const res = await api().patch('/api/v1/user/settings').set(u.auth).send({ preferences: prefs });
        expect({ prefs, status: res.status }).toEqual({ prefs, status: 400 });
      }
      const after = (await row()).metadata as Record<string, unknown>;
      expect(after.activeSessionId).toBe(before.activeSessionId);
      expect(after.mfaLastStep).toBe(before.mfaLastStep);
      expect(after.timezone).toBeUndefined();

      const ok = await api().patch('/api/v1/user/settings').set(u.auth).send({ preferences: { timezone: 'Asia/Kolkata', weeklyDigest: true } });
      expect(ok.status).toBe(200);
      const echoed = JSON.stringify(unwrap(ok));
      expect(echoed).toContain('Asia/Kolkata');
      for (const secret of ['activeSessionId', 'mfaLastStep', 'passwordChangedAt']) expect(echoed).not.toContain(secret);
    });

    it('registration, saved-search and saved-lead bodies cannot assign ownership or privileges', async () => {
      const reg = await api().post('/api/v1/auth/register').send({ email: mail('priv'), password, firstName: 'P', lastName: 'Q', role: 'SUPER_ADMIN' });
      emails.push(mail('priv'));
      expect(reg.status).toBe(400);
      const other = await newUser('owner.target');
      expect((await api().post('/api/v1/saved-searches').set(u.auth).send({ name: 'x', filters: {}, userId: other.id })).status).toBe(400);
      expect((await api().post('/api/v1/saved-leads').set(u.auth).send({ businessId: ZERO_UUID, userId: other.id })).status).toBe(400);
    });

    it('a customer cannot adjust credits, even their own, and the wallet is unchanged', async () => {
      const before = unwrap(await api().get('/api/v1/credit/wallet').set(u.auth)).balance;
      const res = await api().post('/api/v1/credit/admin/adjust').set(u.auth).send({ userId: u.id, purchasedDelta: 1000, reason: 'self-service' });
      expect(res.status).toBe(403);
      expect(unwrap(await api().get('/api/v1/credit/wallet').set(u.auth)).balance).toBe(before);
    });
  });
});
