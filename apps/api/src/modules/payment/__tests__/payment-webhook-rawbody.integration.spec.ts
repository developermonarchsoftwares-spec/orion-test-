import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { DRIZZLE_DATABASE } from '../../../database/database.constants';
import { DrizzleDb } from '../../../database/database.provider';
import * as schema from '../../../database/schema';
import { CreditRepository } from '../../credit/credit.repository';
import { CreditService } from '../../credit/credit.service';
import { createTestDb, seedUser } from '../../people/__tests__/pglite-test-db';
import { PaymentController } from '../payment.controller';
import { PaymentService } from '../payment.service';
import { RazorpayService } from '../razorpay.service';

const HOOK_SECRET = 'webhook-secret-for-raw-body-tests-0001';
const hmac = (body: string | Buffer, secret = HOOK_SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');

describe('Razorpay webhook: exact raw-body signature verification (Phase 6.18)', () => {
  let app: INestApplication;
  let db: DrizzleDb;
  let closeDb: () => Promise<void>;
  let userId: string;
  let packageId: string;

  const credited = async () => (await db.select().from(schema.userWallets).where(eq(schema.userWallets.userId, userId)))[0]?.purchasedCredits ?? 0;
  const purchases = async (paymentId: string) =>
    (await db.select().from(schema.creditTransactions)).filter((t) => t.type === ('PACKAGE_PURCHASE' as any) && t.referenceId === paymentId);
  const post = (body: string | Buffer, signature?: string, contentType = 'application/json') => {
    const r = request(app.getHttpServer()).post('/payments/webhook').set('Content-Type', contentType);
    return (signature === undefined ? r : r.set('x-razorpay-signature', signature)).send(body);
  };
  /** The event as Razorpay would send it: unusual whitespace and key order that JSON.stringify(JSON.parse(x)) would not reproduce. */
  const eventBody = (paymentId: string, extra = '') =>
    `{ "event" : "payment.captured" ,\n  "payload":{"payment":{"entity":{"notes":{"packageId":"${packageId}","userId":"${userId}"${extra}},"id":"${paymentId}","order_id":"order_x"}}}\n}`;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    closeDb = () => t.client.close();
    userId = (await seedUser(db, 'rawbody.user@test.dev', { daily: 0, purchased: 0 })).id;
    packageId = (await db.insert(schema.creditPackages).values({ slug: 'raw-starter', name: 'raw-starter', priceInr: 99, credits: 100 }).returning())[0].id;
    const cfg = { get: (k: string) => ({ RAZORPAY_KEY_ID: 'rzp_test_rawbody_id', RAZORPAY_KEY_SECRET: 'key-secret-for-raw-body-tests-0001', RAZORPAY_WEBHOOK_SECRET: HOOK_SECRET })[k] } as unknown as ConfigService;
    const module = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: DRIZZLE_DATABASE, useValue: db },
        { provide: ConfigService, useValue: cfg },
        { provide: JwtAuthGuard, useValue: { canActivate: () => true } },
        CreditRepository, CreditService, PaymentService, RazorpayService,
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true }); // exactly what main.ts does
    await app.init();
    // listen once so parallel supertest requests share one live server (otherwise each starts it and the first to finish closes it: ECONNRESET)
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
  });

  it('a genuine webhook (signature over the exact bytes, whatever their formatting) is accepted and credits the package once', async () => {
    const body = eventBody('pay_raw_ok');
    expect(JSON.stringify(JSON.parse(body))).not.toBe(body); // proves the old re-serialisation could never have matched
    const res = await post(body, hmac(body)).expect(200);
    expect(res.body.data ?? res.body).toMatchObject({ status: 'ok' });
    expect(await credited()).toBe(100);
    expect(await purchases('pay_raw_ok')).toHaveLength(1);
  });

  it('refuses a missing, malformed, wrong-key or wrong-length signature', async () => {
    const body = eventBody('pay_raw_bad');
    for (const sig of [undefined, '', 'abc', 'z'.repeat(64), hmac(body, 'another-secret-another-secret-01'), hmac(body).toUpperCase(), `${hmac(body)}00`]) {
      const res = await post(body, sig).expect(200);
      expect(res.body.data ?? res.body).toEqual({ status: 'ignored' });
    }
    expect(await purchases('pay_raw_bad')).toHaveLength(0);
  });

  it('a tampered body cannot ride on a valid signature (different package, user, payment id, whitespace or extra field)', async () => {
    const original = eventBody('pay_raw_t1');
    const sig = hmac(original);
    const tampered = [
      original.replace('pay_raw_t1', 'pay_raw_t2'),
      original.replace(userId, '00000000-0000-4000-8000-0000000000aa'),
      original.replace(' "event" :', '"event":'), // whitespace only: still different bytes
      eventBody('pay_raw_t1', ',"credits":"999999"'),
      original + ' ',
    ];
    for (const t of tampered) {
      const res = await post(t, sig).expect(200);
      expect(res.body.data ?? res.body).toEqual({ status: 'ignored' });
    }
    for (const id of ['pay_raw_t1', 'pay_raw_t2']) expect(await purchases(id)).toHaveLength(0);
    expect(await credited()).toBe(100); // unchanged since the genuine webhook above
  });

  it('a signature computed over a re-serialised body does not verify against the bytes actually sent', async () => {
    const sent = eventBody('pay_raw_re');
    const reserialised = JSON.stringify(JSON.parse(sent));
    const res = await post(sent, hmac(reserialised)).expect(200);
    expect(res.body.data ?? res.body).toEqual({ status: 'ignored' });
    expect(await purchases('pay_raw_re')).toHaveLength(0);
  });

  it('a replayed webhook (same bytes, same signature) and concurrent deliveries credit once', async () => {
    const body = eventBody('pay_raw_replay');
    const sig = hmac(body);
    await post(body, sig).expect(200);
    const again = await post(body, sig).expect(200);
    expect(again.body.data ?? again.body).toMatchObject({ status: 'ok', alreadyProcessed: true });
    await Promise.all([post(body, sig), post(body, sig), post(body, sig)]);
    expect(await purchases('pay_raw_replay')).toHaveLength(1);
    expect(await credited()).toBe(200);
  });

  it('a validly signed body that is not JSON, or has the wrong shape, credits nothing and never crashes', async () => {
    for (const junk of ['not json at all', '{"event":"payment.captured"', '[]', 'null', '{"event":"payment.captured","payload":{}}']) {
      const res = await post(junk, hmac(junk), 'text/plain');
      expect([200, 400, 415]).toContain(res.status);
    }
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    const res = await post(bin, hmac(bin), 'application/octet-stream');
    expect([200, 400, 415]).toContain(res.status);
    expect(await credited()).toBe(200);
  });

  it('the controller never re-serialises the parsed body', () => {
    const text = require('fs').readFileSync(require('path').resolve(__dirname, '../payment.controller.ts'), 'utf8') as string;
    expect(text).not.toMatch(/JSON\.stringify\(payload\)/);
    expect(text).toMatch(/req\.rawBody/);
    const main = require('fs').readFileSync(require('path').resolve(__dirname, '../../../main.ts'), 'utf8') as string;
    expect((main.match(/rawBody: true/g) ?? []).length).toBe(2);
  });
});
