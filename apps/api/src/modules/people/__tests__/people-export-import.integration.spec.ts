import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { DynamicModule, Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { UserRole } from '@orion/shared';
import { and, eq, sql } from 'drizzle-orm';
import * as jwt from 'jsonwebtoken';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { applyUploadBodyLimit } from '../../../common/http/upload-body-limit';
import { TransformInterceptor } from '../../../common/interceptors/transform.interceptor';
import { DRIZZLE_DATABASE } from '../../../database/database.constants';
import { DrizzleDb } from '../../../database/database.provider';
import * as schema from '../../../database/schema';
import { queueJobs } from '../../../database/schema/queue_jobs';
import { TransactionService } from '../../../database/transaction.service';
import { classifyRole } from '../classification/role-classifier';
import { PeopleExportImportController } from '../ingestion/people-export-import.controller';
import { IMPORT_SLICE_SIZE, PeopleExportImportService } from '../ingestion/people-export-import.service';
import { PeopleImportJobService } from '../ingestion/people-import-job.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import { QueueService } from '../../queue/queue.service';
import { StorageService } from '../../storage/storage.service';
import { PeopleIngestionService } from '../ingestion/people-ingestion.service';
import { ObservationService } from '../observations/observation.service';
import { OBSERVATION_LIMITS } from '../observations/observation-policy';
import { PeopleWriteService } from '../people-write.service';
import { SourceRegistryService } from '../sources/source-registry.service';
import { expectLedgerConsistent } from './ledger-invariants';
import { exportRow, ExportRowInput, toCsv, toJson } from './people-export-fixtures';
import { createTestDb, JOURNALED_MIGRATIONS, seedBusiness, seedUser } from './pglite-test-db';

const SECRET = 'people-export-import-secret';
class TestJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: SECRET });
  }
  validate(payload: unknown) {
    return payload;
  }
}
@Global()
@Module({})
class TestDbModule {
  static forDb(db: DrizzleDb): DynamicModule {
    return { module: TestDbModule, global: true, providers: [{ provide: DRIZZLE_DATABASE, useValue: db }, TransactionService], exports: [DRIZZLE_DATABASE, TransactionService] };
  }
}

/** In-memory stand-in for the private object storage the import file is staged in. */
class FakeStorage {
  files = new Map<string, Buffer>();
  failUpload = false;
  async uploadFile(o: { key: string; buffer: Buffer }) {
    if (this.failUpload) throw new Error('storage down: secret-endpoint.example');
    this.files.set(o.key, o.buffer);
    return { key: o.key } as any;
  }
  async getFileStream(key: string) {
    const b = this.files.get(key);
    if (!b) throw new Error('NoSuchKey');
    return Readable.from([b]);
  }
  async deleteFile(key: string) {
    return this.files.delete(key);
  }
}

/** The pg Pool surface QueueService uses, over the in-process PGlite database. */
const poolOver = (client: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) => {
  const query = async (text: string, params?: unknown[]) => {
    const r = await client.query(text, params);
    return { rows: r.rows, rowCount: r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => undefined }) };
};

const PREFIX = '/api/v1';
const URL = `${PREFIX}/admin/people/import`;
const GSTIN_A = '27AAACT2727Q1ZW';
const CIN_B = 'L22210MH1995PLC084781';
const PAN_C = 'AAACI4397H';
const nameOf = (slug: string) => `${slug} Pvt Ltd`; // seedBusiness names a company "<slug> Pvt Ltd"

