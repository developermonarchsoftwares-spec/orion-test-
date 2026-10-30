import { DynamicModule, Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { UserRole } from '@orion/shared';
import { eq, sql } from 'drizzle-orm';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import * as path from 'path';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { applyUploadBodyLimit } from '../../../common/http/upload-body-limit';
import { TransformInterceptor } from '../../../common/interceptors/transform.interceptor';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { DRIZZLE_DATABASE } from '../../../database/database.constants';
import { DrizzleDb } from '../../../database/database.provider';
import { TransactionService } from '../../../database/transaction.service';
import * as schema from '../../../database/schema';
import { BusinessModule } from '../../business/business.module';
import { PEOPLE_INGESTION_SERVICE } from '../../people/ingestion/ingestion.types';
import { PeopleIngestionService } from '../../people/ingestion/people-ingestion.service';
import { ObservationService } from '../../people/observations/observation.service';
import { PeoplePublishingService } from '../../people/people-publishing.service';
import { PeopleWriteService } from '../../people/people-write.service';
import { SourceRegistryService } from '../../people/sources/source-registry.service';
import { expectLedgerConsistent } from '../../people/__tests__/ledger-invariants';
import { createTestDb, seedUser } from '../../people/__tests__/pglite-test-db';
import { QueueService } from '../../queue/queue.service';
import { AdminImportController } from '../controllers/admin-import.controller';
import { ImportOperationsController } from '../controllers/import-operations.controller';
import { ImportPeopleBridge } from '../people/import-people.bridge';
import { DuplicateRepository, PublishQueueRepository, ReviewQueueRepository } from '../repositories/duplicate-review.repositories';
import { ImportBatchRepository, ImportRecordRepository, ValidationLogRepository } from '../repositories/import.repositories';
import { AdminImportService } from '../services/admin-import.service';
import { DuplicateDetectionService } from '../services/duplicate-detection.service';
import { ImportOperationsService } from '../services/import-operations.service';
import { ImportPipelineService } from '../services/import-pipeline.service';
import { NormalizationService } from '../services/normalization.service';
import { PublishingService } from '../services/publishing.service';
import { SourceTrustService } from '../services/source-trust.service';
import { withApprovedSource } from './approved-source.helper';
import { ValidationService } from '../services/validation.service';

const SECRET = 'import-ops-secret';
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

const PREFIX = '/api/v1';
const OPS = `${PREFIX}/admin/import/operations`;

describe('Upload batch operations (Phase 6.13)', () => {
  let app: INestApplication;
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let admin: AdminImportService;
  let n = 0;
  let tokens: { admin: string; superAdmin: string; dataManager: string; customer: string };

  const tokenFor = (id: string, role: string) => jwt.sign({ sub: id, email: `${id}@t.dev`, role }, SECRET);
  const GET = (url: string, t?: string) => {
    const r = request(app.getHttpServer()).get(url);
    return t ? r.set('Authorization', `Bearer ${t}`) : r;
  };
  const POST = (url: string, t?: string, body: object = {}) => {
    const r = request(app.getHttpServer()).post(url);
    return (t ? r.set('Authorization', `Bearer ${t}`) : r).send(body);
  };
  const row = (extra: Record<string, unknown> = {}) => ({
    business_name: `${['Zephyr', 'Quartz', 'Nimbus', 'Onyx', 'Cobalt', 'Saffron'][n % 6]}${++n}${Math.random().toString(36).slice(2, 5)} Traders`,
    city: `City${n}x${Math.random().toString(36).slice(2, 6)}`,
    state: 'Tamil Nadu', pincode: '641001', address_line1: '1 Test Street', email: 'info@company.example', phone: '+91 422 255 0100',
    ...extra,
  });
  const L = () => Math.random().toString(36).replace(/[0-9.]/g, '').slice(0, 5) || 'abcde';
  const data = async (qs = '', t = tokens.admin) => (await GET(`${OPS}/batches${qs}`, t).expect(200)).body;
  const detail = async (id: string, qs = '', t = tokens.admin) => (await GET(`${OPS}/batches/${id}${qs}`, t).expect(200)).body.data;

  const batches: Record<string, { id: string; rows: any[]; names: string[] }> = {};

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    close = () => t.client.close();
    const module = await Test.createTestingModule({
      imports: [PassportModule, TestDbModule.forDb(db), BusinessModule],
      controllers: [ImportOperationsController, AdminImportController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        TestJwtStrategy, JwtAuthGuard, RolesGuard, Reflector, AuditLogService,
        ImportBatchRepository, ImportRecordRepository, ValidationLogRepository, DuplicateRepository, ReviewQueueRepository, PublishQueueRepository,
        NormalizationService, ValidationService, DuplicateDetectionService, PublishingService, SourceTrustService, ImportPipelineService, AdminImportService,
        ImportOperationsService, ImportPeopleBridge,
        PeopleWriteService, PeopleIngestionService, PeoplePublishingService, SourceRegistryService, ObservationService,
        { provide: PEOPLE_INGESTION_SERVICE, useExisting: PeopleIngestionService },
        { provide: QueueService, useValue: { addJob: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix(PREFIX.slice(1));
    applyUploadBodyLimit(app, PREFIX); // exactly what main.ts does
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // listen once so parallel supertest requests share one live server (otherwise each starts it and the first to finish closes it: ECONNRESET)
    await app.listen(0, '127.0.0.1');
    admin = module.get(AdminImportService);
    await withApprovedSource(admin, db); // Phase 15: stands in for an approved source with automatic publication

    const [a, s, d, c] = await Promise.all([seedUser(db, 'ops.admin@orion.test', undefined, 'ADMIN'), seedUser(db, 'ops.super@orion.test', undefined, 'SUPER_ADMIN'), seedUser(db, 'ops.dm@orion.test', undefined, 'DATA_MANAGER'), seedUser(db, 'ops.customer@orion.test')]);
    tokens = { admin: tokenFor(a.id, UserRole.ADMIN), superAdmin: tokenFor(s.id, UserRole.SUPER_ADMIN), dataManager: tokenFor(d.id, UserRole.DATA_MANAGER), customer: tokenFor(c.id, UserRole.USER) };

    // B1: clean, two companies with people
    const n1 = [`Alan ${L()}van`, `Bela ${L()}van`];
    const rows1 = [row({ contact_person: n1[0], contact_title: 'CEO', person_email: `a.${L()}@ops-co.co.in` }), row({ contact_person: n1[1], contact_title: 'Director', person_phone: '0422 255 0611' })];
    const r1 = await admin.submitBatch({ filename: 'clean-upload.csv', rows: rows1 });
    batches.clean = { id: r1.batchId, rows: rows1, names: n1 };
    // B2: mixed outcomes: good, invalid person, missing title, failing company row (no name / no city)
    const n2 = [`Cara ${L()}van`, `Dev ${L()}van`];
    const rows2 = [
      row({ contact_person: n2[0], contact_title: 'CEO', person_2_name: n2[1] }), // person 2 has no title
      row({ business_name: '', city: '' }), // company row that cannot be imported
      row({ contact_person: 'X', contact_title: 'CFO' }), // unusable person name
    ];
    batches.mixed = { id: (await admin.submitBatch({ filename: 'mixed-upload.csv', rows: rows2 })).batchId, rows: rows2, names: n2 };
    // B3: the identical file again -> duplicates
    batches.dup = { id: (await admin.submitBatch({ filename: 'clean-upload.csv', rows: rows1 })).batchId, rows: rows1, names: n1 };
    // B4: People layer unavailable during upload (source disabled) -> errored People results, company still imported
    const n4 = [`Esha ${L()}van`];
    const rows4 = [row({ contact_person: n4[0], contact_title: 'Managing Director', person_email: `e.${L()}@ops-co.co.in` })];
    await db.execute(sql`UPDATE people_sources SET enabled = false WHERE key = 'company-upload'`);
    try {
      batches.errored = { id: (await admin.submitBatch({ filename: 'errored-upload.csv', rows: rows4 })).batchId, rows: rows4, names: n4 };
    } finally {
      await db.execute(sql`UPDATE people_sources SET enabled = true WHERE key = 'company-upload'`);
    }
  }, 120_000);

  afterAll(async () => {
    await expectLedgerConsistent(db);
    await app?.close();
    await close?.();
  });

  describe('RBAC', () => {
    it('admin and super admin may use operations; data managers, customers and anonymous callers may not', async () => {
      const id = batches.clean.id;
      for (const t of [tokens.admin, tokens.superAdmin]) {
        await GET(`${OPS}/batches`, t).expect(200);
        await GET(`${OPS}/batches/${id}`, t).expect(200);
        await POST(`${OPS}/batches/${id}/reprocess-people`, t).expect(200);
      }
      for (const [t, code] of [[tokens.dataManager, 403], [tokens.customer, 403], [undefined, 401]] as const) {
        await GET(`${OPS}/batches`, t).expect(code);
        await GET(`${OPS}/batches/${id}`, t).expect(code);
        await POST(`${OPS}/batches/${id}/reprocess-people`, t).expect(code);
      }
      await GET(`${OPS}/batches/not-a-uuid`, tokens.admin).expect(400);
      await GET(`${OPS}/batches/00000000-0000-4000-8000-0000000000aa`, tokens.admin).expect(404);
      await POST(`${OPS}/batches/00000000-0000-4000-8000-0000000000aa/reprocess-people`, tokens.admin).expect(404);
    });

    it('no customer-facing code knows operations', () => {
      const dir = path.resolve(__dirname, '../..');
      for (const f of ['people/people.service.ts', 'people/people.controller.ts', 'people/people-export.service.ts', 'people/people-search.service.ts']) {
        expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/import-operations|ImportOperations/);
      }
    });
  });

  describe('list: status, source, row counts and People outcome', () => {
    it('shows each batch with the counts of the existing batch record and the People report', async () => {
      const all = (await data('?limit=100')).data as any[];
      const byId = new Map(all.map((b) => [b.id, b]));
      const clean = byId.get(batches.clean.id);
      expect(clean).toMatchObject({ filename: 'clean-upload.csv', status: 'COMPLETED', outcome: 'COMPLETED', hasIssues: false, source: { type: 'MANUAL_IMPORT' } });
      expect(clean.rows).toMatchObject({ total: 2, processed: 2, accepted: 2, rejected: 0, duplicate: 0 });
      expect(clean.people).toEqual({ received: 2, created: 2, updated: 0, skipped: 0, accepted: 2, quarantined: 0, rejected: 0, errors: 0 });
      expect(clean.rows.byStatus).toEqual({ PUBLISHED: 2 });
      expect(clean.createdAt).toBeTruthy();

      const mixed = byId.get(batches.mixed.id);
      expect(mixed).toMatchObject({ hasIssues: true, outcome: 'COMPLETED_WITH_ISSUES' });
      expect(mixed.rows).toMatchObject({ total: 3, rejected: 1 });
      expect(mixed.people).toMatchObject({ received: 3, created: 1, rejected: 2, errors: 0 });

      const dup = byId.get(batches.dup.id);
      expect(dup.rows).toMatchObject({ total: 2, duplicate: 2, accepted: 0 });
      expect(dup.people === null || dup.people.received === 0).toBe(true);

      const errored = byId.get(batches.errored.id);
      expect(errored.people).toMatchObject({ received: 1, errors: 1, created: 0 });
      expect(errored).toMatchObject({ status: 'COMPLETED', hasIssues: true });
    });

    it('is deterministic: newest first, ties by id, pages never overlap or skip, totals consistent', async () => {
      const full = (await data('?limit=100')).data.map((b: any) => b.id);
      const again = (await data('?limit=100')).data.map((b: any) => b.id);
      expect(again).toEqual(full);
      const seen: string[] = [];
      for (let page = 1; ; page++) {
        const r = await data(`?limit=2&page=${page}`);
        expect(r.pagination).toMatchObject({ page, limit: 2, totalItems: full.length });
        seen.push(...r.data.map((b: any) => b.id));
        if (page >= r.pagination.totalPages) break;
      }
      expect(seen).toEqual(full);
      const times = (await data('?limit=100')).data.map((b: any) => new Date(b.createdAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      await GET(`${OPS}/batches?limit=1000`, tokens.admin).expect(400);
      await GET(`${OPS}/batches?status=BOGUS`, tokens.admin).expect(400);
      await GET(`${OPS}/batches?unknown=1`, tokens.admin).expect(400);
    });

    it('filters by status, date, file name and issues', async () => {
      expect((await data('?status=COMPLETED&limit=100')).data.every((b: any) => b.status === 'COMPLETED')).toBe(true);
      expect((await data('?status=FAILED&limit=100')).data.every((b: any) => b.status === 'FAILED')).toBe(true);
      expect((await data('?q=mixed-upload')).data.map((b: any) => b.id)).toEqual([batches.mixed.id]);
      expect((await data('?q=%25')).data).toEqual([]); // wildcards are literal
      const issues = (await data('?hasIssues=true&limit=100')).data.map((b: any) => b.id);
      expect(issues).toEqual(expect.arrayContaining([batches.mixed.id, batches.errored.id]));
      expect(issues).not.toContain(batches.clean.id);
      expect((await data('?hasIssues=false&limit=100')).data.map((b: any) => b.id)).toContain(batches.clean.id);
      expect((await data('?from=2100-01-01T00:00:00Z')).data).toEqual([]);
      expect((await data('?to=2000-01-01T00:00:00Z')).data).toEqual([]);
      expect((await data('?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z&limit=100')).pagination.totalItems).toBeGreaterThanOrEqual(4);
      expect((await data('?sourceId=00000000-0000-4000-8000-0000000000aa')).data).toEqual([]);
    });
  });

  describe('upload integrity: every row is stored and the batch is fully summarised', () => {
    it('stores one import_record per row, a non-null people_summary and a passing integrity check (valid, invalid and duplicate rows)', async () => {
      const dupe = row();
      const rows = [row(), row(), row(), row({ business_name: '' }), dupe, { ...dupe }];
      const r = await admin.submitBatch({ filename: 'integrity.csv', rows, autoPublish: true });
      const stored = await db.select({ n: sql<number>`count(*)::int` }).from(schema.importRecords).where(eq(schema.importRecords.batchId, r.batchId));
      expect(stored[0].n).toBe(rows.length);
      expect(r.integrity).toEqual({ ok: true, issues: [] });
      expect(r.publishedCount + r.duplicateCount + r.failedCount).toBe(rows.length);
      const [b] = await db.select().from(schema.importBatches).where(eq(schema.importBatches.id, r.batchId));
      expect(b.peopleSummary).toMatchObject({ received: 0, errors: 0 });
      expect(b.errorMessage).toBeNull();
      const d = await detail(r.batchId);
      expect(d.records).toHaveLength(rows.length);
      expect(d.records.some((x: any) => x.status === 'FAILED' && x.validationFailures.length > 0)).toBe(true);
    });
  });

  describe('detail: row-level outcome and reason codes', () => {
    it('shows each row with status, duplicate flag, publish state, validation failures and per-person outcome codes', async () => {
      const d = await detail(batches.mixed.id);
      expect(d.batch).toMatchObject({ id: batches.mixed.id, outcome: 'COMPLETED_WITH_ISSUES' });
      expect(d.records.map((r: any) => r.rowNumber)).toEqual([1, 2, 3]);
      const [r1, r2, r3] = d.records;
      expect(r1).toMatchObject({ status: 'PUBLISHED', isPublished: true, publish: { status: 'PUBLISHED' } });
      expect(r1.businessId).toBeTruthy();
      expect(r1.people.counts).toMatchObject({ received: 2, created: 1, rejected: 1 });
      expect(r1.people.outcomes.map((o: any) => o.outcome).sort()).toEqual(['CREATED', 'QUARANTINED']);
      expect(r1.people.outcomes.flatMap((o: any) => o.codes).length).toBeGreaterThan(0);
      expect(r2.status).toBe('FAILED');
      expect(r2.validationFailures.length).toBeGreaterThan(0);
      expect(Object.keys(r2.validationFailures[0]).sort()).toEqual(['field', 'rule', 'severity']);
      expect(r2.people).toBeNull();
      expect(r3.people.outcomes[0]).toMatchObject({ outcome: 'QUARANTINED' });
      // totals by reason code
      expect(d.reasonCodes.people.length).toBeGreaterThan(0);
      expect(d.reasonCodes.people.every((c: any) => typeof c.code === 'string' && c.count > 0)).toBe(true);
      expect(d.reasonCodes.validation.length).toBeGreaterThan(0);
    });

    it('duplicate and errored batches are explained, and records paginate / filter', async () => {
      const dup = await detail(batches.dup.id);
      expect(dup.records.every((r: any) => r.status === 'FLAGGED_DUPLICATE' && r.isDuplicate === true && r.isPublished === false)).toBe(true);
      const err = await detail(batches.errored.id);
      expect(err.records[0].status).toBe('PUBLISHED');
      expect(err.records[0].people).toMatchObject({ attempted: true, failed: true, counts: { errors: 1, received: 1 } });
      const p1 = await detail(batches.mixed.id, '?limit=2&page=1');
      const p2 = await detail(batches.mixed.id, '?limit=2&page=2');
      expect([...p1.records, ...p2.records].map((r: any) => r.rowNumber)).toEqual([1, 2, 3]);
      expect(p1.pagination).toMatchObject({ totalItems: 3, totalPages: 2 });
      expect((await detail(batches.mixed.id, '?status=FAILED')).records.map((r: any) => r.rowNumber)).toEqual([2]);
      await GET(`${OPS}/batches/${batches.mixed.id}?status=BOGUS`, tokens.admin).expect(400);
      await GET(`${OPS}/batches/${batches.mixed.id}?limit=500`, tokens.admin).expect(400);
    });
  });

  describe('no leakage', () => {
    it('never returns raw payloads, personal data, mapping / options / file keys, source configuration or error text', async () => {
      const bodies = [JSON.stringify(await data('?limit=100'))];
      for (const b of Object.values(batches)) bodies.push(JSON.stringify(await detail(b.id)));
      const dump = bodies.join('\n');
      for (const b of Object.values(batches)) for (const name of b.names) expect(dump).not.toContain(name);
      expect(dump).not.toMatch(/@ops-co|@company\.example|\+91 422|0422 255|linkedin|person_email|contact_person|contact_title|address_line1|1 Test Street/i);
      expect(dump).not.toMatch(/rawPayload|raw_payload|normalizedPayload|mappingConfig|mapping_config|fileKey|file_key|imports\/|"options"|"config"|errorMessage|errorDetails|createdById|stack|select |relation "/i);
      for (const item of (await data('?limit=100')).data) {
        expect(Object.keys(item).sort()).toEqual(['completedAt', 'createdAt', 'fileSize', 'filename', 'hasIssues', 'id', 'outcome', 'people', 'rows', 'source', 'startedAt', 'status']);
        expect(Object.keys(item.source).sort()).toEqual(['name', 'type']);
      }
      const rec = (await detail(batches.mixed.id)).records[0];
      expect(Object.keys(rec).sort()).toEqual(['businessId', 'companyName', 'id', 'isDuplicate', 'isPublished', 'people', 'publish', 'rowNumber', 'status', 'validationFailures']);
    });

    it('reading changes nothing', async () => {
      const snap = async () => {
        const out: Record<string, unknown> = {};
        for (const t of ['import_batches', 'import_records', 'people', 'company_people', 'person_contacts', 'people_observations', 'audit_logs', 'businesses']) {
          out[t] = rowsOf(await db.execute(sql.raw(`SELECT count(*)::int AS n, max(${t === 'people_observations' || t === 'audit_logs' ? 'created_at' : 'updated_at'})::text AS m FROM ${t}`)))[0];
        }
        return out;
      };
      const before = await snap();
      await data('?limit=100');
      for (const b of Object.values(batches)) await detail(b.id);
      expect(await snap()).toEqual(before);
    });
  });

  describe('safe reprocessing (existing ingestion only)', () => {
    it('re-runs the People stage of errored rows once the cause is fixed: no duplicates, summary stays exact, quarantined/rejected rows are untouched, repeat is a no-op, audited', async () => {
      const peopleBefore = (await db.select().from(schema.people)).length;
      const mixedBefore = JSON.stringify(await detail(batches.mixed.id));
      const out = (await POST(`${OPS}/batches/${batches.errored.id}/reprocess-people`, tokens.admin).expect(200)).body.data;
      expect(out).toMatchObject({ batchId: batches.errored.id, candidates: 1, reprocessed: 1, stillFailing: 0, skippedNoCompany: 0, moreRemaining: false });
      expect((await db.select().from(schema.people)).length).toBe(peopleBefore + 1); // the person arrived, once, as DRAFT
      const [pp] = await db.select().from(schema.people).where(eq(schema.people.normalizedName, batches.errored.names[0].toLowerCase()));
      expect(pp).toMatchObject({ dataStatus: 'DRAFT', verificationStatus: 'UNVERIFIED' });
      const d = await detail(batches.errored.id);
      expect(d.records[0].people).toMatchObject({ failed: false, counts: { created: 1, errors: 0, received: 1 } });
      expect(d.batch.people).toMatchObject({ received: 1, created: 1, errors: 0 }); // recomputed, not double counted
      expect(d.batch.hasIssues).toBe(false);
      const sumOfRecords = d.records.reduce((acc: number, r: any) => acc + r.people.counts.received, 0);
      expect(d.batch.people.received).toBe(sumOfRecords);

      const again = (await POST(`${OPS}/batches/${batches.errored.id}/reprocess-people`, tokens.admin).expect(200)).body.data;
      expect(again).toMatchObject({ candidates: 0, reprocessed: 0 });
      expect((await db.select().from(schema.people)).length).toBe(peopleBefore + 1);
      expect(JSON.stringify(await detail(batches.mixed.id))).toBe(mixedBefore); // rejected / quarantined decisions are not retried here

      const audit = (await db.select().from(schema.auditLogs)).filter((a) => a.action === 'IMPORT_PEOPLE_REPROCESSED' && a.entityId === batches.errored.id);
      expect(audit.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(audit[0].newValues)).not.toMatch(new RegExp(batches.errored.names[0]));
    });

    it('has no ingestion logic of its own: it calls the existing bridge and touches no People table', () => {
      const text = fs.readFileSync(path.resolve(__dirname, '../services/import-operations.service.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(text).toMatch(/bridge\.ingestForPublishedRecord/);
      expect(text).not.toMatch(/schema\.(people|companyPeople|personContacts|peopleEvidence|peopleObservations)|PeopleWriteService|PeopleIngestionService|PeoplePublishingService/);
      expect(text).not.toMatch(/fetch\(|axios|https?:\/\//);
    });
  });

  describe('route-scoped upload body limit', () => {
    const rowsOfSize = (rows: number, cell: number) => Array.from({ length: rows }, () => ({ a: 'z'.repeat(cell) }));

    it('the two upload routes accept a body far above the 100 kB default (authenticated); other routes and anonymous callers keep the default', async () => {
      const body = { filename: 'big.csv', rows: rowsOfSize(300, 5001) }; // ~1.5 MB, structurally invalid on purpose: it must reach the validator
      const sent = JSON.stringify(body).length;
      expect(sent).toBeGreaterThan(1_000_000);
      for (const route of ['submit', 'preview']) {
        const res = await POST(`${PREFIX}/admin/import/${route}`, tokens.admin, body);
        expect(res.status).toBe(400); // parsed, then refused by the validator (not 413)
        expect(res.body.errorCode).toBe('UPLOAD_INVALID');
      }
      expect((await POST(`${OPS}/batches/${batches.clean.id}/reprocess-people`, tokens.admin, body)).status).toBe(413); // default limit elsewhere
      expect((await POST(`${PREFIX}/admin/import/publish-batch/${batches.clean.id}`, tokens.admin, body)).status).toBe(413);
      expect((await POST(`${PREFIX}/admin/import/submit`, undefined, body)).status).toBe(413); // no token: no large limit
      const small = await POST(`${PREFIX}/admin/import/submit`, tokens.customer, { filename: 'x.csv', rows: [{ a: 'b' }] });
      expect(small.status).toBe(403); // a customer is still refused by the guard
    });

    it('there is still a ceiling: a body above the upload maximum is refused with 413, and the global limit was not raised', async () => {
      const huge = { filename: 'huge.csv', rows: rowsOfSize(4400, 5000) }; // > 20 MB
      expect(JSON.stringify(huge).length).toBeGreaterThan(20 * 1024 * 1024);
      expect((await POST(`${PREFIX}/admin/import/submit`, tokens.admin, huge)).status).toBe(413);
      const mainTs = fs.readFileSync(path.resolve(__dirname, '../../../main.ts'), 'utf8');
      expect(mainTs).toMatch(/applyUploadBodyLimit\(app, apiPrefix\)/);
      expect(mainTs).not.toMatch(/json\(\{\s*limit/); // no global JSON limit override
    }, 60_000);
  });
});

const rowsOf = (res: any): any[] => (res?.rows ?? res) as any[];
