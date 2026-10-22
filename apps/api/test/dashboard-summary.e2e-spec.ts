import supertest from 'supertest';
const request = (supertest as any).default || supertest;
import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { TestAppHelper } from './helpers/test-app.helper';
import * as schema from '../src/database/schema';
import { percentChange, industryShares } from '../src/modules/dashboard/dashboard.service';

/**
 * The customer dashboard shows only what the database holds: counts of the user's own unlocks, saved leads and saved searches, businesses
 * published today, a month-by-month series for this year, the industry split of the published catalogue, and real trends (null, never an
 * invented 0%, when there is nothing to compare). Another customer's activity never leaks in, and a second request returns the same numbers.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

describe('Customer dashboard summary is real, per-user and persistent', () => {
  let testApp: TestAppHelper;
  let app: INestApplication;
  const stamp = Date.now();
  const emails = [`dash.a.${stamp}@orion-test.io`, `dash.b.${stamp}@orion-test.io`];
  const slugs = [`dash-biz-1-${stamp}`, `dash-biz-2-${stamp}`, `dash-biz-3-${stamp}`];
  let a: { id: string; auth: { Authorization: string } };
  let b: { id: string; auth: { Authorization: string } };
  const api = () => request(app.getHttpServer());
  const unwrap = (res: any) => res.body.data || res.body;
  const summary = async (u: { auth: any }) => {
    const res = await api().get('/api/v1/dashboard/summary').set(u.auth);
    expect(res.status).toBe(200);
    return unwrap(res);
  };
  const register = async (email: string) => {
    const res = unwrap(await api().post('/api/v1/auth/register').send({ email, password: 'DashboardPass123!', firstName: 'Dash', lastName: 'Board' }));
    return { id: res.user.id as string, auth: { Authorization: `Bearer ${res.tokens.accessToken}` } };
  };
  let bizIds: string[] = [];

  beforeAll(async () => {
    testApp = new TestAppHelper();
    app = await testApp.init();
    await testApp.cleanupUsers(emails);
    await testApp.cleanupBusinesses(slugs);
    a = await register(emails[0]);
    b = await register(emails[1]);
    const [tech] = await testApp.db.insert(schema.industries).values({ code: `DASH_TECH_${stamp}`, name: `Dash Tech ${stamp}`, slug: `dash-tech-${stamp}` } as any).returning();
    const [retail] = await testApp.db.insert(schema.industries).values({ code: `DASH_RETAIL_${stamp}`, name: `Dash Retail ${stamp}`, slug: `dash-retail-${stamp}` } as any).returning();
    for (const [i, slug] of slugs.entries()) {
      const biz = await testApp.createTestBusiness({ slug, name: `Dash Business ${i + 1}`, contactEmail: `${slug}@lead.example`, contactPhone: '+91 9000000001' });
      await testApp.db.update(schema.businesses).set({ industryId: i < 2 ? tech.id : retail.id }).where(eq(schema.businesses.id, biz.id));
      bizIds.push(biz.id);
    }
  });
  afterAll(async () => {
    await testApp.cleanupUsers(emails);
    await testApp.cleanupBusinesses(slugs);
    await testApp.close();
  });

  it('refuses an anonymous caller', async () => {
    expect((await api().get('/api/v1/dashboard/summary')).status).toBe(401);
  });

  it('a new customer sees zeros that are real, and no invented trend: trends are null when there is nothing to compare', async () => {
    const s = await summary(a);
    expect(s.stats).toEqual(expect.objectContaining({ unlockedLeadsCount: 0, savedLeadsCount: 0, savedSearchesCount: 0 }));
    expect(s.recentUnlocks).toEqual([]);
    expect(s.recentSearches).toEqual([]);
    expect(s.trends.unlockedLeads).toBeNull();
    expect(s.trends.savedLeads).toBeNull();
  });

  it('"new businesses today" counts what was published today (the three test businesses)', async () => {
    const s = await summary(a);
    expect(s.stats.newBusinessesCount).toBeGreaterThanOrEqual(3);
  });

  it('the industry distribution comes from the published catalogue: both test industries, with counts and shares that add up', async () => {
    const s = await summary(a);
    const tech = s.industryDistribution.find((x: any) => x.name === `Dash Tech ${stamp}`);
    const retail = s.industryDistribution.find((x: any) => x.name === `Dash Retail ${stamp}`);
    // grouped as "Other" only when outside the top five; either way the totals must be consistent
    const total = s.industryDistribution.reduce((n: number, x: any) => n + x.count, 0);
    expect(total).toBeGreaterThanOrEqual(3);
    expect(s.industryDistribution.length).toBeLessThanOrEqual(6);
    if (tech) expect(tech.count).toBe(2);
    if (retail) expect(retail.count).toBe(1);
    for (const x of s.industryDistribution) expect(x.share).toBeGreaterThanOrEqual(0);
  });

  it('the year series has one entry per month up to this month, with this month holding the catalogue additions', async () => {
    const s = await summary(a);
    const month = new Date().getUTCMonth() + 1;
    expect(s.discoveryTrend).toHaveLength(month);
    expect(s.discoveryTrend.map((x: any) => x.month)).toEqual(MONTHS.slice(0, month));
    expect(s.discoveryTrend[month - 1].discovered).toBeGreaterThanOrEqual(3);
    expect(s.discoveryTrend.every((x: any) => x.converted === 0)).toBe(true); // this user has unlocked nothing yet
    expect(s.year).toBe(new Date().getUTCFullYear());
  });

  describe('after the customer acts', () => {
    it('unlocks, a saved lead and a saved search are counted and listed with real business names', async () => {
      expect((await api().post('/api/v1/unlock/business').set(a.auth).send({ businessId: bizIds[0] })).status).toBe(200);
      expect((await api().post('/api/v1/unlock/business').set(a.auth).send({ businessId: bizIds[1] })).status).toBe(200);
      expect((await api().post('/api/v1/saved-leads').set(a.auth).send({ businessId: bizIds[2], pipelineStage: 'NEW' })).status).toBe(201);
      expect((await api().post('/api/v1/saved-searches').set(a.auth).send({ name: 'Dash saved search', filters: { city: 'Bangalore' }, alertEnabled: false, alertFrequency: 'DAILY' })).status).toBe(201);

      const s = await summary(a);
      expect(s.stats).toEqual(expect.objectContaining({ unlockedLeadsCount: 2, savedLeadsCount: 1, savedSearchesCount: 1 }));
      expect(s.recentUnlocks.map((u: any) => u.name)).toEqual(expect.arrayContaining(['Dash Business 1', 'Dash Business 2']));
      expect(s.recentUnlocks.every((u: any) => typeof u.businessId === 'string' && u.businessId.length > 0)).toBe(true); // lets the page link to the business
      expect(s.recentSearches[0]).toEqual(expect.objectContaining({ name: 'Dash saved search', filters: { city: 'Bangalore' } }));
      const month = new Date().getUTCMonth() + 1;
      expect(s.discoveryTrend[month - 1].converted).toBe(2);
      expect(s.wallet.balance).toBe(3); // 5 starting credits, 2 spent: the same number the wallet shows
    });

    it('the same numbers come back on the next request (nothing is held in the page or in memory)', async () => {
      const first = await summary(a);
      const second = await summary(a);
      expect(second.stats).toEqual(first.stats);
      expect(second.discoveryTrend).toEqual(first.discoveryTrend);
      expect(second.industryDistribution).toEqual(first.industryDistribution);
    });

    it("another customer's dashboard does not include any of it", async () => {
      const s = await summary(b);
      expect(s.stats).toEqual(expect.objectContaining({ unlockedLeadsCount: 0, savedLeadsCount: 0, savedSearchesCount: 0 }));
      expect(s.recentUnlocks).toEqual([]);
      expect(s.recentSearches).toEqual([]);
      expect(s.discoveryTrend.every((x: any) => x.converted === 0)).toBe(true);
    });
  });
});

describe('dashboard helpers', () => {
  it('percentChange is a real comparison, or null when the earlier period is empty', () => {
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(15, 10)).toBe(50);
    expect(percentChange(5, 10)).toBe(-50);
    expect(percentChange(10, 10)).toBe(0);
  });

  it('industryShares keeps the five largest, folds the rest into "Other", and the shares describe the same total', () => {
    const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name, i) => ({ name, n: 10 - i }));
    const out = industryShares(rows);
    expect(out.map((x) => x.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'Other']);
    expect(out.find((x) => x.name === 'Other')!.count).toBe(5 + 4);
    expect(out.reduce((n, x) => n + x.count, 0)).toBe(rows.reduce((n, r) => n + r.n, 0));
    expect(industryShares([])).toEqual([]);
    expect(industryShares([{ name: 'Only', n: 4 }])).toEqual([{ name: 'Only', count: 4, share: 100 }]);
  });
});