describe('People export import (Phase 8A): POST /admin/people/import', () => {
  let app: INestApplication;
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let ingestion: PeopleIngestionService;
  let jobs: PeopleImportJobService;
  let queue: QueueService;
  const storage = new FakeStorage();
  let tokens: { admin: string; superAdmin: string; dataManager: string; customer: string };
  let n = 0;
  const A = { slug: 'alpha-works', city: 'Pune', state: 'Maharashtra' };
  const B = { slug: 'bravo-mills', city: 'Chennai', state: 'Tamil Nadu' };
  const C = { slug: 'charlie-foods', city: 'Jaipur', state: 'Rajasthan' };
  const D = { slug: 'delta-labs', city: 'Kochi', state: 'Kerala' };
  const biz: Record<string, { id: string }> = {};

  const tokenFor = (id: string, role: string) => jwt.sign({ sub: id, email: `${id}@t.dev`, role }, SECRET);
  const post = (body: object, token: string | null = tokens.admin) => {
    const r = request(app.getHttpServer()).post(URL);
    return (token ? r.set('Authorization', `Bearer ${token}`) : r).send(body);
  };
  const letters = (k: number) => {
    let s = '';
    let v = k + 1;
    while (v > 0) {
      s = String.fromCharCode(97 + ((v - 1) % 26)) + s;
      v = Math.floor((v - 1) / 26);
    }
    return s;
  };
  /** A unique, valid two-word person name (letters only). */
  const pname = () => `Asha${letters(++n)} Raov${letters(n * 7)}`;
  const row = (over: Partial<ExportRowInput> = {}): ExportRowInput =>
    exportRow({
      company_name: nameOf(A.slug), company_city: A.city, company_state: A.state, full_name: pname(), job_title: 'Head of Procurement',
      relationship_id: randomUUID(), ...over,
    });
  /** An export timestamp in the recent past, so it is always valid whatever day the suite runs. */
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const csv = (rows: ExportRowInput[]) => ({ format: 'csv', content: toCsv(rows) });
  const json = (rows: ExportRowInput[]) => ({ format: 'json', content: toJson(rows) });
  const get = (jobId: string, token: string | null = tokens.admin) => {
    const r = request(app.getHttpServer()).get(`${URL}/${jobId}`);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  /** Poll the job until the worker has finished it; returns the final status response. */
  const finished = async (jobId: string, timeoutMs = 90_000) => {
    const started = Date.now();
    for (;;) {
      const res = await get(jobId);
      const view = res.body.data ?? res.body;
      if (res.status !== 200 || !['QUEUED', 'RUNNING'].includes(view.status)) return { res, data: view as any };
      if (Date.now() - started > timeoutMs) throw new Error(`import job ${jobId} did not finish: ${view.status}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  /** Queue an import and wait for the background worker to finish it. */
  const run = async (rows: ExportRowInput[], extra: object = {}, as: 'csv' | 'json' = 'csv') => {
    const accepted = await post({ ...(as === 'csv' ? csv(rows) : json(rows)), ...extra });
    expect(accepted.status).toBe(202); // every flow that uses run() is expected to be accepted
    const out = await finished((accepted.body.data ?? accepted.body).jobId);
    expect(out.res.status).toBe(200);
    return out;
  };
  const count = async (table: any) => (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n as number;
  const snapshot = async () => ({
    businesses: await count(schema.businesses), locations: await count(schema.businessLocations), identifiers: await count(schema.businessIdentifiers),
    people: await count(schema.people), roles: await count(schema.companyPeople), contacts: await count(schema.personContacts),
    evidence: await count(schema.peopleEvidence), quarantine: await count(schema.peopleIngestionQuarantine),
    observations: await count(schema.peopleObservations), verifications: await count(schema.peopleVerifications),
  });
  const personByName = async (name: string) => (await db.select().from(schema.people).where(eq(schema.people.normalizedName, name.toLowerCase())))[0];
  const rolesOf = (personId: string) => db.select().from(schema.companyPeople).where(eq(schema.companyPeople.personId, personId));
  const contactsOf = (personId: string) => db.select().from(schema.personContacts).where(eq(schema.personContacts.personId, personId));
  const quarantined = (batchRef: string) => db.select().from(schema.peopleIngestionQuarantine).where(eq(schema.peopleIngestionQuarantine.batchRef, batchRef));

  beforeAll(async () => {
    const t = await createTestDb([...JOURNALED_MIGRATIONS, '0017_queue_jobs_admin_otps.sql']);
    db = t.db;
    close = () => t.client.close();
    const module = await Test.createTestingModule({
      imports: [PassportModule, TestDbModule.forDb(db)],
      controllers: [PeopleExportImportController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        TestJwtStrategy, JwtAuthGuard, RolesGuard, Reflector,
        PeopleWriteService, PeopleIngestionService, PeopleExportImportService, SourceRegistryService, ObservationService, PeopleImportJobService,
        { provide: StorageService, useValue: storage },
        { provide: QueueService, useFactory: () => new QueueService(t.db, poolOver(t.client as any) as any) },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix(PREFIX.slice(1));
    applyUploadBodyLimit(app, PREFIX); // exactly what main.ts does
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
    await app.init();
    // listen once so parallel supertest requests share one live server (otherwise each starts it and the first to finish closes it: ECONNRESET)
    await app.listen(0, '127.0.0.1');
    ingestion = module.get(PeopleIngestionService);
    jobs = module.get(PeopleImportJobService);
    queue = module.get(QueueService);

    for (const c of [A, B, C, D]) biz[c.slug] = await seedBusiness(db, c.slug, { city: c.city, state: c.state });
    await db.insert(schema.businessIdentifiers).values([
      { businessId: biz[A.slug].id, type: 'GSTIN', value: GSTIN_A, normalizedValue: GSTIN_A },
      { businessId: biz[B.slug].id, type: 'CIN', value: CIN_B, normalizedValue: CIN_B },
      { businessId: biz[C.slug].id, type: 'PAN', value: PAN_C, normalizedValue: PAN_C },
    ]);
    // two same-named companies in the same city: a name + location match cannot choose between them
    for (const slug of ['twin-one', 'twin-two']) {
      const [b] = await db.insert(schema.businesses).values({ slug, name: 'Twin Works Pvt Ltd', status: 'PUBLISHED', publishedAt: new Date() }).returning();
      await db.insert(schema.businessLocations).values({ businessId: b.id, addressLine1: '1 Test Street', city: 'Nagpur', district: 'Nagpur', state: 'Maharashtra', pincode: '440001', isPrimary: true });
    }
    const [admin, superAdmin, dm, customer] = await Promise.all([
      seedUser(db, 'pimp.admin@orion.test', undefined, 'ADMIN'), seedUser(db, 'pimp.super@orion.test', undefined, 'SUPER_ADMIN'),
      seedUser(db, 'pimp.dm@orion.test', undefined, 'DATA_MANAGER' as any), seedUser(db, 'pimp.customer@orion.test', undefined, 'USER'),
    ]);
    tokens = { admin: tokenFor(admin.id, UserRole.ADMIN), superAdmin: tokenFor(superAdmin.id, UserRole.SUPER_ADMIN), dataManager: tokenFor(dm.id, UserRole.DATA_MANAGER), customer: tokenFor(customer.id, UserRole.USER) };
  }, 120_000);

  afterAll(async () => {
    await expectLedgerConsistent(db);
    queue?.unregisterWorker(QUEUE_NAMES.PEOPLE_IMPORT);
    await app?.close();
    await close?.();
  });

  // ------------------------------------------------------------------------------------------------ authentication
  describe('authentication', () => {
    it('anonymous -> 401, customer -> 403, data manager -> 403, admin and super admin -> allowed', async () => {
      const body = { ...csv([row()]), dryRun: true };
      expect((await post(body, null)).status).toBe(401);
      expect((await post(body, 'not-a-token')).status).toBe(401);
      expect((await post(body, tokens.customer)).status).toBe(403);
      expect((await post(body, tokens.dataManager)).status).toBe(403);
      expect((await post(body, tokens.admin)).status).toBe(202);
      expect((await post(body, tokens.superAdmin)).status).toBe(202);
    });

    it('a refused caller writes nothing and learns nothing about the file', async () => {
      const before = await snapshot();
      const res = await post({ ...csv([row({ full_name: 'Secret Leaker' })]) }, tokens.customer);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toMatch(/Secret|Leaker|people-export/);
      expect(await snapshot()).toEqual(before);
    });
  });

  // ------------------------------------------------------------------------------------------------ request + file validation
  describe('validation', () => {
    it('rejects a bad request body', async () => {
      expect((await post({ format: 'xlsx', content: 'x' })).status).toBe(400);
      expect((await post({ format: 'csv' })).status).toBe(400);
      expect((await post({ content: 'x' })).status).toBe(400);
      expect((await post({ ...csv([row()]), dryRun: 'false' })).status).toBe(400); // no string -> boolean coercion
      expect((await post({ ...csv([row()]), extra: 1 })).status).toBe(400);
    });

    it('accepts CSV and JSON', async () => {
      const rows = [row({ full_name: 'Zora Qrstu' })];
      const c = await run(rows, { dryRun: true }, 'csv');
      const j = await run(rows, { dryRun: true }, 'json');
      expect(c.res.status).toBe(200);
      expect(j.res.status).toBe(200);
      expect(c.data).toMatchObject({ totalRows: 1, valid: 1, matched: 1, failed: 0 });
      expect(j.data).toMatchObject({ totalRows: 1, valid: 1, matched: 1, failed: 0 });
    });

    it.each([
      ['malformed CSV (a short row)', () => ({ format: 'csv', content: toCsv([row()]) + 'a,b\r\n' }), 'MALFORMED_CSV'],
      ['malformed JSON', () => ({ format: 'json', content: '{"export_version": "1", ' }), 'MALFORMED_JSON'],
      ['a wrong export version (CSV)', () => csv([row({ export_version: '2' })]), 'UNSUPPORTED_EXPORT_VERSION'],
      ['a wrong export version (JSON)', () => ({ format: 'json', content: toJson([row()], { export_version: '2' }) }), 'UNSUPPORTED_EXPORT_VERSION'],
      ['missing required columns', () => ({ format: 'csv', content: toCsv([row()], ['export_version', 'exported_at', 'relationship_id', 'full_name']) }), 'MISSING_COLUMNS'],
      ['a CSV sent as JSON', () => ({ format: 'json', content: toCsv([row()]) }), 'MALFORMED_JSON'],
      ['an empty export', () => ({ format: 'csv', content: toCsv([]) }), 'EMPTY_EXPORT'],
      ['an invalid exported_at', () => csv([row({ exported_at: 'yesterday-ish' })]), 'INVALID_EXPORTED_AT'],
    ])('rejects %s with a 400 and imports nothing', async (_n, body, code) => {
      const before = await snapshot();
      const res = await post(body());
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(code);
      expect(await snapshot()).toEqual(before);
    });

    it('error responses never echo file content', async () => {
      const res = await post({ format: 'csv', content: toCsv([row({ full_name: 'Veronica Leakwell', email: 'leakwell@secret.example' })]) + 'leakwell@secret.example,x\r\n' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/Leakwell|leakwell|secret\.example/);
    });

    it(`refuses a file above ${OBSERVATION_LIMITS.MAX_RECORDS_PER_RUN} rows whole, over HTTP, importing nothing`, async () => {
      const before = await snapshot();
      const rows = Array.from({ length: OBSERVATION_LIMITS.MAX_RECORDS_PER_RUN + 1 }, (_, i) =>
        exportRow({ relationship_id: randomUUID(), full_name: `Bulk Person${letters(i)}`, job_title: 'CEO', company_name: nameOf(A.slug), company_city: A.city, company_state: A.state }),
      );
      const res = await post(csv(rows));
      expect(res.status).toBe(413);
      expect(JSON.stringify(res.body)).toContain('BATCH_TOO_LARGE');
      expect(await snapshot()).toEqual(before);
    }, 120_000);

    it('the row ceiling is exact at the service: 10,000 rows go through (in slices), 10,001 never reach ingestion', async () => {
      const calls: number[] = [];
      const stub = { ingest: async (records: unknown[]) => (calls.push(records.length), { batchRef: 'x', dryRun: true, total: records.length, created: 0, updated: 0, unchanged: 0, quarantined: 0, valid: records.length, results: [] }) };
      const svc = new PeopleExportImportService(stub as unknown as PeopleIngestionService);
      const mk = (k: number) => toCsv(Array.from({ length: k }, (_, i) => exportRow({ relationship_id: randomUUID(), full_name: `Edge Person${letters(i)}` })));
      const ok = await svc.import({ format: 'csv', content: mk(OBSERVATION_LIMITS.MAX_RECORDS_PER_RUN), dryRun: true });
      expect(ok.totalRows).toBe(OBSERVATION_LIMITS.MAX_RECORDS_PER_RUN);
      await expect(svc.import({ format: 'csv', content: mk(OBSERVATION_LIMITS.MAX_RECORDS_PER_RUN + 1), dryRun: true })).rejects.toMatchObject({ errorCode: 'BATCH_TOO_LARGE' });
      expect(calls.reduce((a, b) => a + b, 0)).toBe(OBSERVATION_LIMITS.MAX_RECORDS_PER_RUN); // handed over in slices, never more
      expect(Math.max(...calls)).toBeLessThanOrEqual(IMPORT_SLICE_SIZE);
    }, 120_000);
  });

  // ------------------------------------------------------------------------------------------------ company resolution
  describe('company resolution (existing resolver; never creates a company)', () => {
    it('matches by GSTIN, CIN, PAN and by name + city + state, using none of the source-local ids', async () => {
      const before = await snapshot();
      const rows = [
        row({ company_name: null, company_city: null, company_state: null, gstin: GSTIN_A }),
        row({ company_name: null, company_city: null, company_state: null, cin: CIN_B }),
        row({ company_name: null, company_city: null, company_state: null, pan: PAN_C }),
        row({ company_name: nameOf(D.slug), company_city: D.city, company_state: D.state }),
        row({ company_name: null, company_city: null, company_state: null, gstin: GSTIN_A, business_id: biz[C.slug].id, business_slug: C.slug }), // source-local ids are ignored
      ];
      const { res, data } = await run(rows);
      expect(res.status).toBe(200);
      expect(data).toMatchObject({ totalRows: 5, imported: 5, matched: 5, unmatched: 0, ambiguous: 0, quarantined: 0, failed: 0, status: 'COMPLETED' });
      const placed = await db.select({ businessId: schema.companyPeople.businessId }).from(schema.companyPeople);
      const ids = new Set(placed.map((r) => r.businessId));
      for (const slug of [A.slug, B.slug, C.slug, D.slug]) expect(ids.has(biz[slug].id)).toBe(true);
      const after = await snapshot();
      expect({ b: after.businesses, l: after.locations, i: after.identifiers }).toEqual({ b: before.businesses, l: before.locations, i: before.identifiers });
    });

    it('quarantines an unresolved company and creates nothing', async () => {
      const before = await snapshot();
      const nm = pname();
      const { data } = await run([row({ full_name: nm, company_name: 'No Such Company Pvt Ltd', company_city: 'Pune', company_state: 'Maharashtra' })]);
      expect(data).toMatchObject({ unmatched: 1, ambiguous: 0, quarantined: 1, imported: 0, status: 'COMPLETED_WITH_ISSUES' });
      expect(data.reasonCounts).toMatchObject({ BUSINESS_NOT_FOUND: 1 });
      const q = await quarantined(data.batchRef);
      expect(q).toHaveLength(1);
      expect(q[0].status).toBe('PENDING');
      expect(await personByName(nm)).toBeUndefined();
      const after = await snapshot();
      expect(after.businesses).toBe(before.businesses);
      expect(after.people).toBe(before.people);
    });

    it('quarantines an ambiguous company (two same-named companies in one city)', async () => {
      const nm = pname();
      const { data } = await run([row({ full_name: nm, company_name: 'Twin Works Pvt Ltd', company_city: 'Nagpur', company_state: 'Maharashtra' })]);
      expect(data).toMatchObject({ ambiguous: 1, unmatched: 0, quarantined: 1, imported: 0 });
      expect(data.reasonCounts).toMatchObject({ AMBIGUOUS_COMPANY_MATCH: 1 });
      expect(await personByName(nm)).toBeUndefined();
    });

    it('quarantines conflicting identifiers (a GSTIN of one company, a PAN of another)', async () => {
      const nm = pname();
      const { data } = await run([row({ full_name: nm, company_name: null, company_city: null, company_state: null, gstin: GSTIN_A, pan: PAN_C })]);
      expect(data).toMatchObject({ ambiguous: 1, quarantined: 1, imported: 0 });
      expect(await personByName(nm)).toBeUndefined();
    });

    it('a name without a corroborating city is not enough', async () => {
      const nm = pname();
      const { data } = await run([row({ full_name: nm, company_name: nameOf(D.slug), company_city: null, company_state: null })]);
      expect(data.quarantined).toBe(1);
      expect(await personByName(nm)).toBeUndefined();
    });

    it('a malformed statutory identifier fails that row before ingestion, reported by row number and code only', async () => {
      const good = row();
      const bad = row({ full_name: 'Badge Identa', gstin: 'NOT-A-GSTIN' });
      const { data } = await run([good, bad]);
      expect(data).toMatchObject({ totalRows: 2, imported: 1, failed: 1, status: 'COMPLETED_WITH_ISSUES' });
      expect(data.rejectedRows).toEqual([{ row: 2, code: 'INVALID_COMPANY_IDENTIFIER' }]);
      expect(await personByName('Badge Identa')).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain('NOT-A-GSTIN');
    });
  });

  // ------------------------------------------------------------------------------------------------ person identity
  describe('person identity (existing resolution)', () => {
    it('a new person becomes a DRAFT person with an unpublished, PENDING, unverified role', async () => {
      const nm = pname();
      const { data } = await run([row({ full_name: nm, job_title: 'Chief Executive Officer', verification_status: 'VERIFIED', confidence_level: 'HIGH', published_at: '2026-09-30T10:00:00+00:00', last_verified_at: '2026-09-29T10:00:00+00:00' })]);
      expect(data).toMatchObject({ imported: 1, status: 'COMPLETED' });
      const p = await personByName(nm);
      expect(p).toMatchObject({ dataStatus: 'DRAFT', verificationStatus: 'UNVERIFIED', confidenceScore: 0 });
      const [role] = await rolesOf(p.id);
      expect(role).toMatchObject({ isPublished: false, reviewStatus: 'PENDING', verificationStatus: 'UNVERIFIED' });
      expect(await db.select().from(schema.peopleVerifications).where(eq(schema.peopleVerifications.personId, p.id))).toHaveLength(0);
    });

    it('the same LinkedIn updates the existing person instead of creating another', async () => {
      const li = `https://www.linkedin.com/in/same-person-${letters(++n)}`;
      const first = await run([row({ full_name: 'Kavita Menons', linkedin_url: li, job_title: 'Director' })]);
      expect(first.data.imported).toBe(1);
      const second = await run([row({ full_name: 'Kavita Menons', linkedin_url: li, job_title: 'Director', person_city: 'Pune', exported_at: hoursAgo(5) })]);
      expect(second.data).toMatchObject({ imported: 0, matched: 1 });
      expect(await db.select().from(schema.people).where(eq(schema.people.normalizedName, 'kavita menons'))).toHaveLength(1);
    });

    it('a compatible email + name updates the existing person', async () => {
      const email = `a.kumar.${letters(++n)}@alpha-works.example`;
      const first = await run([row({ full_name: 'Arun Kumarq', email, job_title: 'Director' })]);
      expect(first.data.imported).toBe(1);
      const second = await run([row({ full_name: 'A. Kumarq', email, job_title: 'Director', exported_at: hoursAgo(4) })]);
      expect(second.data).toMatchObject({ imported: 0, matched: 1 });
      const people = await db.select().from(schema.people).where(sql`${schema.people.normalizedName} IN ('arun kumarq', 'a kumarq')`);
      expect(people).toHaveLength(1);
    });

    it('the same person at another company gets another relationship, not another person', async () => {
      const li = `https://www.linkedin.com/in/two-companies-${letters(++n)}`;
      const nm = 'Meera Narayanans';
      const { data } = await run([
        row({ full_name: nm, linkedin_url: li, job_title: 'Director' }),
        row({ full_name: nm, linkedin_url: li, job_title: 'Director', company_name: nameOf(B.slug), company_city: B.city, company_state: B.state }),
      ]);
      expect(data).toMatchObject({ totalRows: 2, matched: 2, quarantined: 0 });
      const people = await db.select().from(schema.people).where(eq(schema.people.normalizedName, 'meera narayanans'));
      expect(people).toHaveLength(1);
      const roles = await rolesOf(people[0].id);
      expect(new Set(roles.map((r) => r.businessId))).toEqual(new Set([biz[A.slug].id, biz[B.slug].id]));
    });

    it('Company A -> Person 1, Company A -> Person 2, Company B -> Person 1 are three relationships and two people', async () => {
      const li1 = `https://www.linkedin.com/in/p1-${letters(++n)}`;
      const li2 = `https://www.linkedin.com/in/p2-${letters(++n)}`;
      const { data } = await run([
        row({ full_name: 'Pia Firsts', linkedin_url: li1 }),
        row({ full_name: 'Quin Seconds', linkedin_url: li2 }),
        row({ full_name: 'Pia Firsts', linkedin_url: li1, company_name: nameOf(B.slug), company_city: B.city, company_state: B.state }),
      ]);
      expect(data.imported + data.updated + data.unchanged).toBe(3);
      const p1 = await personByName('Pia Firsts');
      const p2 = await personByName('Quin Seconds');
      expect(await rolesOf(p1.id)).toHaveLength(2);
      expect(await rolesOf(p2.id)).toHaveLength(1);
    });

    it('an ambiguous identity is quarantined, not merged or created', async () => {
      const co = { company_name: nameOf(C.slug), company_city: C.city, company_state: C.state };
      for (const li of ['one', 'two']) {
        const r = await ingestion.ingest([{ businessSlug: C.slug, personName: 'Ravi Shahs', jobTitle: 'Director', linkedinUrl: `https://www.linkedin.com/in/ravi-${li}-${letters(++n)}`, source: { type: 'MANUAL_IMPORT', label: 'seed' } }]);
        expect(r.results[0].outcome).toBe('CREATED');
      }
      const before = await snapshot();
      const { data } = await run([row({ ...co, full_name: 'Ravi Shahs', job_title: 'Director' })]);
      expect(data).toMatchObject({ quarantined: 1, imported: 0 });
      expect(data.reasonCounts).toMatchObject({ AMBIGUOUS_IDENTITY: 1 });
      expect((await snapshot()).people).toBe(before.people);
    });
  });

  // ------------------------------------------------------------------------------------------------ contacts
  describe('contacts', () => {
    it('stores email, phone and mobile as unverified, unpublished contacts and LinkedIn on the person', async () => {
      const nm = 'Contact Holders';
      const li = `https://www.linkedin.com/in/contact-holders-${letters(++n)}`;
      const email = `holders.${letters(++n)}@alpha-works.example`;
      const { data } = await run([row({ full_name: nm, email, phone: '+912025550123', mobile: '+919811122334', linkedin_url: li, email_verification_status: 'VERIFIED', phone_verification_status: 'VERIFIED', mobile_verification_status: 'VERIFIED', linkedin_url_verification_status: 'VERIFIED' })]);
      expect(data.imported).toBe(1);
      const p = await personByName(nm);
      expect(p.normalizedLinkedinUrl).toContain('/in/contact-holders');
      const contacts = await contactsOf(p.id);
      expect(contacts.map((c) => c.contactType).sort()).toEqual(['MOBILE', 'PHONE', 'WORK_EMAIL']);
      for (const c of contacts) expect(c).toMatchObject({ verificationStatus: 'UNVERIFIED', isPublished: false });
      expect(contacts.find((c) => c.contactType === 'WORK_EMAIL')?.normalizedValue).toBe(email);
    });

    it('drops an invalid contact, keeps the person, and reports no contact value', async () => {
      const nm = 'Invalid Contacts';
      const { data } = await run([row({ full_name: nm, email: 'not-an-email', phone: '123', mobile: '+919811100011' })]);
      expect(data).toMatchObject({ imported: 1, quarantined: 0 });
      const p = await personByName(nm);
      expect((await contactsOf(p.id)).map((c) => c.contactType)).toEqual(['MOBILE']);
      expect(JSON.stringify(data)).not.toMatch(/not-an-email|123|9811100011/);
    });

    it('a shared mailbox is not stored as a person contact', async () => {
      const nm = 'Shared Mailbox';
      await run([row({ full_name: nm, email: 'info@alpha-works.example' })]);
      expect(await contactsOf((await personByName(nm)).id)).toHaveLength(0);
    });

    it('a duplicate contact (the same file again, or the same value in a later export) does not duplicate', async () => {
      const nm = 'Duplicate Contacts';
      const email = `dup.${letters(++n)}@alpha-works.example`;
      const li = `https://www.linkedin.com/in/dup-contacts-${letters(++n)}`;
      const r = row({ full_name: nm, email, mobile: '+919811100022', linkedin_url: li });
      await run([r]);
      const p = await personByName(nm);
      expect(await contactsOf(p.id)).toHaveLength(2);
      await run([r]);
      await run([{ ...r, exported_at: hoursAgo(3) }]);
      expect(await contactsOf(p.id)).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------------------------------------------ role classification
  describe('role classification', () => {
    it('imports job_title, and lets the existing classifier derive department, seniority and decision-maker type', async () => {
      const title = 'Head of Procurement';
      const nm = 'Role Classified';
      // the export's own values use a vocabulary Orion does not have; they must neither quarantine the row nor win
      const { data } = await run([row({ full_name: nm, job_title: title, department: 'ENGINEERING', seniority_level: 'HEAD', decision_maker_type: 'OWNER' })]);
      expect(data).toMatchObject({ imported: 1, quarantined: 0 });
      const [role] = await rolesOf((await personByName(nm)).id);
      const expected = classifyRole(title);
      expect(role.jobTitleAtCompany).toBe(title);
      expect(role).toMatchObject({ department: expected.department, seniorityLevel: expected.seniorityLevel, decisionMakerType: expected.decisionMakerType ?? null });
      expect(role.department).not.toBe('ENGINEERING');
      expect(role.decisionMakerType).not.toBe('OWNER');
    });

    it('a missing title is quarantined by the existing rule, a missing name too', async () => {
      const { data } = await run([row({ full_name: 'Titleless Person', job_title: null }), row({ full_name: null })]);
      expect(data).toMatchObject({ quarantined: 2, imported: 0 });
      expect(data.reasonCounts).toMatchObject({ MISSING_TITLE: 1, MISSING_NAME: 1 });
    });
  });

  // ------------------------------------------------------------------------------------------------ state
  describe('review state', () => {
    it('everything imported is DRAFT / PENDING / unpublished / unverified, whatever the export said', async () => {
      const { data } = await run([row({ verification_status: 'VERIFIED', published_at: '2026-09-30T10:00:00+00:00', confidence_level: 'HIGH' }), row({ verification_status: 'PARTIALLY_VERIFIED' })]);
      expect(data.imported).toBe(2);
      const published = await db.select().from(schema.companyPeople).where(eq(schema.companyPeople.isPublished, true));
      expect(published).toHaveLength(0);
      const notDraft = await db.select().from(schema.people).where(sql`${schema.people.dataStatus} <> 'DRAFT'`);
      expect(notDraft).toHaveLength(0);
      const notPending = await db.select().from(schema.companyPeople).where(and(sql`${schema.companyPeople.reviewStatus} <> 'PENDING'`));
      expect(notPending).toHaveLength(0);
      const verified = await db.select().from(schema.companyPeople).where(sql`${schema.companyPeople.verificationStatus} <> 'UNVERIFIED'`);
      expect(verified).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ provenance
  describe('provenance', () => {
    it('records the source, relationship_id as the source record id, and the export time as the acquisition time', async () => {
      const rid = randomUUID();
      const { data } = await run([row({ relationship_id: rid, full_name: 'Prove Nance', last_seen_at: '2026-09-30T09:00:00+00:00' })]);
      expect(data.source).toEqual({ key: 'people-json', version: '1' });
      const [obs] = await db.select().from(schema.peopleObservations).where(eq(schema.peopleObservations.sourceRecordId, rid));
      expect(obs).toMatchObject({ sourceKey: 'people-json', outcome: 'INGESTED', batchRef: data.batchRef });
      expect(obs.acquiredAt.toISOString()).toBe('2026-10-01T10:00:00.000Z');
      expect(obs.observedAt?.toISOString()).toBe('2026-09-30T09:00:00.000Z');
      expect(data.acquiredAt).toBe('2026-10-01T10:00:00.000Z');
    });
  });

  // ------------------------------------------------------------------------------------------------ idempotency
  describe('idempotency', () => {
    it('the same export twice creates no duplicate people, roles, contacts, evidence or observations', async () => {
      const email = `idem.${letters(++n)}@alpha-works.example`;
      const rows = [row({ full_name: 'Idem Potentone', email, mobile: '+919811100033' }), row({ full_name: 'Idem Potenttwo', company_name: nameOf(B.slug), company_city: B.city, company_state: B.state })];
      const first = await run(rows);
      expect(first.data).toMatchObject({ imported: 2, unchanged: 0 });
      const mid = await snapshot();
      const second = await run(rows);
      expect(second.data.batchRef).toBe(first.data.batchRef);
      expect(second.data).toMatchObject({ imported: 0, unchanged: 2, quarantined: 0 });
      expect(second.data.observations).toMatchObject({ recorded: 0, duplicate: 2 });
      expect(await snapshot()).toEqual(mid);
    });

    it('a later export of the same data (new exported_at) changes no People data and records new observations only', async () => {
      const rows = [row({ full_name: 'Later Exportone' })];
      await run(rows);
      const mid = await snapshot();
      const later = await run(rows.map((r) => ({ ...r, exported_at: hoursAgo(2) })));
      expect(later.data).toMatchObject({ imported: 0, quarantined: 0, matched: 1 });
      const after = await snapshot();
      expect({ p: after.people, r: after.roles, c: after.contacts, q: after.quarantine }).toEqual({ p: mid.people, r: mid.roles, c: mid.contacts, q: mid.quarantine });
      expect(after.observations).toBe(mid.observations + 1);
    });

    it('re-importing a quarantined row does not duplicate the quarantine entry', async () => {
      const rows = [row({ full_name: pname(), company_name: 'Still Missing Pvt Ltd', company_city: 'Pune', company_state: 'Maharashtra' })];
      await run(rows);
      const mid = await snapshot();
      await run(rows);
      expect((await snapshot()).quarantine).toBe(mid.quarantine);
    });
  });

  // ------------------------------------------------------------------------------------------------ dry run
  describe('dry run', () => {
    it('parses, validates and resolves without writing anything (no People, contacts, relationships, companies, quarantine or observations)', async () => {
      const before = await snapshot();
      const rows = [
        row({ full_name: 'Dry Runner', email: `dry.${letters(++n)}@alpha-works.example` }),
        row({ full_name: pname(), company_name: 'Nowhere Pvt Ltd', company_city: 'Pune', company_state: 'Maharashtra' }),
        row({ full_name: pname(), company_name: 'Twin Works Pvt Ltd', company_city: 'Nagpur', company_state: 'Maharashtra' }),
        row({ full_name: pname(), gstin: 'bad' }),
      ];
      const { res, data } = await run(rows, { dryRun: true });
      expect(res.status).toBe(200);
      expect(data).toMatchObject({ dryRun: true, status: 'DRY_RUN', totalRows: 4, valid: 1, matched: 1, unmatched: 1, ambiguous: 1, failed: 1, imported: 0, updated: 0, unchanged: 0 });
      expect(await snapshot()).toEqual(before);
    });

    it('is the same whether the file is CSV or JSON', async () => {
      const rows = [row({ full_name: 'Format Parity' })];
      const c = (await run(rows, { dryRun: true }, 'csv')).data;
      const j = (await run(rows, { dryRun: true }, 'json')).data;
      const strip = (v: any) => ({ ...v, batchRef: undefined, jobId: undefined, createdAt: undefined, updatedAt: undefined, completedAt: undefined });
      expect(strip(c)).toEqual(strip(j));
    });
  });

  // ------------------------------------------------------------------------------------------------ safe responses
  describe('responses', () => {
    it('the accepted response and the job view contain counts and codes only: no names, contacts, company names, ids, paths, storage keys, SQL or stack traces', async () => {
      const email = `safe.${letters(++n)}@alpha-works.example`;
      const li = `https://www.linkedin.com/in/safe-person-${letters(++n)}`;
      const rows = [
        row({ full_name: 'Safeguard Person', email, mobile: '+919811100044', linkedin_url: li }),
        row({ full_name: 'Orphaned Person', company_name: 'Ghost Company Pvt Ltd', company_city: 'Pune', company_state: 'Maharashtra' }),
        row({ full_name: 'Malformed Identifier', gstin: 'oops' }),
      ];
      const accepted = await post({ ...csv(rows) });
      expect(accepted.status).toBe(202);
      const a = accepted.body.data ?? accepted.body;
      expect(Object.keys(a).sort()).toEqual(['batchRef', 'dryRun', 'exportVersion', 'jobId', 'status', 'totalRows']);
      const { res, data } = await finished(a.jobId);
      const text = JSON.stringify([accepted.body, res.body]);
      for (const leak of ['Safeguard', 'Orphaned', 'Malformed', email, 'safe-person', '9811100044', 'Ghost Company', 'alpha-works', 'Pvt Ltd', 'oops', rows[0].relationship_id!, rows[0].person_id!, 'people-imports', 'storageKey', 'contentSha256', 'requestedBy', 'select ', 'stack', 'Error:', 'postgres', '/apps/', 'C:\\']) {
        expect(text).not.toContain(leak as string);
      }
      expect(Object.keys(data).sort()).toEqual(['acquiredAt', 'ambiguous', 'batchRef', 'completedAt', 'createdAt', 'dryRun', 'errorSummary', 'exportVersion', 'failed', 'imported', 'jobId', 'matched', 'observations', 'processedRows', 'quarantined', 'reasonCounts', 'reconciliation', 'rejectedRows', 'source', 'status', 'totalRows', 'unchanged', 'unmatched', 'updated', 'updatedAt', 'valid']);
    });
  });

  // ------------------------------------------------------------------------------------------------ background job (Phase 8B)
  describe('background job (Phase 8B)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const jobRow = async (jobId: string) => (await db.select().from(queueJobs).where(eq(queueJobs.id, jobId)))[0];
    const accept = async (rows: ExportRowInput[], extra: object = {}) => {
      const r = await post({ ...csv(rows), ...extra });
      expect(r.status).toBe(202);
      return (r.body.data ?? r.body) as any;
    };
    let bulkBase = 0;
    /** k rows of people no earlier test created (names are unique across calls). */
    const bigRows = (k: number) => {
      const base = bulkBase;
      bulkBase += k;
      return Array.from({ length: k }, (_, i) => row({ full_name: `Bulk${letters(base + i)} Persona${letters((base + i) * 3 + 1)}`, relationship_id: randomUUID() }));
    };
    const startWorker = () => queue.registerWorker(QUEUE_NAMES.PEOPLE_IMPORT, async (job) => jobs.execute(job.id));
    const stopWorker = () => queue.unregisterWorker(QUEUE_NAMES.PEOPLE_IMPORT);
    /** Replace PeopleIngestionService.ingest for the duration of one test. */
    const withIngest = async (wrapper: (real: PeopleIngestionService['ingest'], calls: () => number) => PeopleIngestionService['ingest'], body: () => Promise<void>) => {
      const real = ingestion.ingest.bind(ingestion);
      let calls = 0;
      (ingestion as any).ingest = wrapper(real, () => ++calls);
      try {
        await body();
      } finally {
        (ingestion as any).ingest = real;
      }
    };

    it('returns 202 at once with a job reference; nothing is imported inline; the queue payload holds references only', async () => {
      stopWorker();
      try {
        const before = await snapshot();
        const email = `queued.${letters(++n)}@alpha-works.example`;
        const a = await accept([row({ full_name: 'Queued Personone', email, linkedin_url: `https://www.linkedin.com/in/queued-${letters(++n)}`, mobile: '+919811100099' })]);
        expect(a).toMatchObject({ status: 'QUEUED', dryRun: false, totalRows: 1 });
        expect(a.jobId).toMatch(/^[0-9a-f-]{36}$/);
        expect(await snapshot()).toEqual(before); // not processed in the request
        const view = (await get(a.jobId)).body.data;
        expect(view).toMatchObject({ status: 'QUEUED', processedRows: 0, imported: 0, totalRows: 1 });
        const r = await jobRow(a.jobId);
        expect(r).toMatchObject({ queueName: QUEUE_NAMES.PEOPLE_IMPORT, status: 'WAITING', attempts: 0 });
        expect(Object.keys(r.data as object).sort()).toEqual(['batchRef', 'contentSha256', 'dryRun', 'format', 'requestedBy', 'storageKey', 'totalRows']);
        expect(JSON.stringify(r.data)).not.toMatch(/Queued|Personone|alpha-works|linkedin|9811100099|postgres/);
        const key = (r.data as any).storageKey as string;
        expect(key).toMatch(/^people-imports\/[0-9a-f-]{36}\.csv$/);
        expect(storage.files.has(key)).toBe(true); // staged privately, not in the queue
        startWorker();
        const done = await finished(a.jobId);
        expect(done.data).toMatchObject({ status: 'COMPLETED', imported: 1, processedRows: 1, errorSummary: null });
        expect(storage.files.has(key)).toBe(false); // discarded once processed
      } finally {
        startWorker();
      }
    });

    it('reports progress while running, and the final counts when done', async () => {
      const total = IMPORT_SLICE_SIZE * 2 + 10;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      await withIngest(
        (real, next) => async (recs, opts) => {
          if (next() === 2) await gate; // hold the worker between the first and second slice
          return real(recs, opts);
        },
        async () => {
          const a = await accept(bigRows(total));
          let view: any;
          for (let i = 0; i < 2000; i++) {
            view = (await get(a.jobId)).body.data;
            if (view.processedRows >= IMPORT_SLICE_SIZE) break;
            await sleep(25);
          }
          expect(view).toMatchObject({ status: 'RUNNING', totalRows: total, processedRows: IMPORT_SLICE_SIZE, imported: IMPORT_SLICE_SIZE, quarantined: 0, failed: 0 });
          expect(JSON.stringify(view)).not.toMatch(/Bulk|Persona/);
          release();
          const done = await finished(a.jobId);
          expect(done.data).toMatchObject({ status: 'COMPLETED', totalRows: total, processedRows: total, imported: total, unchanged: 0 });
        },
      );
    }, 120_000);

    it('a retryable failure resumes from the checkpoint: no duplicate People, no double counting, and nothing but a code is recorded', async () => {
      const total = IMPORT_SLICE_SIZE + 20;
      const before = await snapshot();
      let failed = false;
      await withIngest(
        (real, next) => async (recs, opts) => {
          if (next() === 2 && !failed) {
            failed = true;
            throw new Error('SELECT * FROM secret_table; postgres://user:pw@db/x');
          }
          return real(recs, opts);
        },
        async () => {
          const a = await accept(bigRows(total));
          const done = await finished(a.jobId);
          expect(done.data).toMatchObject({ status: 'COMPLETED', totalRows: total, processedRows: total, imported: total, unchanged: 0, errorSummary: null });
          const r = await jobRow(a.jobId);
          expect(r).toMatchObject({ status: 'COMPLETED', attempts: 1, error: 'PEOPLE_IMPORT_ATTEMPT_FAILED' });
          expect(JSON.stringify([r.error, done.res.body])).not.toMatch(/secret_table|postgres|SELECT/);
          expect((await snapshot()).people).toBe(before.people + total);
        },
      );
    }, 120_000);

    it('a crash before the checkpoint is saved re-runs the slice idempotently: no duplicates', async () => {
      const total = IMPORT_SLICE_SIZE + 5;
      const before = await snapshot();
      const svc = jobs as any;
      const realWrite = svc.writeProgress.bind(jobs);
      let crashed = false;
      svc.writeProgress = async (...args: unknown[]) => {
        if (!crashed) {
          crashed = true;
          throw new Error('worker died after the slice was ingested, before its checkpoint');
        }
        return realWrite(...args);
      };
      try {
        const a = await accept(bigRows(total));
        const done = await finished(a.jobId);
        expect(done.data).toMatchObject({ status: 'COMPLETED', processedRows: total });
        expect(done.data.imported + done.data.unchanged).toBe(total);
        expect(done.data.unchanged).toBe(IMPORT_SLICE_SIZE); // the first slice was recognised, not re-created
        expect((await snapshot()).people).toBe(before.people + total);
      } finally {
        svc.writeProgress = realWrite;
      }
    }, 120_000);

    it('a terminal failure ends FAILED with a safe summary, imports nothing, and discards the staged file', async () => {
      const before = await snapshot();
      const filesBefore = storage.files.size;
      await withIngest(
        () => async () => {
          throw new Error('SELECT * FROM secret_table; postgres://user:pw@db/x');
        },
        async () => {
          const a = await accept([row({ full_name: 'Doomed Importer' })]);
          const done = await finished(a.jobId);
          expect(done.data).toMatchObject({ status: 'FAILED', errorSummary: 'The import could not be completed.', imported: 0, processedRows: 0, updated: 0, unchanged: 0, quarantined: 0 }); // failed before the first slice: zero progress
          const r = await jobRow(a.jobId);
          expect(r).toMatchObject({ status: 'FAILED', attempts: 3, error: 'PEOPLE_IMPORT_ATTEMPT_FAILED' });
          expect(JSON.stringify([done.res.body, r.error])).not.toMatch(/secret_table|postgres|SELECT|Doomed/);
          expect(await personByName('Doomed Importer')).toBeUndefined();
        },
      );
      expect((await snapshot()).people).toBe(before.people);
      expect(storage.files.size).toBe(filesBefore); // the file is not kept after the last attempt
    }, 120_000);

    it('a failure after the first slice keeps the progress already reached (FAILED, not zero), and re-importing the file completes it without duplicates', async () => {
      const total = IMPORT_SLICE_SIZE + 20;
      const rows = bigRows(total);
      const before = await snapshot();
      const filesBefore = storage.files.size;
      await withIngest(
        (real, next) => async (recs, opts) => {
          if (next() >= 2) throw new Error('SELECT * FROM secret_table; postgres://user:pw@db/x'); // slice 1 commits, every later slice fails
          return real(recs, opts);
        },
        async () => {
          const a = await accept(rows);
          const done = await finished(a.jobId);
          expect(done.data).toMatchObject({
            status: 'FAILED', totalRows: total, processedRows: IMPORT_SLICE_SIZE, imported: IMPORT_SLICE_SIZE, matched: IMPORT_SLICE_SIZE,
            updated: 0, unchanged: 0, quarantined: 0, failed: 0, errorSummary: 'The import could not be completed.',
          });
          expect(JSON.stringify(done.res.body)).not.toMatch(/secret_table|postgres|SELECT|Bulk/);
          const r = await jobRow(a.jobId);
          expect(r).toMatchObject({ status: 'FAILED', attempts: 3, error: 'PEOPLE_IMPORT_ATTEMPT_FAILED' });
          expect((r.result as any).final).toBe(true);
          expect((r.result as any).checkpoint).toBeUndefined(); // a finished job is never resumed from
          expect((await snapshot()).people).toBe(before.people + IMPORT_SLICE_SIZE); // exactly what the view reports was written
          expect(storage.files.size).toBe(filesBefore);
        },
      );
      // the same file again, with a healthy worker: slice 1 is recognised (unchanged), the rest is imported; nobody is duplicated
      const again = await run(rows);
      expect(again.data).toMatchObject({ status: 'COMPLETED', totalRows: total, processedRows: total, imported: 20, unchanged: IMPORT_SLICE_SIZE });
      expect((await snapshot()).people).toBe(before.people + total);
    }, 120_000);

    it('an unreadable payload is retried and then fails safely', async () => {
      stopWorker();
      try {
        const a = await accept([row({ full_name: 'Missing Payload' })]);
        storage.files.delete(((await jobRow(a.jobId)).data as any).storageKey);
        startWorker();
        const done = await finished(a.jobId);
        expect(done.data).toMatchObject({ status: 'FAILED', errorSummary: 'The import could not be completed.' });
        expect(await personByName('Missing Payload')).toBeUndefined();
      } finally {
        startWorker();
      }
    }, 60_000);

    it('a payload that is not the file that was accepted is refused, permanently and safely', async () => {
      stopWorker();
      try {
        const a = await accept([row({ full_name: 'Tampered Payload' })]);
        const key = ((await jobRow(a.jobId)).data as any).storageKey as string;
        storage.files.set(key, Buffer.from(toCsv([row({ full_name: 'Someone Else' })]), 'utf8'));
        startWorker();
        const done = await finished(a.jobId);
        expect(done.data).toMatchObject({ status: 'FAILED', errorSummary: 'The stored import file does not match the file that was accepted.' });
        expect(await personByName('Someone Else')).toBeUndefined();
        expect(await personByName('Tampered Payload')).toBeUndefined();
        expect(storage.files.has(key)).toBe(false);
      } finally {
        startWorker();
      }
    }, 60_000);

    it('redelivering a finished job is a no-op: nothing is processed or written, and the stored result is returned', async () => {
      const { data } = await run([row({ full_name: 'Redelivery Person' })]);
      expect(data.status).toBe('COMPLETED');
      const mid = await snapshot();
      const queueRowBefore = await jobRow(data.jobId);
      let ingestCalls = 0;
      await withIngest(
        (real, next) => async (recs, opts) => {
          next();
          ingestCalls++;
          return real(recs, opts);
        },
        async () => {
          const again = await jobs.execute(data.jobId);
          expect(again).toMatchObject({ final: true, state: 'COMPLETED', imported: 1 });
          await jobs.execute(data.jobId);
        },
      );
      expect(ingestCalls).toBe(0);
      expect(await snapshot()).toEqual(mid);
      expect((await jobRow(data.jobId)).result).toEqual(queueRowBefore.result);
    });

    it('a dry-run job writes no People, contacts, roles, observations, quarantine or companies, and discards its file', async () => {
      const before = await snapshot();
      const filesBefore = storage.files.size;
      const { data } = await run([row({ full_name: 'Dry Jobber', email: `dry.job.${letters(++n)}@alpha-works.example` }), row({ company_name: 'Nowhere Pvt Ltd', company_city: 'Pune', company_state: 'Maharashtra' })], { dryRun: true });
      expect(data).toMatchObject({ status: 'DRY_RUN', dryRun: true, valid: 1, unmatched: 1, imported: 0 });
      expect(await snapshot()).toEqual(before);
      expect(storage.files.size).toBe(filesBefore);
    });

    it('company isolation: a job never creates, modifies or publishes a company', async () => {
      const before = await snapshot();
      const companies = await db.select().from(schema.businesses);
      await run([row(), row({ company_name: 'Not A Company Pvt Ltd', company_city: 'Pune', company_state: 'Maharashtra' }), row({ company_name: 'Twin Works Pvt Ltd', company_city: 'Nagpur', company_state: 'Maharashtra' })]);
      const after = await snapshot();
      expect({ b: after.businesses, l: after.locations, i: after.identifiers }).toEqual({ b: before.businesses, l: before.locations, i: before.identifiers });
      expect(await db.select().from(schema.businesses)).toEqual(companies); // every company row is byte-for-byte unchanged
    });

    it('the status endpoint is admin-only, validates the id, and sees only People import jobs', async () => {
      const { data } = await run([row()], { dryRun: true });
      expect((await get(data.jobId, null)).status).toBe(401);
      expect((await get(data.jobId, tokens.customer)).status).toBe(403);
      expect((await get(data.jobId, tokens.dataManager)).status).toBe(403);
      expect((await get(data.jobId, tokens.superAdmin)).status).toBe(200);
      expect((await get(randomUUID())).status).toBe(404);
      expect((await get('not-a-uuid')).status).toBe(400);
      const [other] = await db.insert(queueJobs).values({ queueName: 'some-other-queue', jobName: 'x', data: { secret: 'value' }, status: 'COMPLETED' }).returning();
      const res = await get(other.id);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('value');
    });

    it('import history lists People import jobs newest first, paginated, admin-only, with the same safe view and nothing else', async () => {
      const a = (await run([row({ full_name: 'History Onea' })], { dryRun: true })).data;
      await sleep(15);
      const b = (await run([row({ full_name: 'History Twob' })])).data;
      const list = (qs = '', token: string | null = tokens.admin) => {
        const r = request(app.getHttpServer()).get(`${URL}${qs}`);
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
      };
      expect((await list('', null)).status).toBe(401);
      expect((await list('', tokens.customer)).status).toBe(403);
      expect((await list('', tokens.dataManager)).status).toBe(403);
      const res = await list('?page=1&limit=2');
      expect(res.status).toBe(200);
      expect(res.body.data.map((j: any) => j.jobId).slice(0, 2)).toEqual([b.jobId, a.jobId]); // newest first
      expect(res.body.pagination).toMatchObject({ page: 1, limit: 2 });
      expect(res.body.pagination.totalItems).toBe((await db.select({ n: sql<number>`count(*)::int` }).from(queueJobs).where(eq(queueJobs.queueName, QUEUE_NAMES.PEOPLE_IMPORT)))[0].n); // other queues are not history
      for (const item of res.body.data) expect(Object.keys(item).sort()).toEqual(Object.keys(b).sort()); // exactly the single-job view
      expect(JSON.stringify(res.body)).not.toMatch(/History|people-imports|storageKey|contentSha256|requestedBy|@alpha-works|select |postgres/i);
      const second = await list('?page=2&limit=1');
      expect(second.body.data).toHaveLength(1);
      expect(second.body.data[0].jobId).toBe(a.jobId);
      const beyond = await list('?page=9999&limit=20'); // empty history page
      expect(beyond.status).toBe(200);
      expect(beyond.body.data).toEqual([]);
      expect(beyond.body.pagination.totalItems).toBeGreaterThan(0);
      expect((await list('?limit=1000')).status).toBe(400);
      expect((await list('?page=0')).status).toBe(400);
      expect(res.body.data.every((j: any) => j.jobId !== undefined && j.status !== undefined)).toBe(true);
    });

    it('storage and queue outages are a safe 503 that leaves nothing behind', async () => {
      const jobsBefore = await count(queueJobs);
      storage.failUpload = true;
      const down = await post({ ...csv([row()]) });
      storage.failUpload = false;
      expect(down.status).toBe(503);
      expect(JSON.stringify(down.body)).toContain('IMPORT_STORAGE_UNAVAILABLE');
      expect(JSON.stringify(down.body)).not.toMatch(/secret-endpoint|storage down/);
      expect(await count(queueJobs)).toBe(jobsBefore);

      const filesBefore = storage.files.size;
      const realAdd = queue.addJob.bind(queue);
      (queue as any).addJob = async () => {
        throw new Error('queue down: db-host.internal');
      };
      try {
        const res = await post({ ...csv([row()]) });
        expect(res.status).toBe(503);
        expect(JSON.stringify(res.body)).toContain('IMPORT_QUEUE_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/db-host|queue down/);
        expect(storage.files.size).toBe(filesBefore); // the staged file was removed again
      } finally {
        (queue as any).addJob = realAdd;
      }
    });

    it('validation still happens before anything is staged or queued', async () => {
      const jobsBefore = await count(queueJobs);
      const filesBefore = storage.files.size;
      expect((await post({ format: 'csv', content: toCsv([row({ export_version: '2' })]) })).status).toBe(400);
      expect((await post({ format: 'json', content: '{' })).status).toBe(400);
      expect(await count(queueJobs)).toBe(jobsBefore);
      expect(storage.files.size).toBe(filesBefore);
    });
  });

  // ------------------------------------------------------------------------------------------------ body limit
  describe('request limits', () => {
    it('the route-scoped body limit applies only with a token, and only to this route', async () => {
      const big = 'x'.repeat(200_000); // over the default 100 kB limit
      const anon = await request(app.getHttpServer()).post(URL).send({ format: 'csv', content: big });
      expect(anon.status).toBe(413); // no token: the default 100 kB limit applies, so it is refused before anything runs
      const ok = await post({ format: 'csv', content: big }); // admin: passes the body parser, then fails file validation
      expect(ok.status).toBe(400);
      const other = await request(app.getHttpServer()).post(`${PREFIX}/admin/import/operations/batches/00000000-0000-0000-0000-000000000000/reprocess-people`).set('Authorization', `Bearer ${tokens.admin}`).send({ pad: big });
      expect(other.status).toBe(413); // every other route keeps the default limit
    });
  });
});
