import supertest from 'supertest';
const request = (supertest as any).default || supertest;
import { INestApplication } from '@nestjs/common';
import { TestAppHelper } from './helpers/test-app.helper';
import * as schema from '../src/database/schema';
import { eq } from 'drizzle-orm';

describe('Sprint 16: Lead Discovery, Contact Masking & Unlock E2E Tests', () => {
  let testApp: TestAppHelper;
  let app: INestApplication;

  const testBizSlug = 'qa-tech-enterprise-solutions';
  let testBizId: string;

  const unlockUserEmail = 'unlock.tester@orion-test.io';
  const unlockUserPassword = 'UnlockPassword123!';
  let unlockUserToken: string;
  let unlockUserId: string;

  const brokeUserEmail = 'broke.tester@orion-test.io';
  const brokeUserPassword = 'BrokePassword123!';
  let brokeUserToken: string;
  let brokeUserId: string;

  beforeAll(async () => {
    testApp = new TestAppHelper();
    app = await testApp.init();

    await testApp.cleanupUsers([unlockUserEmail, brokeUserEmail]);
    await testApp.cleanupBusinesses([testBizSlug]);

    // 1. Create a published test business with location and contacts
    const biz = await testApp.createTestBusiness({
      slug: testBizSlug,
      name: 'QA Tech Enterprise Solutions',
      contactEmail: 'sharma.tech@qa-enterprise.com',
      contactPhone: '+91 9876543210',
      city: 'Bangalore',
      state: 'Karnataka',
    });
    testBizId = biz.id;

    // 2. Register user with normal credits (5 daily credits)
    const regRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: unlockUserEmail,
        password: unlockUserPassword,
        firstName: 'Unlock',
        lastName: 'Tester',
      });
    const regData = regRes.body.data || regRes.body;
    unlockUserId = regData.user.id;
    unlockUserToken = regData.tokens.accessToken;

    // 3. Register user with 0 credits to test insufficient credit rejection
    const brokeRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: brokeUserEmail,
        password: brokeUserPassword,
        firstName: 'Broke',
        lastName: 'Tester',
      });
    const brokeData = brokeRes.body.data || brokeRes.body;
    brokeUserId = brokeData.user.id;
    brokeUserToken = brokeData.tokens.accessToken;

    // Zero out broke user's wallet in DB
    await testApp.db
      .update(schema.userWallets)
      .set({
        balance: 0,
        dailyCredits: 0,
        purchasedCredits: 0,
      })
      .where(eq(schema.userWallets.userId, brokeUserId));
  });

  afterAll(async () => {
    await testApp.cleanupUsers([unlockUserEmail, brokeUserEmail]);
    await testApp.cleanupBusinesses([testBizSlug]);
    await testApp.close();
  });

  describe('1. Contact Masking & Locked Profile Inspection', () => {
    it('GET /api/v1/discover/businesses/:slug -> should mask contact intelligence and address before unlock', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/discover/businesses/${testBizSlug}`)
        .set('Authorization', `Bearer ${unlockUserToken}`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.slug).toBe(testBizSlug);
      expect(data.name).toBe('QA Tech Enterprise Solutions');

      // Verify contact masking
      expect(Array.isArray(data.contacts)).toBe(true);
      expect(data.contacts.length).toBeGreaterThanOrEqual(1);
      const contact = data.contacts[0];
      expect(contact.isLocked).toBe(true);
      expect(contact.email).toContain('***');
      expect(contact.phone).toContain('***');
      expect(contact.email).not.toBe('sharma.tech@qa-enterprise.com');
      expect(contact.phone).not.toBe('+91 9876543210');

      // Verify address masking
      expect(Array.isArray(data.locations)).toBe(true);
      expect(data.locations[0].addressLine1).toBe('*** Locked Address ***');
    });

    it('GET /api/v1/unlock/status/:id -> should report lead as locked initially', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/unlock/status/${testBizId}`)
        .set('Authorization', `Bearer ${unlockUserToken}`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.isUnlocked).toBe(false);
    });
  });

  describe('2. Lead Unlocking Flow & Atomic Credit Deduction', () => {
    it('POST /api/v1/unlock/business -> should successfully unlock lead, deduct 1 credit, and return unmasked contacts', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/unlock/business')
        .set('Authorization', `Bearer ${unlockUserToken}`)
        .send({ businessId: testBizId });

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.success).toBe(true);
      expect(data.alreadyUnlocked).toBe(false);
      expect(data.creditsSpent).toBe(1);
      expect(data.balance).toBe(4); // 5 - 1 = 4

      // Verify returned unmasked business profile
      expect(data.business).toBeDefined();
      const contact = data.business.contacts[0];
      expect(contact.isLocked).toBe(false);
      expect(contact.email).toBe('sharma.tech@qa-enterprise.com');
      expect(contact.phone).toBe('+91 9876543210');
      expect(data.business.locations[0].addressLine1).toBe('42 Cyber City Tower 3');
    });

    it('POST /api/v1/unlock/business -> should be idempotent and not charge credits again', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/unlock/business')
        .set('Authorization', `Bearer ${unlockUserToken}`)
        .send({ businessId: testBizId });

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.success).toBe(true);
      expect(data.alreadyUnlocked).toBe(true);
      expect(data.creditsSpent).toBe(0);
      expect(data.balance).toBe(4); // Still 4! No double charge
    });

    it('GET /api/v1/unlock/status/:id -> should now report lead as unlocked', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/unlock/status/${testBizId}`)
        .set('Authorization', `Bearer ${unlockUserToken}`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.isUnlocked).toBe(true);
    });

    it('GET /api/v1/unlock/history -> should return user unlock history with the unlocked lead', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/unlock/history')
        .set('Authorization', `Bearer ${unlockUserToken}`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      const items = Array.isArray(data) ? data : data.items;
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[0].businessId).toBe(testBizId);
    });

    it('GET /api/v1/unlock/user-leads -> should list the ids of unlocked leads, and require a session', async () => {
      const anonymous = await request(app.getHttpServer()).get('/api/v1/unlock/user-leads');
      expect(anonymous.status).toBe(401);

      const res = await request(app.getHttpServer())
        .get('/api/v1/unlock/user-leads')
        .set('Authorization', `Bearer ${unlockUserToken}`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data.unlockedIds).toContain(testBizId);
    });
  });

  describe('3. Insufficient Credits Enforcement', () => {
    it('POST /api/v1/unlock/business -> should reject unlock request with 402 when credits are exhausted', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/unlock/business')
        .set('Authorization', `Bearer ${brokeUserToken}`)
        .send({ businessId: testBizId });

      expect(res.status).toBe(402);
      expect(res.body.errorCode).toBe('INSUFFICIENT_CREDITS');
    });
  });

  describe('4. Discovery Search & Suggestions', () => {
    it('GET /api/v1/discover/search -> should return paginated search results', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/discover/search?q=QA Tech')
        .set('Authorization', `Bearer ${unlockUserToken}`);

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      const items = data.items || data.hits;
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[0].name).toBe('QA Tech Enterprise Solutions');
      expect(data.total || data.totalHits).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/v1/discover/suggestions -> should return query suggestions', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/discover/suggestions?q=QA');

      expect(res.status).toBe(200);
      const data = res.body.data || res.body;
      expect(data).toHaveProperty('businesses');
      expect(Array.isArray(data.businesses)).toBe(true);
      expect(data.businesses.length).toBeGreaterThanOrEqual(1);
      expect(data.businesses[0].text).toBe('QA Tech Enterprise Solutions');
    });
  });
});
