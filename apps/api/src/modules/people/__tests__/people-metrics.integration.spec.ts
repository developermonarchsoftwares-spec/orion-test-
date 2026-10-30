import { INestApplication, ValidationPipe } from '@nestjs/common';
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
import { TransformInterceptor } from '../../../common/interceptors/transform.interceptor';
import { DRIZZLE_DATABASE } from '../../../database/database.constants';
import { DrizzleDb } from '../../../database/database.provider';
import * as schema from '../../../database/schema';
import { IRawPersonRecord } from '../ingestion/ingestion.types';
import { PeopleIngestionService } from '../ingestion/people-ingestion.service';
import { PeopleMetricsController } from '../metrics/metrics.controller';
import { PeopleMetricsService } from '../metrics/people-metrics.service';
import { ObservationService } from '../observations/observation.service';
import { PeoplePublishingService } from '../people-publishing.service';
import { PeopleWriteService } from '../people-write.service';
import { SourceRegistryService } from '../sources/source-registry.service';
import { createTestDb, seedBusiness, seedUser } from './pglite-test-db';

const SECRET = 'metrics-test-secret';
class TestJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: SECRET });
  }
  validate(payload: unknown) {
    return payload;
  }
}
const BASE = '/internal/people-metrics';

describe('Data quality & pipeline metrics (Phase 6.14)', () => {
  let app: INestApplication;
  let db: DrizzleDb;
  let closeDb: () => Promise<void>;
  let tokens: { admin: string; superAdmin: string; dm: string; customer: string };
  let n = 0;

  const tokenFor = (id: string, role: string) => jwt.sign({ sub: id, email: `${id}@t.dev`, role }, SECRET);
  const GET = (url: string, t?: string) => {
    const r = request(app.getHttpServer()).get(url);
    return t ? r.set('Authorization', `Bearer ${t}`) : r;
  };
  const overview = async (qs = '', t = tokens.admin) => (await GET(`${BASE}/overview${qs}`, t).expect(200)).body.data;
  const L = () => Math.random().toString(36).replace(/[0-9.]/g, '').slice(0, 5) || 'abcde';
  const sec = (ts: string) => `'${ts}'::timestamptz`;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    closeDb = () => t.client.close();
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [PeopleMetricsController],
      providers: [{ provide: DRIZZLE_DATABASE, useValue: db }, { provide: APP_INTERCEPTOR, useClass: TransformInterceptor }, TestJwtStrategy, JwtAuthGuard, RolesGuard, Reflector, PeopleMetricsService],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // listen once so parallel supertest requests share one live server (otherwise each starts it and the first to finish closes it: ECONNRESET)
    await app.listen(0, '127.0.0.1');
    const [a, s, d, c] = await Promise.all([seedUser(db, 'm.admin@orion.test', undefined, 'ADMIN'), seedUser(db, 'm.super@orion.test', undefined, 'SUPER_ADMIN'), seedUser(db, 'm.dm@orion.test', undefined, 'DATA_MANAGER'), seedUser(db, 'm.customer@orion.test')]);
    tokens = { admin: tokenFor(a.id, UserRole.ADMIN), superAdmin: tokenFor(s.id, UserRole.SUPER_ADMIN), dm: tokenFor(d.id, UserRole.DATA_MANAGER), customer: tokenFor(c.id, UserRole.USER) };

    // ---- upload batches with known counts and dates (Jan / Feb / Mar 2026)
    const batch = async (file: string, status: string, created: string, cols: Record<string, unknown>) => {
      await db.execute(sql.raw(`INSERT INTO import_batches (filename, file_key, file_size, status, total_records, processed_records, successful_records, failed_records, duplicate_records, people_summary, started_at, completed_at, created_at)
        VALUES ('${file}', 'imports/${file}', 100, '${status}', ${cols.total}, ${cols.processed}, ${cols.ok}, ${cols.failed}, ${cols.dup}, ${cols.ps ? `'${JSON.stringify(cols.ps)}'::jsonb` : 'NULL'},
          ${cols.secs !== undefined ? `'${created}'::timestamptz` : 'NULL'}, ${cols.secs !== undefined ? `'${created}'::timestamptz + interval '${cols.secs} seconds'` : 'NULL'}, '${created}'::timestamptz)`));
    };
    await batch('jan.csv', 'COMPLETED', '2026-01-10T10:00:00Z', { total: 10, processed: 10, ok: 8, failed: 1, dup: 1, secs: 20, ps: { received: 6, accepted: 4, created: 3, updated: 1, unchanged: 0, quarantined: 1, rejected: 1, errors: 0 } });
    await batch('feb.csv', 'FAILED', '2026-02-10T10:00:00Z', { total: 5, processed: 2, ok: 0, failed: 2, dup: 0 });
    await batch('mar.csv', 'COMPLETED', '2026-03-10T10:00:00Z', { total: 20, processed: 20, ok: 20, failed: 0, dup: 0, secs: 40, ps: { received: 4, accepted: 2, created: 0, updated: 0, unchanged: 2, quarantined: 0, rejected: 0, errors: 2 } });
    await db.execute(sql`INSERT INTO publish_queue (record_id, status, retry_count, created_at)
      SELECT r.id, 'FAILED', 2, '2026-02-11T00:00:00Z'::timestamptz FROM (SELECT 1) x, LATERAL (SELECT NULL::uuid AS id) r WHERE false`);

    // ---- quarantine rows (Jan, Feb)
    const q = (fp: string, code: string, status: string, created: string) =>
      db.execute(sql.raw(`INSERT INTO people_ingestion_quarantine (fingerprint, raw, reasons, status, created_at) VALUES ('${fp.padEnd(64, 'f')}', '{"personName":"Secret Person"}', '[{"code":"${code}"}]', '${status}', '${created}')`));
    await q('a1', 'SUPPRESSED_PERSON', 'PENDING', '2026-01-12T00:00:00Z');
    await q('a2', 'BUSINESS_NOT_FOUND', 'PENDING', '2026-01-13T00:00:00Z');
    await q('a3', 'MISSING_TITLE', 'RESOLVED', '2026-02-13T00:00:00Z');

    // ---- keyed observations with company-resolution / identity outcomes (Jan, Feb)
    const obs = (id: string, outcome: string, codes: string[] | null, created: string) =>
      db.execute(sql.raw(`INSERT INTO people_observations (source_key, source_version, source_record_id, batch_ref, acquired_at, content_fingerprint, outcome, reason_codes, created_at)
        VALUES ('people-json', '1', '${id}', 'b', '${created}', '${id}', '${outcome}', ${codes ? `ARRAY[${codes.map((c) => `'${c}'`).join(',')}]::text[]` : 'NULL'}, '${created}')`));
    await obs('o1', 'QUARANTINED', ['BUSINESS_NOT_FOUND'], '2026-01-14T00:00:00Z');
    await obs('o2', 'QUARANTINED', ['AMBIGUOUS_COMPANY_MATCH'], '2026-01-14T00:00:00Z');
    await obs('o3', 'QUARANTINED', ['SUPPRESSED_PERSON'], '2026-02-14T00:00:00Z');
    await obs('o4', 'QUARANTINED', ['SUPPRESSED_PERSON'], '2026-02-14T00:00:00Z');
    await obs('o5', 'QUARANTINED', ['AMBIGUOUS_IDENTITY'], '2026-02-14T00:00:00Z');

    // ---- conflicts (Jan: 2 open + 1 resolved, Feb: 1 open)
    const cf = (k: string, type: string, status: string, created: string) =>
      db.execute(sql.raw(`INSERT INTO people_conflicts (conflict_type, subject_key, status, first_detected_at, last_detected_at) VALUES ('${type}', '${k}', '${status}', '${created}', '${created}')`));
    await cf('c1', 'ROLE_TITLE', 'OPEN', '2026-01-15T00:00:00Z');
    await cf('c2', 'CONTACT_MULTIPLE_PEOPLE', 'OPEN', '2026-01-15T00:00:00Z');
    await cf('c3', 'ROLE_TITLE', 'RESOLVED', '2026-01-16T00:00:00Z');
    await cf('c4', 'CONTACT_CONFLICTING_VALUES', 'OPEN', '2026-02-15T00:00:00Z');

    // ---- people and roles (created 2025-06: outside the Jan..Mar window)
    const ingest = new PeopleIngestionService(db, new PeopleWriteService(db), new SourceRegistryService(db), new ObservationService(db));
    const co = await seedBusiness(db, `metrics-co-${++n}`);
    const rec = (name: string, title: string, over: Record<string, unknown> = {}): IRawPersonRecord =>
      ({ businessId: co.id, personName: name, jobTitle: title, source: { type: 'MANUAL_IMPORT', reference: 's', recordId: `rec-${name}` }, ...over }) as IRawPersonRecord;
    const names = { full: `Full ${L()}van`, linked: `Linked ${L()}van`, none: `None ${L()}van`, supp: `Supp ${L()}van`, unk: `Unk ${L()}van` };
    const r = await ingest.ingest([
      rec(names.full, 'CEO', { email: `full.${L()}@metrics-co.co.in`, phone: '0422 255 0701', linkedinUrl: `https://www.linkedin.com/in/full-${L()}` }),
      rec(names.linked, 'Head of Sales', { linkedinUrl: `https://www.linkedin.com/in/linked-${L()}` }),
      rec(names.none, 'Sales Manager'),
      rec(names.supp, 'Director', { email: `supp.${L()}@metrics-co.co.in` }),
      rec(names.unk, 'Wizard of Whimsy'),
    ], { sourceKey: 'people-json', batchRef: 'metrics-run' });
    expect(r.results.map((x) => x.outcome)).toEqual(['CREATED', 'CREATED', 'CREATED', 'CREATED', 'CREATED']);
    await new PeoplePublishingService(db).suppressPerson(r.results[3].personId!, { reviewedBy: 'r@orion.test', note: 'opt-out request' });
    // roles: control review / verification states directly (they are existing columns)
    const roleOf = (i: number) => r.results[i].companyPersonId!;
    await db.execute(sql.raw(`UPDATE company_people SET review_status = 'APPROVED', is_published = true, verification_status = 'VERIFIED', last_verified_at = now() WHERE id = '${roleOf(0)}'`));
    await db.execute(sql.raw(`UPDATE company_people SET review_status = 'APPROVED', is_published = true, verification_status = 'VERIFIED', last_verified_at = now() - interval '800 days' WHERE id = '${roleOf(1)}'`)); // stale
    await db.execute(sql.raw(`UPDATE company_people SET review_status = 'REJECTED', verification_status = 'CONFLICTED' WHERE id = '${roleOf(2)}'`));
    await db.execute(sql.raw(`UPDATE company_people SET created_at = '2025-06-01T00:00:00Z'`));
    await db.execute(sql.raw(`UPDATE people SET created_at = '2025-06-01T00:00:00Z'`));
  }, 120_000);

  afterAll(async () => {
    // no ledger check here: the fixture sets stored status columns directly to produce known counts (the metrics only read them)
    await app?.close();
    await closeDb?.();
  });

  describe('RBAC and input', () => {
    it('admin and super admin may read; data managers, customers and anonymous callers may not', async () => {
      for (const t of [tokens.admin, tokens.superAdmin]) {
        await GET(`${BASE}/overview`, t).expect(200);
        await GET(`${BASE}/problem-batches`, t).expect(200);
      }
      for (const [t, code] of [[tokens.dm, 403], [tokens.customer, 403], [undefined, 401]] as const) {
        await GET(`${BASE}/overview`, t).expect(code);
        await GET(`${BASE}/problem-batches`, t).expect(code);
      }
    });

    it('rejects an invalid or inverted range and unknown parameters', async () => {
      await GET(`${BASE}/overview?from=yesterday`, tokens.admin).expect(400);
      await GET(`${BASE}/overview?from=2026-03-01T00:00:00Z&to=2026-01-01T00:00:00Z`, tokens.admin).expect(400);
      await GET(`${BASE}/overview?bogus=1`, tokens.admin).expect(400);
      await GET(`${BASE}/problem-batches?limit=1000`, tokens.admin).expect(400);
    });
  });

  describe('metrics (all time)', () => {
    it('acquisition: uploads, rows, People outcomes and quarantine', async () => {
      const m = await overview();
      expect(m.acquisition.uploads).toBe(3);
      expect(m.acquisition.byStatus).toEqual({ COMPLETED: 2, FAILED: 1 });
      expect(m.acquisition.rows).toEqual({ total: 35, processed: 32, accepted: 28, rejected: 3, duplicates: 1 });
      expect(m.acquisition.people).toEqual({ received: 10, created: 3, updated: 1, skipped: 2, quarantined: 1, rejected: 1, errors: 2 });
      expect(m.acquisition.quarantine.byStatus).toMatchObject({ PENDING: 2, RESOLVED: 1 });
      expect(m.acquisition.quarantine.topReasonCodes).toEqual(expect.arrayContaining([{ code: 'SUPPRESSED_PERSON', count: 1 }, { code: 'BUSINESS_NOT_FOUND', count: 1 }, { code: 'MISSING_TITLE', count: 1 }]));
    });

    it('company resolution, identity and suppression', async () => {
      const m = await overview();
      expect(m.companyResolution).toMatchObject({ notFound: 1, ambiguous: 1 });
      expect(m.companyResolution.matched).toBeGreaterThanOrEqual(5); // the five ingested people
      expect(m.identity).toMatchObject({ suppressionHits: 2, duplicateIdentityAttempts: 1 });
      expect(m.identity.suppressionRegistry.total).toBeGreaterThanOrEqual(1);
    });

    it('contacts: coverage excludes suppressed people', async () => {
      const m = await overview();
      expect(m.contacts).toMatchObject({ people: 4, withEmail: 1, withPhone: 1, withLinkedin: 2, withAnyContact: 2, missingContacts: 2, openContactConflicts: 2 });
    });

    it('review, verification, classification and conflicts', async () => {
      const m = await overview();
      expect(m.review).toMatchObject({ roles: 5, approved: 2, rejected: 2, pending: 1, quarantined: 0, published: 2 }); // suppression rejected that person's role (existing behaviour)
      expect(m.verification).toMatchObject({ verified: 2, unverified: 2, disputed: 1, stale: 1, staleAfterDays: 365 });
      expect(m.classification).toMatchObject({ classified: 4, unclassified: 1, bySource: { AUTO: 5 }, byTaxonomyVersion: { v1: 5 } });
      expect(m.classification.decisionMakers).toBeGreaterThanOrEqual(3);
      expect(m.conflicts).toEqual({ basis: expect.any(String), open: { ROLE_TITLE: 1, CONTACT_MULTIPLE_PEOPLE: 1, CONTACT_CONFLICTING_VALUES: 1 }, openTotal: 3, resolvedTotal: 1 });
    });

    it('pipeline health: failures, People-stage errors, retries and durations', async () => {
      const m = await overview();
      expect(m.pipelineHealth).toMatchObject({ failedBatches: 1, batchesWithPeopleErrors: 1, failedRows: 3, peopleStageErrors: 2 });
      expect(m.pipelineHealth.processingSeconds).toEqual({ batchesMeasured: 2, average: 30, p95: 39, max: 40 });
      expect(m.pipelineHealth.publishQueue).toEqual({ failed: 0, retries: 0 });
      expect(Array.isArray(m.pipelineHealth.acquisitionRuns)).toBe(true);
    });
  });

  describe('date ranges are deterministic', () => {
    it('events are counted by their creation time, inclusive of both ends', async () => {
      const jan = await overview('?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z');
      expect(jan.acquisition.uploads).toBe(1);
      expect(jan.acquisition.rows).toEqual({ total: 10, processed: 10, accepted: 8, rejected: 1, duplicates: 1 });
      expect(jan.acquisition.quarantine.byStatus).toEqual({ PENDING: 2 });
      expect(jan.companyResolution).toMatchObject({ notFound: 1, ambiguous: 1, matched: 0 });
      expect(jan.identity).toMatchObject({ suppressionHits: 0, duplicateIdentityAttempts: 0 });
      expect(jan.conflicts).toMatchObject({ open: { ROLE_TITLE: 1, CONTACT_MULTIPLE_PEOPLE: 1 }, openTotal: 2, resolvedTotal: 1 });
      expect(jan.pipelineHealth).toMatchObject({ failedBatches: 0, peopleStageErrors: 0 });
      const feb = await overview('?from=2026-02-01T00:00:00Z&to=2026-02-28T23:59:59Z');
      expect(feb.acquisition.byStatus).toEqual({ FAILED: 1 });
      expect(feb.identity).toMatchObject({ suppressionHits: 2, duplicateIdentityAttempts: 1 });
      expect(feb.pipelineHealth).toMatchObject({ failedBatches: 1 });
      // inclusive boundaries: an event exactly at the bound is counted
      expect((await overview('?from=2026-01-10T10:00:00Z&to=2026-01-10T10:00:00Z')).acquisition.uploads).toBe(1);
      expect((await overview('?from=2026-01-10T10:00:01Z&to=2026-01-10T10:00:02Z')).acquisition.uploads).toBe(0);
      // same request twice gives identical numbers (apart from asOf)
      const a = await overview('?from=2026-01-01T00:00:00Z&to=2026-03-31T23:59:59Z');
      const b = await overview('?from=2026-01-01T00:00:00Z&to=2026-03-31T23:59:59Z');
      expect({ ...a, asOf: 0 }).toEqual({ ...b, asOf: 0 });
      expect(a.range).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-03-31T23:59:59.000Z' });
    });

    it('record sections use the record creation time: people and roles created in 2025 are outside a 2026 range and inside a 2025 one', async () => {
      const in2026 = await overview('?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z');
      expect(in2026.contacts.people).toBe(0);
      expect(in2026.review.roles).toBe(0);
      const in2025 = await overview('?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z');
      expect(in2025.contacts.people).toBe(4);
      expect(in2025.review.roles).toBe(5);
      expect(in2025.classification).toMatchObject({ classified: 4, unclassified: 1 });
    });
  });

  describe('problem batches (paginated)', () => {
    it('lists only batches with problems, newest first, counts only, without overlap between pages', async () => {
      const all = (await GET(`${BASE}/problem-batches?limit=100`, tokens.admin).expect(200)).body;
      expect(all.data.map((b: any) => b.filename)).toEqual(['mar.csv', 'feb.csv', 'jan.csv']);
      expect(all.pagination).toMatchObject({ totalItems: 3, totalPages: 1 });
      expect(all.data[0]).toMatchObject({ status: 'COMPLETED', people: { errors: 2, rejected: 0, quarantined: 0 }, durationSeconds: 40 });
      expect(all.data[1]).toMatchObject({ status: 'FAILED', rows: { total: 5, failed: 2, duplicate: 0 }, durationSeconds: null });
      const p1 = (await GET(`${BASE}/problem-batches?limit=2&page=1`, tokens.admin).expect(200)).body;
      const p2 = (await GET(`${BASE}/problem-batches?limit=2&page=2`, tokens.admin).expect(200)).body;
      expect([...p1.data, ...p2.data].map((b: any) => b.filename)).toEqual(['mar.csv', 'feb.csv', 'jan.csv']);
      expect(p1.pagination).toMatchObject({ totalItems: 3, totalPages: 2 });
      const feb = (await GET(`${BASE}/problem-batches?from=2026-02-01T00:00:00Z&to=2026-02-28T00:00:00Z`, tokens.admin).expect(200)).body;
      expect(feb.data.map((b: any) => b.filename)).toEqual(['feb.csv']);
    });
  });

  describe('no leakage, read-only, aggregate queries', () => {
    it('returns numbers and machine codes only: no contact values, names, payloads, configuration or reviewer data', async () => {
      const dump = JSON.stringify([await overview(), (await GET(`${BASE}/problem-batches`, tokens.admin).expect(200)).body]);
      expect(dump).not.toMatch(/@metrics-co|linkedin\.com|0422 255|Secret Person|personName|payload|raw|config|secret|password|token|reviewer@|note|stack|relation "/i);
      for (const k of ['asOf', 'range', 'acquisition', 'companyResolution', 'identity', 'contacts', 'review', 'verification', 'classification', 'conflicts', 'pipelineHealth']) expect(JSON.parse(dump)[0]).toHaveProperty(k);
      const item = (await GET(`${BASE}/problem-batches`, tokens.admin).expect(200)).body.data[0];
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'durationSeconds', 'filename', 'id', 'people', 'rows', 'status']);
      // no score, rank or prediction anywhere
      expect(dump).not.toMatch(/"(score|rank|quality|prediction|rating)\w*"/i);
    });

    it('reading changes nothing', async () => {
      const snap = async () => {
        const out: Record<string, unknown> = {};
        for (const t of ['import_batches', 'people', 'company_people', 'person_contacts', 'people_conflicts', 'people_observations', 'people_ingestion_quarantine', 'audit_logs']) {
          const res: any = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t}`));
          out[t] = (res.rows ?? res)[0].n;
        }
        return out;
      };
      const before = await snap();
      await overview();
      await overview('?from=2026-01-01T00:00:00Z');
      await GET(`${BASE}/problem-batches`, tokens.admin).expect(200);
      expect(await snap()).toEqual(before);
    });

    it('uses aggregate SQL only: no writes, no whole-table loads, no customer-facing reference', () => {
      const text = fs.readFileSync(path.resolve(__dirname, '../metrics/people-metrics.service.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(text).not.toMatch(/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|\.insert\(|\.update\(|\.delete\(|SELECT \*|\.select\(\)\s*\.from/i);
      expect((text.match(/count\(\*\)|sum\(|avg\(|percentile_cont/g) ?? []).length).toBeGreaterThan(30);
      for (const f of ['people.service.ts', 'people.controller.ts', 'people-export.service.ts', 'people-search.service.ts']) {
        expect(fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8')).not.toMatch(/metrics/i);
      }
      void eq;
    });
  });
});
