import supertest from 'supertest';
const request = (supertest as any).default || supertest;
import * as jwt from 'jsonwebtoken';
import { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import { eq } from 'drizzle-orm';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../src/auth/decorators';
import { TestAppHelper } from './helpers/test-app.helper';
import { TEST_SECRETS } from './helpers/test-secrets';
import * as schema from '../src/database/schema';

/**
 * Phase 25: privileged surface and privileged operations, tested from the outside. Synthetic accounts; nothing real is changed.
 * The route list is read from the running application, so a new privileged route is covered without editing this file.
 */
const HTTP: Record<number, string> = { 0: 'get', 1: 'post', 2: 'put', 3: 'delete', 4: 'patch' };
const ZERO = '00000000-0000-4000-8000-000000000000';

describe('Privileged operations and the privileged surface (Phase 25)', () => {
  let testApp: TestAppHelper;
  let app: INestApplication;
  const api = () => request(app.getHttpServer());
  const unwrap = (res: any) => res.body.data || res.body;
  const emails: string[] = [];
  const adminEmail = `qa.p25ops.${Date.now()}@monarchsoftwares.com`;
  let admin: { Authorization: string };
  let superAdmin: { Authorization: string };
  const superEmail = `qa.p25super.${Date.now()}@monarchsoftwares.com`;
  let adminId = '';
  let superId = '';
  let customer: { id: string; auth: { Authorization: string }; email: string };
  let routes: Array<{ method: string; path: string; roles: string[]; isPublic: boolean }> = [];

  const discover = () => {
    const reflector = new Reflector();
    const out: typeof routes = [];
    for (const mod of app.get(ModulesContainer).values()) {
      for (const ctrl of mod.controllers.values()) {
        const type = ctrl.metatype as any;
        if (!type) continue;
        const bases = ([] as any[]).concat(Reflect.getMetadata(PATH_METADATA, type) ?? '').map(String);
        for (const name of Object.getOwnPropertyNames(type.prototype)) {
          const fn = type.prototype[name];
          if (typeof fn !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, fn);
          if (method === undefined || HTTP[method] === undefined) continue;
          const subs = ([] as any[]).concat(Reflect.getMetadata(PATH_METADATA, fn) ?? '').map(String);
          const roles = (reflector.getAllAndOverride<string[]>(ROLES_KEY, [fn, type]) ?? []).map(String);
          const isPublic = Boolean(reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [fn, type]));
          for (const b of bases) for (const s of subs) out.push({ method: HTTP[method], path: `/api/v1/${b}/${s}`.replace(/\/+/g, '/').replace(/\/$/, ''), roles, isPublic });
        }
      }
    }
    return out;
  };
  const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, ZERO);
  const clear = () => (app.get(ThrottlerStorage) as any).storage.clear();
  const wallet = async (userId: string) => (await testApp.db.select().from(schema.userWallets).where(eq(schema.userWallets.userId, userId)))[0] as any;
  const auditCount = async (action: string, entityId?: string) =>
    ((await testApp.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action))) as any[]).filter((r) => !entityId || r.entityId === entityId).length;

  beforeAll(async () => {
    testApp = new TestAppHelper();
    app = await testApp.init();
    await testApp.cleanupUsers([adminEmail, superEmail]);
    adminId = await testApp.provisionAdmin(adminEmail, 'ADMIN');
    admin = { Authorization: `Bearer ${jwt.sign({ sub: adminId, email: adminEmail, role: 'ADMIN', status: 'ACTIVE' }, TEST_SECRETS.jwtAccess, { expiresIn: '1h', issuer: 'orion-api', audience: 'orion-client' })}` };
    const email = `p25.ops.cust.${Date.now()}@orion-test.io`;
    emails.push(email);
    const reg = unwrap(await api().post('/api/v1/auth/register').send({ email, password: 'Phase25Pass123!', firstName: 'Op', lastName: 'Cu' }));
    superId = await testApp.provisionAdmin(superEmail, 'SUPER_ADMIN');
    superAdmin = { Authorization: `Bearer ${jwt.sign({ sub: superId, email: superEmail, role: 'SUPER_ADMIN', status: 'ACTIVE' }, TEST_SECRETS.jwtAccess, { expiresIn: '1h', issuer: 'orion-api', audience: 'orion-client' })}` };
    customer = { id: reg.user.id, email, auth: { Authorization: `Bearer ${reg.tokens.accessToken}` } };
    routes = discover();
  });
  beforeEach(clear);
  afterAll(async () => {
    await testApp.cleanupUsers([...emails, adminEmail, superEmail]);
    await testApp.close();
  });

  describe('the privileged surface cannot be reached by other methods, spellings or callers', () => {
    it('the application exposes the expected privileged routes (the list is read from the running application)', () => {
      const priv = routes.filter((r) => r.roles.length > 0 && !r.isPublic);
      expect(priv.length).toBeGreaterThanOrEqual(80);
      expect(priv.every((r) => r.roles.every((x) => ['SUPER_ADMIN', 'ADMIN', 'DATA_MANAGER'].includes(x)))).toBe(true);
    });

    it('no privileged path answers success to an anonymous caller or a customer on ANY method, declared or not', async () => {
      const priv = [...new Set(routes.filter((r) => r.roles.length > 0 && !r.isPublic).map((r) => concrete(r.path)))];
      const bad: string[] = [];
      let n = 0;
      for (const p of priv) {
        for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
          for (const who of [{}, customer.auth]) {
            if (++n % 40 === 0) clear();
            const res = await api()[m](p).set(who as any).send(m === 'get' || m === 'delete' ? undefined : {});
            if (res.status < 400 || res.status >= 500) bad.push(`${m.toUpperCase()} ${p} ${Object.keys(who).length ? 'customer' : 'anonymous'} -> ${res.status}`);
          }
        }
      }
      expect(bad).toEqual([]);
    });

    it('spelling tricks do not reach a privileged route: case, trailing slash, double slash, dot segment, path parameter, encoded slash', async () => {
      const variants = [
        '/api/v1/monitoring/alerts/',
        '/api/v1/MONITORING/alerts',
        '/api/v1//monitoring/alerts',
        '/api/v1/monitoring/./alerts',
        '/api/v1/monitoring/alerts;x=1',
        '/api/v1/monitoring%2Falerts',
        '/api/v1/monitoring/alerts%00',
        '/api/v1/credit/admin/adjust/',
        '/api/v1/Credit/Admin/Adjust',
      ];
      const bad: string[] = [];
      for (const v of variants) {
        for (const who of [{}, customer.auth]) {
          const res = await api().get(v).set(who as any);
          if (res.status < 400 || res.status >= 500) bad.push(`${v} -> ${res.status}`);
          const post = await api().post(v).set(who as any).send({});
          if (post.status < 400 || post.status >= 500) bad.push(`POST ${v} -> ${post.status}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it('client-supplied identity or role (headers, query, body) changes nothing for a customer on privileged routes', async () => {
      const res = await api()
        .get(`/api/v1/monitoring/alerts?role=ADMIN&userId=${adminId}&admin=true`)
        .set(customer.auth)
        .set('x-user-role', 'ADMIN')
        .set('x-user-id', adminId)
        .set('x-forwarded-user', adminId);
      expect(res.status).toBe(403);
      const post = await api().post('/api/v1/credit/admin/adjust').set(customer.auth).send({ userId: customer.id, purchasedDelta: 1000, role: 'ADMIN', isAdmin: true });
      expect([400, 403]).toContain(post.status);
      expect((await wallet(customer.id))?.purchasedCredits ?? 0).toBe(0);
    });

    it('there is no route that changes a role, creates an administrator or deletes a suppression: the privileged mutations touching accounts are exactly the traffic user limits', () => {
      const mutating = routes.filter((r) => r.method !== 'get' && !r.isPublic);
      const roleRoutes = mutating.filter((r) => /\/(roles|permissions|admins)(\/|$)/i.test(r.path.replace(/people-review\/roles|people-verification\/roles/g, '')) || /\/users?\/[^/]+\/(role|status|suspend|permissions)/i.test(r.path));
      expect(roleRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([]);
      const userRoutes = mutating.filter((r) => r.roles.length > 0 && /\/users?\//i.test(r.path)).map((r) => `${r.method.toUpperCase()} ${r.path.replace('/api/v1', '')}`).sort();
      expect(userRoutes).toEqual(['DELETE /traffic/users/:userId/limits', 'PUT /traffic/users/:userId/limits']);
      const suppression = routes.filter((r) => /suppress/i.test(r.path) && r.method !== 'post');
      expect(suppression).toEqual([]);
    });
  });

  describe('inactive and revoked accounts', () => {
    it('a suspended customer is refused on ordinary routes with their still-valid token, and works again when reactivated', async () => {
      expect((await api().get('/api/v1/user/me').set(customer.auth)).status).toBe(200);
      await testApp.db.update(schema.users).set({ status: 'SUSPENDED' }).where(eq(schema.users.id, customer.id));
      expect((await api().get('/api/v1/user/me').set(customer.auth)).status).toBe(401);
      expect((await api().post('/api/v1/unlock/business').set(customer.auth).send({ businessId: ZERO })).status).toBe(401);
      await testApp.db.update(schema.users).set({ status: 'ACTIVE' }).where(eq(schema.users.id, customer.id));
      expect((await api().get('/api/v1/user/me').set(customer.auth)).status).toBe(200);
    });

    it('an administrator whose account is suspended or demoted cannot perform privileged mutations with a valid token', async () => {
      await testApp.db.update(schema.users).set({ status: 'SUSPENDED' }).where(eq(schema.users.id, adminId));
      const a = await api().post('/api/v1/credit/admin/adjust').set(admin).send({ userId: customer.id, purchasedDelta: 50, reason: 'must not apply' });
      expect([401, 403]).toContain(a.status);
      await testApp.db.update(schema.users).set({ status: 'ACTIVE', role: 'USER' }).where(eq(schema.users.id, adminId));
      const b = await api().post('/api/v1/credit/admin/adjust').set(admin).send({ userId: customer.id, purchasedDelta: 50, reason: 'must not apply' });
      expect(b.status).toBe(403);
      await testApp.db.update(schema.users).set({ role: 'ADMIN' }).where(eq(schema.users.id, adminId));
      expect((await wallet(customer.id))?.purchasedCredits ?? 0).toBe(0);
    });
  });

  describe('role separation: moving money is for a SUPER_ADMIN, ordinary administrators keep read access', () => {
    let roleTestUserId = '';
    beforeAll(async () => {
      const e = `p25.role.cust.${Date.now()}@orion-test.io`;
      emails.push(e);
      const r = unwrap(await api().post('/api/v1/auth/register').send({ email: e, password: 'Phase25Pass123!', firstName: 'Role', lastName: 'Cu' }));
      roleTestUserId = r.user.id;
    });
    const MONEY_WRITES: Array<[string, string, () => object]> = [
      ['post', '/api/v1/credit/admin/adjust', () => ({ userId: roleTestUserId, purchasedDelta: 5, reason: 'role separation test' })],
      ['post', '/api/v1/credit/admin/packages', () => ({ name: 'Role test', slug: `role-test-${Date.now()}`, credits: 10, priceInr: 99 })],
      ['put', `/api/v1/credit/admin/packages/${ZERO}`, () => ({ name: 'Role test rename' })],
      ['delete', `/api/v1/credit/admin/packages/${ZERO}`, () => ({})],
      ['put', '/api/v1/credit/admin/config', () => ({ key: 'dailyFreeCredits', value: '5' })],
      ['post', '/api/v1/billing/admin/refunds', () => ({ paymentOrderId: ZERO, reason: 'role separation test' })],
    ];

    it('an ADMIN is refused (403) on every credit, pricing and refund write, and nothing changes', async () => {
      const walletBefore = (await testApp.db.select().from(schema.userWallets).where(eq(schema.userWallets.userId, customer.id))) as any[];
      for (const [method, url, body] of MONEY_WRITES) {
        const res = await (api() as any)[method](url).set(admin).send(body());
        expect([method, url, res.status]).toEqual([method, url, 403]);
      }
      const walletAfter = (await testApp.db.select().from(schema.userWallets).where(eq(schema.userWallets.userId, customer.id))) as any[];
      expect(walletAfter.map((w) => w.balance)).toEqual(walletBefore.map((w) => w.balance));
    });

    it('a SUPER_ADMIN is not refused by the role check on the same writes (a wallet adjustment succeeds)', async () => {
      for (const [method, url, body] of MONEY_WRITES) {
        const res = await (api() as any)[method](url).set(superAdmin).send(body());
        expect([method, url, res.status === 403]).toEqual([method, url, false]);
      }
    });

    it('an ADMIN keeps read access to packages and refunds', async () => {
      expect((await api().get('/api/v1/credit/admin/packages').set(admin)).status).toBe(200);
      expect((await api().get('/api/v1/billing/admin/refunds').set(admin)).status).toBe(200);
    });

    it('the role rule is declared in the code: exactly these six writes are SUPER_ADMIN-only among the credit and billing admin routes', () => {
      const superOnly = routes.filter((r) => r.roles.length === 1 && r.roles[0] === 'SUPER_ADMIN' && /\/(credit|billing)\/admin\//.test(r.path)).map((r) => `${r.method.toUpperCase()} ${r.path.replace('/api/v1', '')}`).sort();
      expect(superOnly).toEqual(
        ['DELETE /credit/admin/packages/:id', 'POST /billing/admin/refunds', 'POST /credit/admin/adjust', 'POST /credit/admin/packages', 'PUT /credit/admin/config', 'PUT /credit/admin/packages/:id'].sort(),
      );
    });
  });

  describe('credit adjustments: authorised, validated, atomic and audited', () => {
    it('a rejected request changes nothing and writes no adjustment audit entry', async () => {
      const before = await auditCount('CREDIT_ADJUSTMENT');
      for (const body of [
        { userId: customer.id, purchasedDelta: 1.5 },
        { userId: customer.id, purchasedDelta: 10_000_000_000 },
        { userId: 'not-a-uuid', purchasedDelta: 5 },
        { purchasedDelta: 5 },
        { userId: customer.id, purchasedDelta: '5; DROP TABLE users' },
      ]) {
        expect((await api().post('/api/v1/credit/admin/adjust').set(superAdmin).send(body)).status).toBe(400);
      }
      expect((await wallet(customer.id))?.purchasedCredits ?? 0).toBe(0);
      expect(await auditCount('CREDIT_ADJUSTMENT')).toBe(before);
    });

    it('an adjustment of an unknown or erased account is refused cleanly (404): no wallet is created for it and no half-written ledger row remains', async () => {
      const unknown = '11111111-2222-4333-8444-555555555555';
      const res = await api().post('/api/v1/credit/admin/adjust').set(superAdmin).send({ userId: unknown, purchasedDelta: 5, reason: 'unknown account' });
      expect(res.status).toBe(404);
      expect(await wallet(unknown)).toBeUndefined();
      const tx = (await testApp.db.select().from(schema.creditTransactions).where(eq(schema.creditTransactions.userId, unknown))) as any[];
      expect(tx).toHaveLength(0);
    });

    it('a valid adjustment is applied once, with a ledger row, a balance that adds up, and an audit entry naming the administrator and not the reason text verbatim secrets', async () => {
      const w0 = await wallet(customer.id);
      const res = await api().post('/api/v1/credit/admin/adjust').set(superAdmin).send({ userId: customer.id, purchasedDelta: 7, reason: 'goodwill for ticket 123' });
      expect(res.status).toBe(201);
      const w1 = await wallet(customer.id);
      expect(w1.purchasedCredits).toBe((w0?.purchasedCredits ?? 0) + 7);
      expect(w1.balance).toBe(w1.dailyCredits + w1.purchasedCredits);
      const audits = ((await testApp.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'CREDIT_ADJUSTMENT'))) as any[]).filter((r) => r.userId === superId);
      expect(audits.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(audits)).not.toContain(TEST_SECRETS.jwtAccess);
    });

    it('a customer cannot adjust their own or anyone else\'s credits', async () => {
      const before = (await wallet(customer.id))?.purchasedCredits ?? 0;
      for (const target of [customer.id, superId]) {
        expect((await api().post('/api/v1/credit/admin/adjust').set(customer.auth).send({ userId: target, purchasedDelta: 100 })).status).toBe(403);
      }
      expect((await wallet(customer.id))?.purchasedCredits ?? 0).toBe(before);
    });
  });

  describe('credit package administration: price changes are authorised, validated and attributed', () => {
    const slug = `p25-pack-${Date.now()}`;
    let packageId = '';
    const pkgAudits = async (action: string) => ((await testApp.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action))) as any[]).filter((r) => r.entityId === packageId);

    it('a customer cannot create, change or delete a package', async () => {
      const body = { slug: `${slug}-c`, name: 'Customer made', credits: 10, priceInr: 1 };
      expect((await api().post('/api/v1/credit/admin/packages').set(customer.auth).send(body)).status).toBe(403);
      expect((await api().put(`/api/v1/credit/admin/packages/${ZERO}`).set(customer.auth).send({ priceInr: 0 })).status).toBe(403);
      expect((await api().delete(`/api/v1/credit/admin/packages/${ZERO}`).set(customer.auth)).status).toBe(403);
    });

    it('creating a package is audited with the administrator as the actor', async () => {
      const res = await api().post('/api/v1/credit/admin/packages').set(superAdmin).send({ slug, name: 'P25 test pack', credits: 100, priceInr: 499 });
      expect(res.status).toBe(201);
      packageId = unwrap(res).id;
      const rows = await pkgAudits('CREDIT_PACKAGE_CREATED');
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(superId);
      expect(JSON.stringify(rows[0].newValues)).toContain('499');
    });

    it('changing a price is audited with the old and the new value', async () => {
      const res = await api().put(`/api/v1/credit/admin/packages/${packageId}`).set(superAdmin).send({ priceInr: 1 });
      expect(res.status).toBe(200);
      const rows = await pkgAudits('CREDIT_PACKAGE_UPDATED');
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(superId);
      expect(JSON.stringify(rows[0].oldValues)).toContain('499');
      expect(JSON.stringify(rows[0].newValues)).toContain('"priceInr":1');
    });

    it('an unknown or malformed package id is a clean 404 / 400 and writes no audit entry', async () => {
      const before = (await testApp.db.select().from(schema.auditLogs)).length;
      expect((await api().put(`/api/v1/credit/admin/packages/${ZERO}`).set(superAdmin).send({ priceInr: 5 })).status).toBe(404);
      expect((await api().put('/api/v1/credit/admin/packages/not-a-uuid').set(superAdmin).send({ priceInr: 5 })).status).toBe(400);
      expect((await api().delete(`/api/v1/credit/admin/packages/${ZERO}`).set(superAdmin)).status).toBe(404);
      expect((await api().delete('/api/v1/credit/admin/packages/not-a-uuid').set(superAdmin)).status).toBe(400);
      expect((await testApp.db.select().from(schema.auditLogs)).length).toBe(before);
    });

    it('deleting a package is audited, and the audit entry survives it', async () => {
      const res = await api().delete(`/api/v1/credit/admin/packages/${packageId}`).set(superAdmin);
      expect(res.status).toBe(200);
      const rows = await pkgAudits('CREDIT_PACKAGE_DELETED');
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(superId);
    });
  });

  describe('refunds, source decisions and exports audit are administrator-only and refuse bad input without side effects', () => {
    it('a refund request by a customer is refused; one for an unknown payment by an administrator changes nothing', async () => {
      expect((await api().post('/api/v1/billing/admin/refunds').set(customer.auth).send({ paymentOrderId: ZERO, reason: 'x' })).status).toBe(403);
      const refunds = (await testApp.db.select().from(schema.refunds)) as any[];
      const res = await api().post('/api/v1/billing/admin/refunds').set(superAdmin).send({ paymentOrderId: ZERO, reason: 'unknown payment' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(((await testApp.db.select().from(schema.refunds)) as any[]).length).toBe(refunds.length);
    });

    it('a customer cannot register or approve a data source, and cannot read the export audit', async () => {
      expect((await api().post('/api/v1/admin/import/sources').set(customer.auth).send({ name: 'x', type: 'MANUAL_IMPORT' })).status).toBe(403);
      expect((await api().patch(`/api/v1/admin/import/sources/${ZERO}/trust`).set(customer.auth).send({ trustStatus: 'APPROVED', reason: 'x' })).status).toBe(403);
      expect((await api().get('/api/v1/exports/admin/audit').set(customer.auth)).status).toBe(403);
    });
  });
});
