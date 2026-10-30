import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { DynamicModule, Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { UserRole } from '@orion/shared';
import { eq, sql } from 'drizzle-orm';
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
import { TransactionService } from '../../../database/transaction.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import { QueueService } from '../../queue/queue.service';
import { StorageService } from '../../storage/storage.service';
import { PeopleBundleImportController } from '../ingestion/bundle/people-bundle-import.controller';
import { PeopleBundleImportService } from '../ingestion/bundle/people-bundle-import.service';
import { PeopleExportImportController } from '../ingestion/people-export-import.controller';
import { PeopleExportImportService } from '../ingestion/people-export-import.service';
import { PeopleImportJobService } from '../ingestion/people-import-job.service';
import { PeopleIngestionService } from '../ingestion/people-ingestion.service';
import { ObservationService } from '../observations/observation.service';
import { PeoplePublishingService } from '../people-publishing.service';
import { PeopleWriteService } from '../people-write.service';
import { PeopleQuarantineService } from '../review/people-quarantine.service';
import { PeopleReviewController } from '../review/people-review.controller';
import { PeopleReviewService } from '../review/people-review.service';
import { PeopleTriageService } from '../review/people-triage.service';
import { SourceRegistryService } from '../sources/source-registry.service';
import { PeopleVerificationController } from '../verification/people-verification.controller';
import { PeopleVerificationService } from '../verification/people-verification.service';
import { IBundleFx, makeBundle, packBundle, toBase64 } from './people-bundle-fixtures';
import { expectLedgerConsistent } from './ledger-invariants';
import { exportRow, ExportRowInput, toCsv } from './people-export-fixtures';
import { createTestDb, JOURNALED_MIGRATIONS, seedBusiness, seedUser } from './pglite-test-db';

/**
 * Phase 9D: importing a People Pipeline split-export ZIP through the admin API, end to end on an in-memory database with the real
 * controllers, queue, job service, importer and ingestion. The bundle layer only orchestrates: every part is an ordinary People
 * import job, so these tests concentrate on what the orchestration adds (validation before anything is queued, ordering, the
 * aggregate result and its reconciliation, failure and retry) and on what must NOT change (record-level idempotency, review state,
 * verification, companies).
 */
const SECRET = 'people-bundle-secret';
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
class FakeStorage {
  files = new Map<string, Buffer>();
  uploadsAllowed = Infinity;
  async uploadFile(o: { key: string; buffer: Buffer }) {
    if (this.uploadsAllowed-- <= 0) throw new Error('storage down: secret-endpoint.example');
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
const poolOver = (client: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) => {
  const query = async (text: string, params?: unknown[]) => {
    const r = await client.query(text, params);
    return { rows: r.rows, rowCount: r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => undefined }) };
};

const PREFIX = '/api/v1';
const IMPORT = `${PREFIX}/admin/people/import`;
const BUNDLE = `${IMPORT}/bundle`;
const REVIEW = `${PREFIX}/internal/people-review`;
const VERIFY = `${PREFIX}/internal/people-verification`;
const REGISTRY = { sourceType: 'GOVERNMENT_REGISTRY', evidenceType: 'REGISTRY_FILING', sourceReference: 'MCA filing SRN-778' };
const nameOf = (slug: string) => `${slug} Pvt Ltd`;
const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d+Z$/, '+00:00');

describe('People Pipeline bundle import (Phase 9D): POST /admin/people/import/bundle', () => {
  let app: INestApplication;
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let ingestion: PeopleIngestionService;
  let jobsSvc: PeopleImportJobService;
  let queue: QueueService;
  const storage = new FakeStorage();
  let tokens: { admin: string; customer: string; dataManager: string };
  let n = 0;
  const A = { slug: 'bundle-alpha', city: 'Pune', state: 'Maharashtra' };
  const B = { slug: 'bundle-bravo', city: 'Chennai', state: 'Tamil Nadu' };
  let adminId = '';

  const tokenFor = (id: string, role: string) => jwt.sign({ sub: id, email: `${id}@t.dev`, role }, SECRET);
  const as = (r: request.Test, token: string | null = tokens.admin) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
  const http = () => request(app.getHttpServer());
  const letters = (k: number) => {
    let s = '';
    let v = k + 1;
    while (v > 0) {
      s = String.fromCharCode(97 + ((v - 1) % 26)) + s;
      v = Math.floor((v - 1) / 26);
    }
    return s;
  };
  const pname = () => `Quill${letters(++n)} Kapoorv${letters(n * 7)}`;
  const row = (over: Partial<ExportRowInput> = {}): ExportRowInput =>
    exportRow({ company_name: nameOf(A.slug), company_city: A.city, company_state: A.state, full_name: pname(), job_title: 'Head of Procurement', relationship_id: randomUUID(), ...over });
  const rowsN = (k: number) => Array.from({ length: k }, () => row());

  const validateRaw = (zip: Buffer, token: string | null = tokens.admin) => as(http().post(`${BUNDLE}/validate`), token).send({ content: toBase64(zip) });
  const postRaw = (zip: Buffer, extra: object = {}, token: string | null = tokens.admin) => as(http().post(BUNDLE), token).send({ content: toBase64(zip), ...extra });
  const getBundle = (id: string, token: string | null = tokens.admin) => as(http().get(`${BUNDLE}/${id}`), token);
  const data = (res: request.Response) => res.body.data ?? res.body;
  const finishedBundle = async (id: string, timeoutMs = 90_000) => {
    const started = Date.now();
    for (;;) {
      const res = await getBundle(id);
      const view = data(res);
      if (res.status !== 200 || !['QUEUED', 'RUNNING'].includes(view.status)) return view as any;
      if (Date.now() - started > timeoutMs) throw new Error(`bundle ${id} did not finish: ${view.status}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const importBundle = async (b: IBundleFx, extra: object = {}) => {
    const res = await postRaw(packBundle(b), extra);
    expect(res.status).toBe(202);
    return { accepted: data(res) as any, view: (await finishedBundle(data(res).bundleImportId)) as any };
  };
  const count = async (table: any) => (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n as number;
  const snapshot = async () => ({
    businesses: await count(schema.businesses), identifiers: await count(schema.businessIdentifiers),
    people: await count(schema.people), roles: await count(schema.companyPeople), contacts: await count(schema.personContacts),
    evidence: await count(schema.peopleEvidence), quarantine: await count(schema.peopleIngestionQuarantine),
  });
  const personByName = async (name: string) => (await db.select().from(schema.people).where(eq(schema.people.normalizedName, name.toLowerCase())))[0];
  const rolesOf = (personId: string) => db.select().from(schema.companyPeople).where(eq(schema.companyPeople.personId, personId));
  const withIngest = async (wrapper: (real: PeopleIngestionService['ingest']) => PeopleIngestionService['ingest'], body: () => Promise<void>) => {
    const real = ingestion.ingest.bind(ingestion);
    (ingestion as any).ingest = wrapper(real);
    try {
      await body();
    } finally {
      (ingestion as any).ingest = real;
    }
  };

  beforeAll(async () => {
    const t = await createTestDb([...JOURNALED_MIGRATIONS, '0017_queue_jobs_admin_otps.sql']);
    db = t.db;
    close = () => t.client.close();
    const module = await Test.createTestingModule({
      imports: [PassportModule, TestDbModule.forDb(db)],
      controllers: [PeopleExportImportController, PeopleBundleImportController, PeopleReviewController, PeopleVerificationController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor }, TestJwtStrategy, JwtAuthGuard, RolesGuard, Reflector,
        PeopleWriteService, PeopleIngestionService, PeopleExportImportService, SourceRegistryService, ObservationService, PeopleImportJobService,
        PeopleBundleImportService, PeoplePublishingService, PeopleReviewService, PeopleQuarantineService, PeopleTriageService, PeopleVerificationService,
        { provide: StorageService, useValue: storage },
        { provide: QueueService, useFactory: () => new QueueService(t.db, poolOver(t.client as any) as any) },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix(PREFIX.slice(1));
    applyUploadBodyLimit(app, PREFIX);
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
    await app.init();
    // listen once so parallel supertest requests share one live server (otherwise each starts it and the first to finish closes it: ECONNRESET)
    await app.listen(0, '127.0.0.1');
    ingestion = module.get(PeopleIngestionService);
    jobsSvc = module.get(PeopleImportJobService);
    queue = module.get(QueueService);
    for (const c of [A, B]) await seedBusiness(db, c.slug, { city: c.city, state: c.state });
    const [admin, dm, customer] = await Promise.all([
      seedUser(db, 'bundle.admin@orion.test', undefined, 'ADMIN'), seedUser(db, 'bundle.dm@orion.test', undefined, 'DATA_MANAGER' as any), seedUser(db, 'bundle.customer@orion.test', undefined, 'USER'),
    ]);
    adminId = admin.id;
    tokens = { admin: tokenFor(admin.id, UserRole.ADMIN), dataManager: tokenFor(dm.id, UserRole.DATA_MANAGER), customer: tokenFor(customer.id, UserRole.USER) };
  }, 120_000);

  afterAll(async () => {
    await expectLedgerConsistent(db);
    queue?.unregisterWorker(QUEUE_NAMES.PEOPLE_IMPORT);
    await app?.close();
    await close?.();
  });

  // ------------------------------------------------------------------------------------------------ access and validation endpoint
  describe('access and the validate endpoint', () => {
    it('is admin only: anonymous 401, customer and data manager 403', async () => {
      const zip = packBundle(makeBundle(rowsN(3)));
      for (const token of [null]) {
        expect((await validateRaw(zip, token)).status).toBe(401);
        expect((await postRaw(zip, {}, token)).status).toBe(401);
        expect((await getBundle(randomUUID(), token)).status).toBe(401);
      }
      for (const token of [tokens.customer, tokens.dataManager]) {
        expect((await validateRaw(zip, token)).status).toBe(403);
        expect((await postRaw(zip, {}, token)).status).toBe(403);
        expect((await getBundle(randomUUID(), token)).status).toBe(403);
      }
    });

    it('validate reports metadata only and writes, queues and stages nothing', async () => {
      const before = await snapshot();
      const jobsBefore = await count((await import('../../../database/schema/queue_jobs')).queueJobs);
      const filesBefore = storage.files.size;
      const b = makeBundle(rowsN(7), { partSize: 3, format: 'json' });
      const res = await validateRaw(packBundle(b));
      expect(res.status).toBe(200);
      expect(data(res)).toMatchObject({ valid: true, bundleId: b.manifest.bundle_id, format: 'json', partCount: 3, totalRows: 7, maxPartRows: 3 });
      expect(data(res).parts.map((p: any) => p.rowCount)).toEqual([3, 3, 1]);
      expect(JSON.stringify(res.body)).not.toMatch(/Quill|Kapoorv|Pvt Ltd|sha256|relationship_id|@/i);
      expect(await snapshot()).toEqual(before);
      expect(await count((await import('../../../database/schema/queue_jobs')).queueJobs)).toBe(jobsBefore);
      expect(storage.files.size).toBe(filesBefore);
    });

    it('a structurally invalid bundle is refused whole over HTTP with a machine code: nothing is queued, staged or written', async () => {
      const before = await snapshot();
      const { queueJobs } = await import('../../../database/schema/queue_jobs');
      const jobsBefore = await count(queueJobs);
      const filesBefore = storage.files.size;
      const bad = (mutate: (b: IBundleFx) => void) => { const b = makeBundle(rowsN(6), { partSize: 3 }); mutate(b); return packBundle(b); };
      const cases: Array<[string, Buffer, number]> = [
        ['BUNDLE_PART_HASH_MISMATCH', bad((b) => (b.manifest.parts[1].sha256 = 'b'.repeat(64))), 400],
        ['BUNDLE_PART_BYTES_MISMATCH', bad((b) => (b.manifest.parts[0].bytes += 5)), 400],
        ['BUNDLE_PART_MISSING', bad((b) => b.members.pop()), 400],
        ['BUNDLE_UNSUPPORTED_EXPORT_VERSION', bad((b) => (b.manifest.export_version = '9')), 400],
        ['BUNDLE_ZIP_MALFORMED', Buffer.from('not a zip, just some text to try'), 400],
      ];
      for (const [errorCode, zip, status] of cases) {
        const v = await validateRaw(zip);
        const p = await postRaw(zip);
        expect([v.status, p.status]).toEqual([status, status]);
        expect([v.body.errorCode, p.body.errorCode]).toEqual([errorCode, errorCode]);
        expect(JSON.stringify(p.body)).not.toMatch(/Quill|Kapoorv|Pvt Ltd|@|postgres|select /i);
      }
      expect((await postRaw(Buffer.alloc(12 * 1024 * 1024, 1))).status).toBe(413);
      expect((await as(http().post(BUNDLE)).send({ content: 'x'.repeat(16_000_000) })).status).toBe(413); // longer than any 11 MiB ZIP can be as base64
      expect(await snapshot()).toEqual(before);
      expect(await count(queueJobs)).toBe(jobsBefore);
      expect(storage.files.size).toBe(filesBefore);
    });
  });

  // ------------------------------------------------------------------------------------------------ happy paths
  describe('importing a bundle', () => {
    it('CSV, several parts: queued in manifest order, every part is an ordinary People import job, the aggregate reconciles with the manifest', async () => {
      const before = await snapshot();
      const rows = rowsN(8);
      const b = makeBundle(rows, { partSize: 3 });
      const { accepted, view } = await importBundle(b);
      expect(accepted).toMatchObject({ bundleId: b.manifest.bundle_id, format: 'csv', partCount: 3, totalRows: 8, dryRun: false });
      expect(accepted.parts.map((p: any) => [p.partNumber, p.filename, p.totalRows])).toEqual(b.manifest.parts.map((p) => [p.part_number, p.filename, p.row_count]));
      expect(view).toMatchObject({ status: 'COMPLETED', partCount: 3, completedParts: 3, failedParts: [], pendingParts: [], notImportedParts: [], bundleId: b.manifest.bundle_id, format: 'csv', dryRun: false });
      expect(view.exportedAt).toBe(new Date(b.manifest.exported_at).toISOString());
      expect(view.completedAt).not.toBeNull();
      expect(view.parts.map((p: any) => [p.partNumber, p.filename, p.status, p.expectedRows, p.totalRows, p.imported])).toEqual(b.manifest.parts.map((p) => [p.part_number, p.filename, 'COMPLETED', p.row_count, p.row_count, p.row_count]));
      expect(view.reconciliation).toEqual({
        manifest: { totalRows: 8, parts: 3 },
        orion: { totalRows: 8, parts: 3, completedParts: 3, imported: 8, updated: 0, unchanged: 0, valid: 0, quarantined: 0, rejected: 0, failed: 0, pending: 0 },
        balanced: true,
      });
      const after = await snapshot();
      expect(after.people - before.people).toBe(8);
      expect(after.roles - before.roles).toBe(8);
      expect(after.businesses).toBe(before.businesses);
      // each part is an ordinary import job: the same view as a single-file import, plus the bundle reference
      for (const p of view.parts) {
        const job = data(await as(http().get(`${IMPORT}/${p.jobId}`)));
        expect(job).toMatchObject({ status: 'COMPLETED', totalRows: p.expectedRows, bundle: { bundleId: b.manifest.bundle_id, partNumber: p.partNumber, partCount: 3, filename: p.filename } });
        expect(job.batchRef).toBe(p.batchRef);
      }
      // parts ran in manifest order (one worker, first in first out)
      const created = (await jobsSvc.getBundleJobs(accepted.bundleImportId)).map((j) => Date.parse(j.createdAt));
      expect(created).toEqual([...created].sort((x, y) => x - y));
    });

    it('JSON bundle', async () => {
      const b = makeBundle(rowsN(5), { partSize: 2, format: 'json' });
      const before = await snapshot();
      const { view } = await importBundle(b);
      expect(view).toMatchObject({ status: 'COMPLETED', format: 'json', partCount: 3, completedParts: 3 });
      expect(view.reconciliation).toMatchObject({ balanced: true, orion: { imported: 5, totalRows: 5 } });
      expect((await snapshot()).people - before.people).toBe(5);
    });

    it('one person with several companies, split across parts, is one person with several roles; missing optional contacts are fine', async () => {
      const li = `https://www.linkedin.com/in/bundle-multi-${randomUUID().slice(0, 8)}`;
      const multi = pname();
      const rows = [
        row(), // no contact fields at all
        row({ full_name: multi, linkedin_url: li, email: `${multi.split(' ')[0].toLowerCase()}@bundle-alpha.example` }),
        row(),
        row({ full_name: multi, linkedin_url: li, company_name: nameOf(B.slug), company_city: B.city, company_state: B.state }),
      ];
      const before = await snapshot();
      const { view } = await importBundle(makeBundle(rows, { partSize: 2 }));
      expect(view).toMatchObject({ status: 'COMPLETED', completedParts: 2 });
      expect(view.reconciliation.orion).toMatchObject({ imported: 3, updated: 1 }); // the second role of an existing person is an update
      const after = await snapshot();
      expect(after.people - before.people).toBe(3);
      expect(after.roles - before.roles).toBe(4);
      expect(await rolesOf((await personByName(multi)).id)).toHaveLength(2);
    });

    it('a dry-run bundle writes no People data and reports DRY_RUN', async () => {
      const before = await snapshot();
      const { view } = await importBundle(makeBundle(rowsN(4), { partSize: 2 }), { dryRun: true });
      expect(view).toMatchObject({ status: 'DRY_RUN', dryRun: true, completedParts: 2 });
      expect(view.reconciliation).toMatchObject({ balanced: true, orion: { valid: 4, imported: 0 } });
      expect(await snapshot()).toEqual(before);
    });

    it('responses carry counts, codes and references only: no names, contacts, hashes, storage keys or queue payloads', async () => {
      const b = makeBundle(rowsN(4), { partSize: 2 });
      const { accepted, view } = await importBundle(b);
      const text = JSON.stringify([accepted, view]);
      for (const leak of ['Quill', 'Kapoorv', 'Pvt Ltd', '@', ...b.manifest.parts.map((p) => p.sha256), 'people-imports', 'storageKey', 'contentSha256', 'requestedBy', 'relationship_id', 'select ', 'postgres']) {
        expect(text).not.toContain(leak);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------ data-level outcomes
  describe('data-level outcomes inside a valid bundle', () => {
    it('a part with a quarantined record, an unknown company, a malformed identifier and a missing title: every outcome is reported per part and the bundle completes with issues', async () => {
      const before = await snapshot();
      const rows = [
        ...rowsN(2),                                                                                                                       // part 1: clean
        row(), row({ gstin: 'NOT-A-GSTIN' }),                                                                                              // part 2: one refused before ingestion
        row({ company_name: 'Nowhere Land Pvt Ltd', company_city: 'Pune', company_state: 'Maharashtra' }), row({ job_title: null }),    // part 3: unknown company, missing title
        row(), row(),                                                                                                                      // part 4: clean
      ];
      const { view } = await importBundle(makeBundle(rows, { partSize: 2 }));
      expect(view.status).toBe('COMPLETED_WITH_ISSUES');
      expect(view).toMatchObject({ partCount: 4, completedParts: 4, failedParts: [], notImportedParts: [] });
      const p = view.parts;
      expect([p[0].status, p[0].imported, p[0].quarantined, p[0].rejected]).toEqual(['COMPLETED', 2, 0, 0]);
      expect([p[1].status, p[1].imported, p[1].quarantined, p[1].rejected]).toEqual(['COMPLETED_WITH_ISSUES', 1, 0, 1]);
      expect([p[2].status, p[2].imported, p[2].quarantined, p[2].rejected]).toEqual(['COMPLETED_WITH_ISSUES', 0, 2, 0]);
      expect([p[3].status, p[3].imported]).toEqual(['COMPLETED', 2]);
      expect(view.reconciliation).toMatchObject({ balanced: true, orion: { imported: 5, quarantined: 2, rejected: 1, failed: 0, pending: 0, totalRows: 8 } });
      const after = await snapshot();
      expect(after.businesses).toBe(before.businesses);          // an unknown company is quarantined, never created
      expect(after.identifiers).toBe(before.identifiers);
      expect(after.people - before.people).toBe(5);
      expect(after.quarantine - before.quarantine).toBe(2);
    });

    it('a failed part is reported as failed, the other parts are kept, and importing the same bundle again completes it without duplicates', async () => {
      const b = makeBundle(rowsN(9), { partSize: 3 });
      const before = await snapshot();
      queue.unregisterWorker(QUEUE_NAMES.PEOPLE_IMPORT); // queue everything first, so the fault is in place before any part runs
      const accepted = data(await postRaw(packBundle(b)));
      const failRef = accepted.parts[1].batchRef;
      let view: any;
      await withIngest(
        (real) => async (recs, opts) => {
          if (opts?.batchRef === failRef) throw new Error('part 2 is unlucky: postgres://u:p@h/db');
          return real(recs, opts);
        },
        async () => {
          queue.registerWorker(QUEUE_NAMES.PEOPLE_IMPORT, async (job) => jobsSvc.execute(job.id));
          view = await finishedBundle(accepted.bundleImportId);
        },
      );
      expect(view.status).toBe('FAILED');
      expect(view).toMatchObject({ completedParts: 2, failedParts: [2], pendingParts: [], notImportedParts: [] });
      expect(view.parts.map((p: any) => p.status)).toEqual(['COMPLETED', 'FAILED', 'COMPLETED']);
      expect(view.parts[1]).toMatchObject({ imported: 0, notProcessed: 3, expectedRows: 3 });
      expect(view.parts[1].errorSummary).toBeTruthy();
      expect(view.reconciliation).toMatchObject({ balanced: false, manifest: { totalRows: 9, parts: 3 }, orion: { imported: 6, failed: 3, completedParts: 2, pending: 0 } });
      expect(JSON.stringify(view)).not.toMatch(/postgres|unlucky/);
      expect((await snapshot()).people).toBe(before.people + 6);

      const again = await importBundle(b); // the same bundle again: nothing blocks it, record-level idempotency does the rest
      expect(again.view.status).toBe('COMPLETED');
      expect(again.view.parts.map((p: any) => [p.imported, p.unchanged])).toEqual([[0, 3], [3, 0], [0, 3]]);
      expect(again.view.reconciliation).toMatchObject({ balanced: true, orion: { imported: 3, unchanged: 6 } });
      expect(again.accepted.bundleImportId).not.toBe(accepted.bundleImportId);
      expect((await snapshot()).people).toBe(before.people + 9);
    }, 120_000);

    it('a bundle that could not be fully queued says so: the parts already queued import, the rest are "not imported", and a second upload completes it', async () => {
      const b = makeBundle(rowsN(6), { partSize: 2 });
      const before = await snapshot();
      storage.uploadsAllowed = 2; // storage fails when the third part is staged
      const res = await postRaw(packBundle(b));
      storage.uploadsAllowed = Infinity;
      expect(res.status).toBe(503);
      expect(res.body.errorCode).toBe('BUNDLE_ENQUEUE_INCOMPLETE');
      expect(res.body.details).toMatchObject({ queuedParts: 2, partCount: 3 });
      expect(JSON.stringify(res.body)).not.toMatch(/secret-endpoint/);
      const view = await finishedBundle(res.body.details.bundleImportId);
      expect(view.status).toBe('FAILED');
      expect(view).toMatchObject({ completedParts: 2, notImportedParts: [3], failedParts: [] });
      expect(view.parts[2]).toMatchObject({ status: 'NOT_QUEUED', jobId: null });
      expect(view.reconciliation).toMatchObject({ balanced: false, orion: { parts: 2, imported: 4, failed: 2 } });
      expect((await snapshot()).people).toBe(before.people + 4);
      const again = await importBundle(b);
      expect(again.view.status).toBe('COMPLETED');
      expect((await snapshot()).people).toBe(before.people + 6);
    });
  });

  // ------------------------------------------------------------------------------------------------ idempotency
  describe('idempotency', () => {
    it('uploading the exact same bundle twice is idempotent: same runs, everything unchanged, nothing duplicated', async () => {
      const b = makeBundle(rowsN(6), { partSize: 3 });
      const first = await importBundle(b);
      const mid = await snapshot();
      const second = await importBundle(b);
      expect(second.view.status).toBe('COMPLETED');
      expect(second.view.parts.map((p: any) => p.batchRef)).toEqual(first.view.parts.map((p: any) => p.batchRef));
      expect(second.view.reconciliation).toMatchObject({ balanced: true, orion: { imported: 0, updated: 0, unchanged: 6, quarantined: 0 } });
      expect(await snapshot()).toEqual(mid);
    });

    it('two different bundles (different exports) containing the same people do not duplicate them', async () => {
      const rows = rowsN(4);
      const x = makeBundle(rows, { partSize: 2, exportedAt: at(10) });
      const y = makeBundle(rows, { partSize: 3, exportedAt: at(2), format: 'json' });
      await importBundle(x);
      const mid = await snapshot();
      const second = await importBundle(y);
      expect(second.view.status).toBe('COMPLETED');
      expect(second.view.reconciliation.orion).toMatchObject({ imported: 0, quarantined: 0 });
      expect(second.view.reconciliation.orion.unchanged + second.view.reconciliation.orion.updated).toBe(4);
      expect(await snapshot()).toEqual(mid);
    });
  });

  // ------------------------------------------------------------------------------------------------ state safety
  describe('what a bundle import must not change', () => {
    it('imported people are DRAFT / PENDING / UNVERIFIED / unpublished and reach People Review; the export\'s own claims are ignored', async () => {
      const nm = pname();
      await importBundle(makeBundle([row({ full_name: nm, verification_status: 'VERIFIED', confidence_level: 'HIGH', published_at: '2026-09-30T10:00:00+00:00' })]));
      const person = await personByName(nm);
      const [role] = await rolesOf(person.id);
      expect(person.dataStatus).toBe('DRAFT');
      expect(role).toMatchObject({ reviewStatus: 'PENDING', isPublished: false, verificationStatus: 'UNVERIFIED' });
      const queueRows = (await as(http().get(`${REVIEW}/queue?q=${encodeURIComponent(nm)}`)).expect(200)).body.data as any[];
      expect(queueRows).toHaveLength(1);
      expect(queueRows[0]).toMatchObject({ fullName: nm, reviewStatus: 'PENDING', isPublished: false });
    });

    it('an existing VERIFIED role stays VERIFIED, and no evidence is lost, when a later bundle says otherwise', async () => {
      const nm = pname();
      const rec = row({ full_name: nm, email: `${nm.split(' ')[0].toLowerCase()}@bundle-alpha.example` });
      await importBundle(makeBundle([rec], { exportedAt: at(10) }));
      const [role] = await rolesOf((await personByName(nm)).id);
      const V = (body: object) => as(http().post(`${VERIFY}/roles/${role.id}/verify`)).send(body);
      await V({ claim: 'RELATIONSHIP', evidence: REGISTRY, note: 'officer of this company' }).expect(200);
      await V({ claim: 'TITLE', evidence: { ...REGISTRY, sourceReference: 'MCA filing SRN-779' }, note: 'designation on the filing' }).expect(200);
      expect((await rolesOf(role.personId))[0].verificationStatus).toBe('VERIFIED');
      const mid = await snapshot();
      const { view } = await importBundle(makeBundle([{ ...rec, verification_status: 'UNVERIFIED', confidence_level: 'LOW', email_verification_status: 'UNVERIFIED' }], { exportedAt: at(1) }));
      expect(view.status).toBe('COMPLETED');
      const [after] = await rolesOf(role.personId);
      expect(after).toMatchObject({ id: role.id, verificationStatus: 'VERIFIED', reviewStatus: 'PENDING', isPublished: false });
      const now = await snapshot();
      expect(now.evidence).toBeGreaterThanOrEqual(mid.evidence);
      expect({ people: now.people, roles: now.roles, contacts: now.contacts, businesses: now.businesses }).toEqual({ people: mid.people, roles: mid.roles, contacts: mid.contacts, businesses: mid.businesses });
    });

    it('a bundle import never creates, edits or publishes a company', async () => {
      const companies = async () => JSON.stringify(await db.select().from(schema.businesses).orderBy(schema.businesses.id));
      const before = await companies();
      await importBundle(makeBundle([...rowsN(3), row({ company_name: 'Phantom Industries Pvt Ltd', company_city: 'Pune', company_state: 'Maharashtra' })], { partSize: 2 }));
      expect(await companies()).toBe(before);
    });
  });

  // ------------------------------------------------------------------------------------------------ the aggregate endpoint
  describe('the aggregate endpoint', () => {
    it('unknown or malformed ids are 404 / 400, and single-file imports are unaffected and carry no bundle reference', async () => {
      expect((await getBundle(randomUUID())).status).toBe(404);
      expect((await getBundle(randomUUID())).body.errorCode).toBe('BUNDLE_IMPORT_NOT_FOUND');
      expect((await getBundle('not-a-uuid')).status).toBe(400);
      // a single CSV file still goes through the existing endpoint exactly as before
      const single = await as(http().post(IMPORT)).send({ format: 'csv', content: toCsv(rowsN(2)) });
      expect(single.status).toBe(202);
      const jobId = data(single).jobId;
      let job: any;
      for (let i = 0; i < 400; i++) {
        job = data(await as(http().get(`${IMPORT}/${jobId}`)));
        if (!['QUEUED', 'RUNNING'].includes(job.status)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(job).toMatchObject({ status: 'COMPLETED', imported: 2 });
      expect(Object.keys(job).sort()).toEqual(['acquiredAt', 'ambiguous', 'batchRef', 'completedAt', 'createdAt', 'dryRun', 'errorSummary', 'exportVersion', 'failed', 'imported', 'jobId', 'matched', 'observations', 'processedRows', 'quarantined', 'reasonCounts', 'reconciliation', 'rejectedRows', 'source', 'status', 'totalRows', 'unchanged', 'unmatched', 'updated', 'updatedAt', 'valid']);
      expect((await getBundle(jobId)).status).toBe(404); // a plain job is not a bundle
    });

    it('part jobs appear in the ordinary import history, with the same safe view', async () => {
      const b = makeBundle(rowsN(4), { partSize: 2 });
      const { view } = await importBundle(b);
      const history = await as(http().get(`${IMPORT}?limit=100`));
      const ids = (history.body.data as any[]).map((j) => j.jobId);
      for (const p of view.parts) expect(ids).toContain(p.jobId);
      const item = (history.body.data as any[]).find((j) => j.jobId === view.parts[0].jobId);
      expect(item.bundle).toMatchObject({ partNumber: 1, partCount: 2, bundleId: b.manifest.bundle_id });
      expect(JSON.stringify(history.body)).not.toMatch(/Quill|Kapoorv|sha256|people-imports/i);
      void adminId;
    });
  });
});
