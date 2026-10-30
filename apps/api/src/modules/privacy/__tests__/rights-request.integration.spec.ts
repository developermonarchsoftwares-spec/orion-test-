import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import * as path from 'path';
import * as schema from '../../../database/schema';
import { CreateRightsRequestDto } from '../dto/rights-request.dto';
import { RightsRequestService } from '../rights-request.service';
import { CONSENT_PURPOSES, RIGHTS_REQUEST_TYPES } from '../privacy.config';

/** DPDP Act Data Principal requests: real migrations on in-memory PGlite, mail and audit replaced by recorders. */
const MIGRATIONS = path.resolve(__dirname, '../../../database/migrations');
const ctx = { ip: '203.0.113.9', userAgent: 'jest' };

const body = (over: Record<string, unknown> = {}) => ({
  type: 'ACCESS', email: 'Asha@Example.com', name: 'Asha Rao', relationship: 'OTHER', processingConsent: true, ...over,
});

describe('DPDP rights requests', () => {
  let client: PGlite;
  let db: any;
  let svc: RightsRequestService;
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  const audits: any[] = [];

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const mail = { sendChecked: async (m: any) => (mails.push(m), true) } as any;
    const audit = { record: async (a: any) => void audits.push(a) } as any;
    svc = new RightsRequestService(db, audit, mail);
  });
  afterAll(async () => client.close());
  beforeEach(async () => {
    await client.exec('TRUNCATE data_subject_requests CASCADE');
    mails.length = 0;
    audits.length = 0;
  });

  it('offers every DPDP right and the account-service consent purpose', () => {
    expect([...RIGHTS_REQUEST_TYPES]).toEqual(['ACCESS', 'CORRECTION', 'ERASURE', 'WITHDRAWAL', 'GRIEVANCE', 'NOMINATION']);
    expect(CONSENT_PURPOSES).toContain('ACCOUNT_SERVICE');
  });

  it('stores the request with a reference and a 30-day deadline, and acknowledges it by e-mail', async () => {
    const dto = plainToInstance(CreateRightsRequestDto, body());
    const receipt = await svc.create(dto, ctx);
    expect(receipt.accepted).toBe(true);
    expect(receipt.reference).toMatch(/^DR-[A-Z2-9]{10}$/);
    const rows = await db.select().from(schema.dataSubjectRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'ACCESS', status: 'REQUESTED', subjectKind: 'EMAIL', evidence: 'NONE', contactEmail: 'asha@example.com' });
    expect(rows[0].subjectDigest).toMatch(/^[0-9a-f]{64}$/);
    const days = (rows[0].dueAt.getTime() - rows[0].createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('asha@example.com');
    expect(mails[0].text).toContain(receipt.reference);
    // the audit event names the request, never the requester's address
    expect(audits[0]).toMatchObject({ action: 'DPDP_RIGHTS_REQUEST', entityId: receipt.reference });
    expect(JSON.stringify(audits[0])).not.toContain('example.com');
  });

  it('a repeat of an open request is a quiet no-op: no second row, no second e-mail, no reference to enumerate', async () => {
    await svc.create(plainToInstance(CreateRightsRequestDto, body()), ctx);
    const again = await svc.create(plainToInstance(CreateRightsRequestDto, body({ email: ' ASHA@example.com ' })), ctx);
    expect(again).toEqual({ accepted: true, reference: null, dueAt: null });
    expect(await db.select().from(schema.dataSubjectRequests)).toHaveLength(1);
    expect(mails).toHaveLength(1);
    // a different right from the same person is a different request
    expect((await svc.create(plainToInstance(CreateRightsRequestDto, body({ type: 'ERASURE' })), ctx)).reference).toBeTruthy();
  });

  it('correction, grievance and nomination need a description', async () => {
    for (const type of ['CORRECTION', 'GRIEVANCE', 'NOMINATION']) {
      await expect(svc.create(plainToInstance(CreateRightsRequestDto, body({ type, details: 'short' })), ctx)).rejects.toMatchObject({ errorCode: 'DETAILS_REQUIRED' });
    }
    await expect(svc.create(plainToInstance(CreateRightsRequestDto, body({ type: 'GRIEVANCE', details: 'My details are shown incorrectly.' })), ctx)).resolves.toMatchObject({ accepted: true });
  });

  it('rejects a bad type, a bad address and a missing processing consent at validation', async () => {
    expect(await validate(plainToInstance(CreateRightsRequestDto, body()))).toHaveLength(0);
    for (const bad of [{ type: 'DELETE_EVERYTHING' }, { email: 'not-an-email' }, { processingConsent: false }, { processingConsent: undefined }, { relationship: 'ROBOT' }, { name: 'A' }]) {
      expect((await validate(plainToInstance(CreateRightsRequestDto, body(bad)))).length).toBeGreaterThan(0);
    }
  });

  it('the admin queue lists open requests soonest deadline first and drops finished ones', async () => {
    await svc.create(plainToInstance(CreateRightsRequestDto, body({ type: 'ACCESS' })), ctx);
    await svc.create(plainToInstance(CreateRightsRequestDto, body({ type: 'ERASURE', email: 'b@example.com' })), ctx);
    await client.exec(`UPDATE data_subject_requests SET due_at = now() + interval '2 days' WHERE type = 'ERASURE'`);
    await svc.create(plainToInstance(CreateRightsRequestDto, body({ type: 'WITHDRAWAL', email: 'c@example.com' })), ctx);
    await client.exec(`UPDATE data_subject_requests SET status = 'COMPLETED' WHERE type = 'WITHDRAWAL'`);
    const open = await svc.listOpen();
    expect(open.map((r: any) => r.type)).toEqual(['ERASURE', 'ACCESS']);
  });
});
