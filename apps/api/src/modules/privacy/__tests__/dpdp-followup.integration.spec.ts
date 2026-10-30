import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { plainToInstance } from 'class-transformer';
import * as path from 'path';
import { AuditLogService } from '../../../common/services/audit-log.service';
import * as schema from '../../../database/schema';
import { ContactSuppressionService } from '../contact-suppression.service';
import { CreateRightsRequestDto } from '../dto/rights-request.dto';
import { DELETION_GRACE_MS } from '../privacy.config';
import { PrivacyService } from '../privacy.service';
import { RightsRequestService } from '../rights-request.service';

/** DPDP follow-ups: withdrawing the account consent closes the account (O4); a confirmed erasure request feeds contact suppression (O7). */
const MIGRATIONS = path.resolve(__dirname, '../../../database/migrations');
const ctx = { ip: '203.0.113.9', userAgent: 'jest' };

describe('DPDP follow-ups', () => {
  let client: PGlite;
  let db: any;
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  let privacy: PrivacyService;
  let rights: RightsRequestService;
  const previousFrontend = process.env.FRONTEND_URL;

  beforeAll(async () => {
    process.env.FRONTEND_URL = 'https://app.example.test';
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const audit = new AuditLogService(db);
    const mail = { send: async (m: any) => void mails.push(m), sendChecked: async (m: any) => (mails.push(m), true) } as any;
    privacy = new PrivacyService(db, { compare: async (p: string, h: string) => h === `h:${p}` } as any, audit, mail);
    rights = new RightsRequestService(db, audit, mail, new ContactSuppressionService(db, audit));
  });
  afterAll(async () => {
    if (previousFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontend;
    await client.close();
  });
  beforeEach(async () => {
    mails.length = 0;
    await client.exec('TRUNCATE users, businesses, data_subject_requests, contact_suppressions CASCADE');
  });

  // ------------------------------------------------------------------------------------------------ O4
  describe('withdrawing the account consent (O4)', () => {
    let userId: string;
    const pending = async () =>
      (await db.select().from(schema.privacyRequests).where(and(eq(schema.privacyRequests.userId, userId), eq(schema.privacyRequests.type, 'DELETE'), eq(schema.privacyRequests.status, 'PENDING')))) as any[];

    beforeEach(async () => {
      const [u] = await db.insert(schema.users).values({ email: 'ada@example.com', passwordHash: 'h:secret', firstName: 'Ada', lastName: 'L' }).returning();
      userId = u.id;
    });

    it('records the withdrawal and schedules the account for closure after the usual cooling-off', async () => {
      await privacy.setConsent(userId, 'ACCOUNT_SERVICE', true, ctx);
      expect(await pending()).toHaveLength(0);
      const out: any = await privacy.setConsent(userId, 'ACCOUNT_SERVICE', false, ctx);
      expect(out.consents.ACCOUNT_SERVICE.granted).toBe(false);
      const [req] = await pending();
      expect(req.note).toBe('CONSENT_WITHDRAWN');
      expect(Math.abs(req.executeAfter.getTime() - (Date.now() + DELETION_GRACE_MS))).toBeLessThan(60_000);
      expect(out.accountClosure.executeAfter).toBe(req.executeAfter.toISOString());
      expect(mails.map((m) => m.subject)).toEqual(['Your Orion account will be closed']);
      expect(((await db.select().from(schema.consentRecords)) as any[]).map((r) => `${r.purpose}:${r.granted}`)).toEqual(['ACCOUNT_SERVICE:true', 'ACCOUNT_SERVICE:false']);
    });

    it('withdrawing twice keeps one closure and sends one e-mail', async () => {
      await privacy.setConsent(userId, 'ACCOUNT_SERVICE', false, ctx);
      await privacy.setConsent(userId, 'ACCOUNT_SERVICE', false, ctx);
      expect(await pending()).toHaveLength(1);
      expect(mails).toHaveLength(1);
    });

    it('giving the consent back cancels the closure that withdrawal started', async () => {
      await privacy.setConsent(userId, 'ACCOUNT_SERVICE', false, ctx);
      const out: any = await privacy.setConsent(userId, 'ACCOUNT_SERVICE', true, ctx);
      expect(out.accountClosure).toBeNull();
      expect(await pending()).toHaveLength(0);
      expect(out.consents.ACCOUNT_SERVICE.granted).toBe(true);
    });

    it('giving consent does not cancel a deletion the person asked for themselves', async () => {
      await privacy.requestDeletion(userId, 'ada@example.com', 'secret', ctx);
      await privacy.setConsent(userId, 'ACCOUNT_SERVICE', true, ctx);
      expect(await pending()).toHaveLength(1);
      // and withdrawing while their own deletion is already scheduled does not add a second one
      await privacy.setConsent(userId, 'ACCOUNT_SERVICE', false, ctx);
      expect(await pending()).toHaveLength(1);
    });

    it('withdrawing an optional purpose closes nothing', async () => {
      for (const p of ['MARKETING', 'PRODUCT_UPDATES', 'ANALYTICS']) await privacy.setConsent(userId, p, false, ctx);
      expect(await pending()).toHaveLength(0);
      expect(mails).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ O7
  describe('a confirmed erasure request feeds contact suppression (O7)', () => {
    const request = (over: Record<string, unknown> = {}) =>
      plainToInstance(CreateRightsRequestDto, { type: 'ERASURE', email: 'Asha@Example.com', name: 'Asha Rao', relationship: 'OTHER', processingConsent: true, ...over });
    const tokenFromMail = () => {
      const m = mails.find((x) => x.text.includes('#token='))!;
      return { ref: m.text.match(/ref=(DR-[A-Z2-9]{10})/)![1], token: m.text.match(/#token=([A-Za-z0-9_-]+)/)![1] };
    };
    const seedContact = async (email: string) => {
      const [b] = await db.insert(schema.businesses).values({ slug: `b-${Math.random().toString(36).slice(2)}`, name: 'Acme Traders', status: 'PUBLISHED', publishedAt: new Date() }).returning();
      const [c] = await db.insert(schema.businessContacts).values({ businessId: b.id, fullName: 'Asha', email }).returning();
      return c;
    };
    const rowOf = async (ref: string) => ((await db.select().from(schema.dataSubjectRequests).where(eq(schema.dataSubjectRequests.reference, ref))) as any[])[0];

    it('e-mails a confirmation link (token in the fragment, not the query) and removes nothing before it is used', async () => {
      const c = await seedContact('asha@example.com');
      await rights.create(request(), ctx);
      const { ref, token } = tokenFromMail();
      expect(mails[0].text).toContain(`https://app.example.test/data-rights/verify?ref=${ref}#token=`);
      expect(mails[0].text).not.toMatch(/\?[^\s#]*token=/); // nothing named token before the '#'
      expect((mails[0] as any).sensitive).toBe(true);
      expect(token.length).toBeGreaterThan(20);
      expect(((await db.select().from(schema.businessContacts)) as any[]).map((x) => x.id)).toEqual([c.id]);
      expect(await db.select().from(schema.contactSuppressions)).toHaveLength(0);
    });

    it('a wrong token, an unknown reference or another request type is refused the same way and changes nothing', async () => {
      await seedContact('asha@example.com');
      await rights.create(request(), ctx);
      const { ref } = tokenFromMail();
      for (const [r, t] of [[ref, 'x'.repeat(32)], ['DR-NOSUCHREF1', 'x'.repeat(32)]] as const) {
        await expect(rights.verifyErasure(r, t, ctx)).rejects.toMatchObject({ errorCode: 'INVALID_CONFIRMATION' });
      }
      await rights.create(request({ type: 'ACCESS' }), ctx); // an ACCESS request has a token too, but it can never erase
      const access = ((await db.select().from(schema.dataSubjectRequests)) as any[]).find((r) => r.type === 'ACCESS');
      await expect(rights.verifyErasure(access.reference, 'whatever-token-value', ctx)).rejects.toMatchObject({ errorCode: 'INVALID_CONFIRMATION' });
      expect(await db.select().from(schema.contactSuppressions)).toHaveLength(0);
      expect((await rowOf(ref)).verifiedAt).toBeNull();
    });

    it('the right token suppresses the address, removes the company contact, and closes the request leaving no personal data', async () => {
      await seedContact('asha@example.com');
      await seedContact('someone.else@example.com');
      await rights.create(request(), ctx);
      const { ref, token } = tokenFromMail();
      expect(await rights.verifyErasure(ref, token, ctx)).toEqual({ verified: true, completed: true });
      const remaining = ((await db.select().from(schema.businessContacts)) as any[]).map((x) => x.email);
      expect(remaining).toEqual(['someone.else@example.com']);
      const sup = (await db.select().from(schema.contactSuppressions)) as any[];
      expect(sup).toHaveLength(1);
      expect(sup[0]).toMatchObject({ identityKind: 'EMAIL', reasonCode: 'REMOVAL' });
      const row = await rowOf(ref);
      expect(row).toMatchObject({ status: 'COMPLETED', evidence: 'EMAIL_CONTROL', contactEmail: null, details: null, requesterNote: null });
      expect(row.verifiedAt).toBeTruthy();
      expect(row.resultSummary).toMatchObject({ contactsRemoved: 1, peopleMatchedForReview: 0 });
      // re-importing the address is blocked by the register (the database guard)
      const [b] = await db.select().from(schema.businesses).limit(1);
      expect(await db.insert(schema.businessContacts).values({ businessId: b.id, fullName: 'Asha again', email: 'ASHA@example.com ' }).returning()).toHaveLength(0);
    });

    it('opening the link twice is harmless', async () => {
      await rights.create(request(), ctx);
      const { ref, token } = tokenFromMail();
      await rights.verifyErasure(ref, token, ctx);
      expect(await rights.verifyErasure(ref, token, ctx)).toMatchObject({ verified: true });
      expect(await db.select().from(schema.contactSuppressions)).toHaveLength(1);
    });

    it('an expired link is refused', async () => {
      await rights.create(request(), ctx);
      const { ref, token } = tokenFromMail();
      await client.exec(`UPDATE data_subject_requests SET created_at = now() - interval '8 days'`);
      await expect(rights.verifyErasure(ref, token, ctx)).rejects.toMatchObject({ errorCode: 'INVALID_CONFIRMATION' });
      expect(await db.select().from(schema.contactSuppressions)).toHaveLength(0);
    });

    it('when the address is also a person\'s work e-mail the request stays APPROVED for a reviewer, with the count, and keeps the address to work from', async () => {
      const [person] = await db.insert(schema.people).values({ fullName: 'Asha Rao', normalizedName: 'asha rao' } as any).returning();
      await db.insert(schema.personContacts).values({ personId: person.id, contactType: 'WORK_EMAIL', contactValue: 'asha@example.com', normalizedValue: 'asha@example.com' } as any);
      await rights.create(request(), ctx);
      const { ref, token } = tokenFromMail();
      expect(await rights.verifyErasure(ref, token, ctx)).toEqual({ verified: true, completed: false });
      const row = await rowOf(ref);
      expect(row).toMatchObject({ status: 'APPROVED', contactEmail: 'asha@example.com' });
      expect(row.resultSummary.peopleMatchedForReview).toBe(1);
      expect(((await db.select().from(schema.people)) as any[])[0].dataStatus).not.toBe('SUPPRESSED'); // only a reviewer suppresses a person
    });

    it('other request types get no confirmation link', async () => {
      await rights.create(request({ type: 'ACCESS' }), ctx);
      expect(mails[0].text).not.toContain('/data-rights/verify');
    });
  });
});
