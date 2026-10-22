import supertest from 'supertest';
const request = (supertest as any).default || supertest;
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { TestAppHelper } from './helpers/test-app.helper';
import { TEST_SECRETS } from './helpers/test-secrets';
import { MailService, IMail } from '../src/auth/mail/mail.service';
import { CreditService } from '../src/modules/credit/credit.service';
import { BillingService } from '../src/modules/payment/billing.service';
import { TierGuard } from '../src/modules/payment/tier.guard';
import * as schema from '../src/database/schema';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';

describe('Billing: plans, checkout, invoices, top-up, tiers, credit warnings, refunds', () => {
  let testApp: TestAppHelper;
  let app: INestApplication;
  const sent: IMail[] = [];
  const api = () => request(app.getHttpServer());
  const unwrap = (res: any) => res.body.data || res.body;
  const hmac = (secret: string, text: string) => crypto.createHmac('sha256', secret).update(text).digest('hex');
  const sign = (orderId: string, paymentId: string) => hmac(TEST_SECRETS.razorpayKeySecret, `${orderId}|${paymentId}`);
  let seq = 0;
  const payId = () => `pay_e2e_${Date.now()}_${++seq}`;

  const emails: string[] = [];
  const adminEmail = 'qa.billing.admin@monarchsoftwares.com';
  let adminToken: string;
  const newUser = async (tag: string) => {
    const email = `billing.${tag}.${Date.now()}@orion-test.io`;
    emails.push(email);
    const res = unwrap(await api().post('/api/v1/auth/register').send({ email, password: 'BillingPass123!', firstName: 'Bill', lastName: tag }));
    return { id: res.user.id as string, email, auth: { Authorization: `Bearer ${res.tokens.accessToken}` } };
  };
  const pkg = async (slug: string) => (unwrap(await api().get('/api/v1/credit/packages')) as any[]).find((p) => p.slug === slug);
  const buy = async (u: { auth: any }, slug: string, cycle: 'monthly' | 'annual' = 'monthly') => {
    const p = await pkg(slug);
    const order = unwrap(await api().post('/api/v1/payments/create-order').set(u.auth).send({ packageId: p.id, billingCycle: cycle }));
    const paymentId = payId();
    const res = await api()
      .post('/api/v1/payments/verify')
      .set(u.auth)
      .send({ razorpayOrderId: order.orderId, razorpayPaymentId: paymentId, razorpaySignature: sign(order.orderId, paymentId), packageId: p.id, billingCycle: cycle });
    return { res, body: unwrap(res), order, paymentId, p };
  };
  const topUp = async (u: { auth: any }, credits: number) => {
    const order = unwrap(await api().post('/api/v1/payments/topup/order').set(u.auth).send({ credits }));
    const paymentId = payId();
    const res = await api().post('/api/v1/payments/topup/verify').set(u.auth).send({ razorpayOrderId: order.orderId, razorpayPaymentId: paymentId, razorpaySignature: sign(order.orderId, paymentId) });
    return { res, body: unwrap(res), order, paymentId };
  };
  const wallet = async (u: { auth: any }) => unwrap(await api().get('/api/v1/credit/wallet').set(u.auth));

  beforeAll(async () => {
    testApp = new TestAppHelper();
    app = await testApp.init();
    app.get(MailService).transport = { send: async (m) => void sent.push(m) };
    await testApp.cleanupUsers([adminEmail]);
    const adminId = await testApp.provisionAdmin(adminEmail, 'SUPER_ADMIN');
    adminToken = jwt.sign({ sub: adminId, email: adminEmail, role: 'SUPER_ADMIN', status: 'ACTIVE' }, TEST_SECRETS.jwtAccess, { expiresIn: '1h', issuer: 'orion-api', audience: 'orion-client' });
  });

  // per-route @Throttle limits (register 10/min) are production values; this spec registers many users
  beforeEach(() => {
    (app.get(ThrottlerStorage) as any).storage.clear();
  });

  afterAll(async () => {
    await testApp.cleanupUsers([...emails, adminEmail]);
    await testApp.close();
  });

  describe('plan checkout, invoice and subscription', () => {
    it('a new customer is on the free tier; paying for a plan credits once, issues one invoice, and starts the plan', async () => {
      const u = await newUser('plan');
      expect(unwrap(await api().get('/api/v1/billing/subscription').set(u.auth))).toMatchObject({ tier: 'free', status: 'NONE' });

      const first = await buy(u, 'starter');
      expect(first.res.status).toBe(200);
      expect(first.body.creditsAdded).toBe(first.p.credits);
      expect(first.body.invoice.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);

      // paying twice for the same payment adds nothing and returns the same invoice
      const dup = await api()
        .post('/api/v1/payments/verify')
        .set(u.auth)
        .send({ razorpayOrderId: first.order.orderId, razorpayPaymentId: first.paymentId, razorpaySignature: sign(first.order.orderId, first.paymentId), packageId: first.p.id });
      expect(unwrap(dup)).toMatchObject({ alreadyProcessed: true });
      expect(unwrap(dup).invoice.invoiceNumber).toBe(first.body.invoice.invoiceNumber);
      expect((await wallet(u)).purchasedCredits).toBe(first.p.credits);

      const invoices = unwrap(await api().get('/api/v1/billing/invoices').set(u.auth));
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ kind: 'PACKAGE', status: 'ISSUED', totalPaise: first.p.priceInr * 100, credits: first.p.credits });

      const sub = unwrap(await api().get('/api/v1/billing/subscription').set(u.auth));
      expect(sub).toMatchObject({ tier: 'starter', status: 'ACTIVE', autoRenew: false });
      expect(sub.daysRemaining).toBeGreaterThanOrEqual(29);
    });

    it('invoices are private to their owner and render as escaped, printable HTML', async () => {
      const a = await newUser('inv-a');
      const b = await newUser('inv-b');
      await buy(a, 'starter');
      const inv = unwrap(await api().get('/api/v1/billing/invoices').set(a.auth))[0];

      const one = await api().get(`/api/v1/billing/invoices/${inv.id}`).set(a.auth);
      expect(one.status).toBe(200);
      // the website builds the PDF from this record: it carries everything the PDF prints, including who issued the invoice
      const body = unwrap(one);
      expect(body).toEqual(expect.objectContaining({ invoiceNumber: inv.invoiceNumber, billingEmail: expect.any(String), paymentId: expect.any(String), totalPaise: expect.any(Number) }));
      expect(typeof body.seller?.name).toBe('string');
      expect(body.seller.name.length).toBeGreaterThan(0);
      expect((await api().get(`/api/v1/billing/invoices/${inv.id}`).set(b.auth)).status).toBe(404);
      expect((await api().get(`/api/v1/billing/invoices/${inv.id}/html`).set(b.auth)).status).toBe(404);
      expect((await api().get('/api/v1/billing/invoices/not-a-uuid').set(a.auth)).status).toBe(404);
      expect((await api().get('/api/v1/billing/invoices')).status).toBe(401);

      const html = await api().get(`/api/v1/billing/invoices/${inv.id}/html`).set(a.auth);
      expect(html.status).toBe(200);
      expect(html.headers['content-type']).toMatch(/html/);
      expect(html.text).toContain(inv.invoiceNumber);
      expect(html.text).not.toMatch(/<script/i);
    });

    it('shows tax carved out of the price when a tax rate is configured', async () => {
      await api().put('/api/v1/credit/admin/config').set('Authorization', `Bearer ${adminToken}`).send({ key: 'TAX_PERCENTAGE', value: { percentage: 18 }, description: 'GST' });
      const u = await newUser('tax');
      const { p } = await buy(u, 'starter');
      const inv = unwrap(await api().get('/api/v1/billing/invoices').set(u.auth))[0];
      const total = p.priceInr * 100;
      expect(inv.taxBps).toBe(1800);
      expect(inv.totalPaise).toBe(total);
      expect(inv.subtotalPaise + inv.taxPaise).toBe(total);
      expect(inv.taxPaise).toBeGreaterThan(0);
      await api().put('/api/v1/credit/admin/config').set('Authorization', `Bearer ${adminToken}`).send({ key: 'TAX_PERCENTAGE', value: { percentage: 0 } });
    });

    it('refuses a payment for another package, or for someone else\'s order', async () => {
      const a = await newUser('mm-a');
      const b = await newUser('mm-b');
      const starter = await pkg('starter');
      const growth = await pkg('growth');
      const order = unwrap(await api().post('/api/v1/payments/create-order').set(a.auth).send({ packageId: starter.id }));
      const paymentId = payId();
      const sig = sign(order.orderId, paymentId);
      const wrongPkg = await api().post('/api/v1/payments/verify').set(a.auth).send({ razorpayOrderId: order.orderId, razorpayPaymentId: paymentId, razorpaySignature: sig, packageId: growth.id });
      expect(wrongPkg.status).toBe(400);
      const wrongUser = await api().post('/api/v1/payments/verify').set(b.auth).send({ razorpayOrderId: order.orderId, razorpayPaymentId: paymentId, razorpaySignature: sig, packageId: starter.id });
      expect(wrongUser.status).toBe(400);
      expect((await wallet(a)).purchasedCredits).toBe(0);
      expect((await wallet(b)).purchasedCredits).toBe(0);
    });
  });

  describe('top-up', () => {
    it('prices on the server, enforces limits, credits exactly the ordered quantity once, and does not change the plan', async () => {
      const u = await newUser('topup');
      const quote = unwrap(await api().get('/api/v1/billing/topup/quote?credits=200').set(u.auth));
      expect(quote).toMatchObject({ credits: 200, amountPaise: 20000, currency: 'INR' });
      expect((await api().get('/api/v1/billing/topup/quote?credits=5').set(u.auth)).status).toBe(400);
      expect((await api().get('/api/v1/billing/topup/quote?credits=99999999').set(u.auth)).status).toBe(400);
      expect((await api().get('/api/v1/billing/topup/quote?credits=12.5').set(u.auth)).status).toBe(400);
      expect((await api().post('/api/v1/payments/topup/order').set(u.auth).send({ credits: 10 })).status).toBe(400);

      const t = await topUp(u, 200);
      expect(t.res.status).toBe(200);
      expect(t.body).toMatchObject({ creditsAdded: 200, alreadyProcessed: false });
      expect((await wallet(u)).purchasedCredits).toBe(200);

      const again = await api().post('/api/v1/payments/topup/verify').set(u.auth).send({ razorpayOrderId: t.order.orderId, razorpayPaymentId: t.paymentId, razorpaySignature: sign(t.order.orderId, t.paymentId) });
      expect(unwrap(again)).toMatchObject({ alreadyProcessed: true });
      expect((await wallet(u)).purchasedCredits).toBe(200);

      const inv = unwrap(await api().get('/api/v1/billing/invoices').set(u.auth));
      expect(inv).toHaveLength(1);
      expect(inv[0]).toMatchObject({ kind: 'TOPUP', totalPaise: 20000, credits: 200 });
      expect(unwrap(await api().get('/api/v1/billing/subscription').set(u.auth)).tier).toBe('free');
    });

    it('a client cannot choose the credits or price at verification, or redeem another customer\'s order', async () => {
      const a = await newUser('tu-a');
      const b = await newUser('tu-b');
      const order = unwrap(await api().post('/api/v1/payments/topup/order').set(a.auth).send({ credits: 50 }));
      const paymentId = payId();
      const sig = sign(order.orderId, paymentId);
      const extra = await api().post('/api/v1/payments/topup/verify').set(a.auth).send({ razorpayOrderId: order.orderId, razorpayPaymentId: paymentId, razorpaySignature: sig, credits: 5000 });
      expect(extra.status).toBe(400);
      const other = await api().post('/api/v1/payments/topup/verify').set(b.auth).send({ razorpayOrderId: order.orderId, razorpayPaymentId: paymentId, razorpaySignature: sig });
      expect(other.status).toBe(400);
      const forged = await api().post('/api/v1/payments/topup/verify').set(a.auth).send({ razorpayOrderId: order.orderId, razorpayPaymentId: paymentId, razorpaySignature: 'x'.repeat(64) });
      expect(forged.status).toBe(400);
      expect((await wallet(a)).purchasedCredits).toBe(0);
      expect((await wallet(b)).purchasedCredits).toBe(0);
    });

    it('a webhook credits a stored order from our own record, once, and ignores a mismatched amount', async () => {
      const u = await newUser('hook');
      const order = unwrap(await api().post('/api/v1/payments/topup/order').set(u.auth).send({ credits: 60 }));
      const post = (body: object, secret = TEST_SECRETS.razorpayWebhookSecret) => {
        const raw = JSON.stringify(body);
        return api().post('/api/v1/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', hmac(secret, raw)).send(raw);
      };
      const event = (paymentId: string, amount: number) => ({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: order.orderId, amount, notes: { userId: 'ignored' } } } } });

      await post(event(payId(), 1));
      expect((await wallet(u)).purchasedCredits).toBe(0);
      const paymentId = payId();
      await post(event(paymentId, order.amount));
      await post(event(paymentId, order.amount));
      expect((await wallet(u)).purchasedCredits).toBe(60);
      expect(unwrap(await api().get('/api/v1/billing/invoices').set(u.auth))).toHaveLength(1);
    });
  });

  describe('tier-based access control', () => {
    const ctx = (userId?: string, required?: string) => {
      const handler = () => undefined;
      if (required) Reflect.defineMetadata('requiredTier', required, handler);
      return { getHandler: () => handler, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => ({ user: userId ? { sub: userId } : undefined }) }) } as any;
    };
    const guard = () => new TierGuard(new Reflector(), app.get(BillingService));

    it('blocks lower tiers with TIER_REQUIRED, admits equal or higher, and never downgrades an active higher plan', async () => {
      const u = await newUser('tier');
      await expect(guard().canActivate(ctx(u.id, 'starter'))).rejects.toMatchObject({ errorCode: 'TIER_REQUIRED', details: { requiredTier: 'starter', currentTier: 'free' } });
      await expect(guard().canActivate(ctx(undefined, 'starter'))).rejects.toMatchObject({ errorCode: 'UNAUTHENTICATED' });
      expect(await guard().canActivate(ctx(u.id))).toBe(true); // route without a tier requirement

      await buy(u, 'starter');
      expect(await guard().canActivate(ctx(u.id, 'starter'))).toBe(true);
      await expect(guard().canActivate(ctx(u.id, 'growth'))).rejects.toMatchObject({ errorCode: 'TIER_REQUIRED' });

      await buy(u, 'growth');
      expect(await guard().canActivate(ctx(u.id, 'growth'))).toBe(true);
      await buy(u, 'starter'); // cheaper plan while growth is active
      expect(unwrap(await api().get('/api/v1/billing/subscription').set(u.auth)).tier).toBe('growth');
    });

    it('an expired plan counts as free again', async () => {
      const u = await newUser('expired');
      await buy(u, 'growth');
      await testApp.db.update(schema.userSubscriptions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.userSubscriptions.userId, u.id));
      expect(unwrap(await api().get('/api/v1/billing/subscription').set(u.auth))).toMatchObject({ tier: 'free', status: 'EXPIRED' });
      await expect(guard().canActivate(ctx(u.id, 'starter'))).rejects.toMatchObject({ errorCode: 'TIER_REQUIRED' });
    });
  });

  describe('low-credit warning and zero-credit restriction', () => {
    const adjust = (userId: string, dailyDelta: number, purchasedDelta = 0) =>
      api().post('/api/v1/credit/admin/adjust').set('Authorization', `Bearer ${adminToken}`).send({ userId, dailyDelta, purchasedDelta, reason: 'QA balance setup' });

    it('reports OK / LOW / EMPTY on the wallet and warns once per level per day', async () => {
      const u = await newUser('low');
      expect(await wallet(u)).toMatchObject({ creditStatus: 'OK', restricted: false, lowCreditThreshold: 2 });

      sent.length = 0;
      await adjust(u.id, -4); // 5 -> 1
      expect(await wallet(u)).toMatchObject({ balance: 1, creditStatus: 'LOW', restricted: false });
      const credit = app.get(CreditService);
      expect(await credit.notifyIfLow(u.id)).toBe('LOW');
      expect(await credit.notifyIfLow(u.id)).toBeNull(); // not again today
      expect(sent.filter((m) => m.to === u.email && m.subject === 'Your credits are running low')).toHaveLength(1);

      await adjust(u.id, -1); // 1 -> 0
      const w = await wallet(u);
      expect(w).toMatchObject({ balance: 0, creditStatus: 'EMPTY', restricted: true });
      expect(new Date(w.nextDailyResetAt).getTime()).toBeGreaterThan(Date.now());
      expect(await credit.notifyIfLow(u.id)).toBe('EMPTY');
      expect(await credit.notifyIfLow(u.id)).toBeNull();
      expect(sent.filter((m) => m.to === u.email && m.subject === 'You are out of credits')).toHaveLength(1);
    });

    it('refuses to spend at zero with a 402 that says what to do next, and charges nothing', async () => {
      const u = await newUser('zero');
      await adjust(u.id, -5);
      const credit = app.get(CreditService);
      await expect(credit.deductCredits(u.id, 1, 'test spend')).rejects.toMatchObject({
        errorCode: 'INSUFFICIENT_CREDITS',
        status: 402,
        details: { required: 1, available: 0, creditStatus: 'EMPTY', canTopUp: true },
      });
      expect((await wallet(u)).balance).toBe(0);
      // a top-up lifts the restriction immediately
      await topUp(u, 50);
      expect(await wallet(u)).toMatchObject({ balance: 50, creditStatus: 'OK', restricted: false });
    });
  });

  describe('refunds and adjustments', () => {
    const admin = { Authorization: '' };
    beforeAll(() => {
      admin.Authorization = `Bearer ${adminToken}`;
    });

    it('a full refund takes the credits back, marks the invoice, cancels the plan, records the refund, and cannot be repeated', async () => {
      const u = await newUser('refund');
      const { paymentId, p } = await buy(u, 'starter');
      expect((await wallet(u)).purchasedCredits).toBe(p.credits);

      const r = await api().post('/api/v1/billing/admin/refunds').set(admin).send({ paymentId, reason: 'Customer request (test)' });
      expect(r.status).toBe(200);
      expect(unwrap(r)).toMatchObject({ paymentId, amountPaise: p.priceInr * 100, creditsReversed: p.credits, creditsShortfall: 0, status: 'MANUAL_REQUIRED' });

      expect((await wallet(u)).purchasedCredits).toBe(0);
      expect(unwrap(await api().get('/api/v1/billing/invoices').set(u.auth))[0]).toMatchObject({ status: 'REFUNDED' });
      expect(unwrap(await api().get('/api/v1/billing/subscription').set(u.auth))).toMatchObject({ tier: 'free', status: 'CANCELLED' });
      const hist = unwrap(await api().get('/api/v1/billing/history').set(u.auth));
      expect(hist.items.map((i: any) => i.type)).toEqual(expect.arrayContaining(['PACKAGE_PURCHASE', 'REFUND']));
      expect(sent.some((m) => m.to === u.email && m.subject === 'Your payment was refunded')).toBe(true);

      const again = await api().post('/api/v1/billing/admin/refunds').set(admin).send({ paymentId, reason: 'Second attempt' });
      expect(again.status).toBe(409);
      expect((await wallet(u)).purchasedCredits).toBe(0);
    });

    it('credits already spent are recorded as a shortfall, never driving the wallet negative', async () => {
      const u = await newUser('spent');
      const { paymentId, p } = await buy(u, 'starter');
      await app.get(CreditService).deductCredits(u.id, 5 + 40, 'test spend'); // 5 daily first, then 40 purchased
      const r = unwrap(await api().post('/api/v1/billing/admin/refunds').set(admin).send({ paymentId, reason: 'Refund after use' }));
      expect(r.creditsReversed).toBe(p.credits - 40);
      expect(r.creditsShortfall).toBe(40);
      const w = await wallet(u);
      expect(w.purchasedCredits).toBe(0);
      expect(w.balance).toBe(0);
    });

    it('only administrators can refund, and unknown or invalid requests are rejected', async () => {
      const u = await newUser('norefund');
      const { paymentId } = await buy(u, 'starter');
      expect((await api().post('/api/v1/billing/admin/refunds').set(u.auth).send({ paymentId, reason: 'I want my money' })).status).toBe(403);
      expect((await api().get('/api/v1/billing/admin/refunds').set(u.auth)).status).toBe(403);
      expect((await api().post('/api/v1/billing/admin/refunds').set(admin).send({ paymentId: 'pay_unknown_zzz', reason: 'No such payment' })).status).toBe(404);
      expect((await api().post('/api/v1/billing/admin/refunds').set(admin).send({ paymentId, reason: 'x' })).status).toBe(400);
      expect((await wallet(u)).purchasedCredits).toBeGreaterThan(0);
      expect(unwrap(await api().get('/api/v1/billing/admin/refunds').set(admin)).length).toBeGreaterThan(0);
    });

    it('a manual adjustment is recorded at the amount actually applied when a balance would go below zero', async () => {
      const u = await newUser('adj');
      const r = await api().post('/api/v1/credit/admin/adjust').set(admin).send({ userId: u.id, purchasedDelta: -500, reason: 'Clamp test' });
      expect(r.status).toBe(201);
      const tx = unwrap(r).transaction;
      expect(tx.amount).toBe(0); // nothing to remove: 0 purchased credits
      expect(tx.metadata).toMatchObject({ purchasedDelta: -500 });
      expect((await wallet(u)).balance).toBe(5);
    });
  });
});
