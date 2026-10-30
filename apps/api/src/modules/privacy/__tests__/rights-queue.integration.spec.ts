import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { plainToInstance } from 'class-transformer';
import * as path from 'path';
import { AuditLogService } from '../../../common/services/audit-log.service';
import * as schema from '../../../database/schema';
import { ContactSuppressionService } from '../contact-suppression.service';
import { CreateRightsRequestDto, DecideRightsRequestDto } from '../dto/rights-request.dto';
import { RightsRequestService } from '../rights-request.service';

/** The admin side of the DPDP rights queue: what a reviewer sees, what each decision requires, and what it leaves behind. */
const MIGRATIONS = path.resolve(__dirname, '../../../database/migrations');
const ctx = { ip: '203.0.113.9', userAgent: 'jest' };

describe('DPDP rights queue (admin)', () => {
  let client: PGlite;
  let db: any;
  let svc: RightsRequestService;
  let adminId: string;
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  let mailOk = true;
  const previousFrontend = process.env.FRONTEND_URL;

  const make = async (over: Record<string, unknown> = {}) => {
    const dto = plainToInstance(CreateRightsRequestDto, { type: 'ACCESS', email: 'asha@example.com', name: 'Asha Rao', relationship: 'OTHER', processingConsent: true, details: 'Please show me what you hold.', ...over });
    const receipt = await svc.create(dto, ctx);
    mails.length = 0; // the acknowledgement is not under test here
    return receipt.reference as string;
  };
  const decide = (reference: string, body: Record<string, unknown>) => svc.decide(reference, adminId, plainToInstance(DecideRightsRequestDto, body), ctx);
  const rowOf = async (reference: string) => ((await db.select().from(schema.dataSubjectRequests).where(eq(schema.dataSubjectRequests.reference, reference))) as any[])[0];

  beforeAll(async () => {
    process.env.FRONTEND_URL = 'https://app.example.test';
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const audit = new AuditLogService(db);
    const mail = { sendChecked: async (m: any) => (mailOk ? (mails.push(m), true) : false) } as any;
    svc = new RightsRequestService(db, audit, mail, new ContactSuppressionService(db, audit));
  });
  afterAll(async () => {
    if (previousFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontend;
    await client.close();
  });
  beforeEach(async () => {
    mails.length = 0;
    mailOk = true;
    await client.exec('TRUNCATE users, businesses, data_subject_requests, contact_suppressions, people CASCADE');
    const [u] = await db.insert(schema.users).values({ email: 'reviewer@orion.test', firstName: 'Rev', lastName: 'Iewer', role: 'ADMIN' }).returning();
    adminId = u.id;
  });

  it('lists open requests soonest deadline first, and finished ones on request', async () => {
    const a = await make({ type: 'ACCESS' });
    const e = await make({ type: 'ERASURE', email: 'b@example.com' });
    await client.exec(`UPDATE data_subject_requests SET due_at = now() + interval '2 days' WHERE reference = '${e}'`);
    expect((await svc.listOpen()).map((r: any) => r.reference)).toEqual([e, a]);
    await decide(a, { action: 'COMPLETE', identityChecked: true });
    expect((await svc.listOpen()).map((r: any) => r.reference)).toEqual([e]);
    expect((await svc.listOpen(true)).map((r: any) => r.reference)).toEqual([a]);
  });

  it('shows where the address appears: an account, company contacts, and people by name', async () => {
    const [b] = await db.insert(schema.businesses).values({ slug: 'acme', name: 'Acme', status: 'PUBLISHED', publishedAt: new Date() }).returning();
    await db.insert(schema.businessContacts).values({ businessId: b.id, fullName: 'Asha', email: 'ASHA@example.com' });
    await db.insert(schema.users).values({ email: 'asha@example.com', firstName: 'Asha', lastName: 'Rao' });
    const [p] = await db.insert(schema.people).values({ fullName: 'Asha Rao', normalizedName: 'asha rao' } as any).returning();
    await db.insert(schema.personContacts).values({ personId: p.id, contactType: 'WORK_EMAIL', contactValue: 'asha@example.com', normalizedValue: 'asha@example.com' } as any);
    const ref = await make();
    const d: any = await svc.detail(ref);
    expect(d.found).toMatchObject({ customerAccount: true, companyContacts: 1 });
    expect(d.found.people).toEqual([{ id: p.id, fullName: 'Asha Rao', dataStatus: expect.any(String) }]);
    expect(d.contactEmail).toBe('asha@example.com');
    expect(JSON.stringify(d)).not.toMatch(/tokenHash|token_hash/);
    await expect(svc.detail('DR-NOSUCHREF1')).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
  });

  it('asking for information needs a message, e-mails the requester, keeps the request open and keeps the address', async () => {
    const ref = await make({ type: 'CORRECTION', details: 'My job title is wrong.' });
    await expect(decide(ref, { action: 'REQUEST_INFO' })).rejects.toMatchObject({ errorCode: 'MESSAGE_REQUIRED' });
    expect(await decide(ref, { action: 'REQUEST_INFO', message: 'Which company shows the wrong title?' })).toEqual({ reference: ref, status: 'NEEDS_INFO' });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'asha@example.com' });
    expect(mails[0].subject).toContain(ref);
    expect(mails[0].text).toContain('Which company shows the wrong title?');
    const row = await rowOf(ref);
    expect(row).toMatchObject({ status: 'NEEDS_INFO', contactEmail: 'asha@example.com', decidedById: adminId, completedAt: null });
  });

  it('a rejection needs a message and an internal reason, tells the requester only the message, and leaves no personal data', async () => {
    const ref = await make();
    await expect(decide(ref, { action: 'REJECT', message: 'We cannot do this.' })).rejects.toMatchObject({ errorCode: 'REASON_REQUIRED' });
    await expect(decide(ref, { action: 'REJECT', reason: 'Looks like fraud.' })).rejects.toMatchObject({ errorCode: 'REASON_REQUIRED' });
    await decide(ref, { action: 'REJECT', message: 'We could not confirm who you are.', reason: 'Mismatch with the account holder.' });
    expect(mails[0].text).toContain('We could not confirm who you are.');
    expect(mails[0].text).toContain('Data Protection Board of India');
    expect(mails[0].text).not.toContain('Mismatch with the account holder');
    expect(await rowOf(ref)).toMatchObject({ status: 'REJECTED', contactEmail: null, details: null, requesterNote: null, decisionReason: 'Mismatch with the account holder.', decidedById: adminId });
  });

  it('completing anything but a grievance or an erasure needs the reviewer to confirm they checked who the requester is', async () => {
    for (const type of ['ACCESS', 'CORRECTION', 'WITHDRAWAL', 'NOMINATION']) {
      const ref = await make({ type, email: `${type.toLowerCase()}@example.com`, details: 'Details of the request here.' });
      await expect(decide(ref, { action: 'COMPLETE' })).rejects.toMatchObject({ errorCode: 'IDENTITY_NOT_CHECKED' });
      await expect(decide(ref, { action: 'COMPLETE', identityChecked: false })).rejects.toMatchObject({ errorCode: 'IDENTITY_NOT_CHECKED' });
      expect((await rowOf(ref)).status).toBe('REQUESTED');
      await decide(ref, { action: 'COMPLETE', identityChecked: true, message: 'Done.' });
      expect(await rowOf(ref)).toMatchObject({ status: 'COMPLETED', contactEmail: null, completedAt: expect.any(Date) });
      expect((await rowOf(ref)).resultSummary).toMatchObject({ identityChecked: true });
    }
    const g = await make({ type: 'GRIEVANCE', email: 'g@example.com', details: 'The notice was unclear to me.' });
    await expect(decide(g, { action: 'COMPLETE', message: 'We have updated the notice.' })).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('an erasure cannot be completed before the address is confirmed, nor while a matching person is still not suppressed', async () => {
    const [p] = await db.insert(schema.people).values({ fullName: 'Asha Rao', normalizedName: 'asha rao' } as any).returning();
    await db.insert(schema.personContacts).values({ personId: p.id, contactType: 'WORK_EMAIL', contactValue: 'asha@example.com', normalizedValue: 'asha@example.com' } as any);
    const ref = await make({ type: 'ERASURE' });
    await expect(decide(ref, { action: 'COMPLETE' })).rejects.toMatchObject({ errorCode: 'NOT_VERIFIED' });
    // the requester confirms the address (the mail carries the link)
    await client.exec(`UPDATE data_subject_requests SET verified_at = now(), evidence = 'EMAIL_CONTROL', status = 'APPROVED' WHERE reference = '${ref}'`);
    await expect(decide(ref, { action: 'COMPLETE' })).rejects.toMatchObject({ errorCode: 'PEOPLE_NOT_SUPPRESSED' });
    expect((await rowOf(ref)).status).toBe('APPROVED');
    // a reviewer suppresses the person in People Review
    await client.exec(`UPDATE people SET data_status = 'SUPPRESSED'`);
    await expect(decide(ref, { action: 'COMPLETE', message: 'Your address has been removed.' })).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(mails.at(-1)!.text).toContain('Your address has been removed.');
    expect(await rowOf(ref)).toMatchObject({ contactEmail: null });
  });

  it('if the e-mail to the requester cannot be sent nothing changes, so the request can be retried', async () => {
    const ref = await make({ type: 'GRIEVANCE', details: 'I have a complaint about my data.' });
    mailOk = false;
    await expect(decide(ref, { action: 'COMPLETE', message: 'Resolved.' })).rejects.toMatchObject({ errorCode: 'EMAIL_FAILED' });
    expect(await rowOf(ref)).toMatchObject({ status: 'REQUESTED', contactEmail: 'asha@example.com', decidedById: null, completedAt: null });
    mailOk = true;
    await expect(decide(ref, { action: 'COMPLETE', message: 'Resolved.' })).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('a finished request cannot be decided again, and the decision is audited under the reviewer without the requester\'s address', async () => {
    const ref = await make({ type: 'GRIEVANCE', details: 'I have a complaint about my data.' });
    await decide(ref, { action: 'COMPLETE' });
    await expect(decide(ref, { action: 'REJECT', message: 'No.', reason: 'Because.' })).rejects.toMatchObject({ errorCode: 'REQUEST_CLOSED' });
    await new Promise((r) => setTimeout(r, 50));
    const audits = ((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'DPDP_REQUEST_DECISION'))) as any[]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: adminId, entityId: ref });
    expect(JSON.stringify(audits[0])).not.toContain('example.com');
  });

  it('rejects an unknown action at validation', async () => {
    const { validate } = await import('class-validator');
    expect(await validate(plainToInstance(DecideRightsRequestDto, { action: 'APPROVE_ALL' }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(DecideRightsRequestDto, { action: 'COMPLETE', message: 'x'.repeat(301) }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(DecideRightsRequestDto, { action: 'COMPLETE', identityChecked: 'yes' }))).not.toHaveLength(0);
  });
});
