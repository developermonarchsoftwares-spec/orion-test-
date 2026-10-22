import supertest from 'supertest';
const request = (supertest as any).default || supertest;
import * as jwt from 'jsonwebtoken';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { PG_POOL, DRIZZLE_DATABASE } from '../src/database/database.constants';
import { assertLocalDatabaseAllowed, isDisposableOrionDatabase } from '../src/database/db-guard';
import * as schema from '../src/database/schema';
import { TestAppHelper } from './helpers/test-app.helper';
import { TEST_SECRETS } from './helpers/test-secrets';
import { MailService } from '../src/auth/mail/mail.service';
import { GoogleOAuthProvider } from '../src/modules/oauth/providers/google.provider';
import { MicrosoftOAuthProvider } from '../src/modules/oauth/providers/microsoft.provider';
import { MockGoogleOAuthProvider, MockMicrosoftOAuthProvider } from './mocks/mock-oauth-providers';
import { createApprovedSource } from './helpers/approved-source';

/**
 * Real PostgreSQL: the admin import is stored (opt-in).
 *
 * The hermetic suites run on PGlite, an in-process PostgreSQL. This spec sends an import through the same HTTP route the admin panel uses
 * (POST /api/v1/admin/import/submit) against a real PostgreSQL server and then reads the rows back with separate queries.
 *
 * It runs only when IMPORT_PG_DATABASE_URL names an EMPTY, DISPOSABLE database on the local server (orion_scratch*, orion_test*,
 * orion_verify*). It refuses `orion_db`, any other name and any remote host. Migrations are applied to it by this spec.
 */
const URL_ENV = process.env.IMPORT_PG_DATABASE_URL;
const enabled = Boolean(URL_ENV);

const NAMES = ['PgImport Vannam Design Hub', 'PgImport Coimbatore Print Works', 'PgImport Erode Textiles'];

const ROWS = [
  { business_name: NAMES[0], address_line1: '12 Avinashi Road', city: 'Coimbatore', district: 'Coimbatore', state: 'Tamil Nadu', pincode: '641050', phone: '+91 98422 52417', email: 'info@vannamdesignhub.in', website: 'https://www.vannamdesignhub.in/', industry: 'Advertising & Marketing' },
  { business_name: NAMES[1], address_line1: '7 Race Course Road', city: 'Coimbatore', district: 'Coimbatore', state: 'Tamil Nadu', pincode: '641018', phone: '+91 93631 52504', email: 'hello@printworks.co.in', website: 'http://www.printworks.co.in', industry: 'Printing' },
  { business_name: NAMES[2], address_line1: '3 Perundurai Road', city: 'Erode', district: 'Erode', state: 'Tamil Nadu', pincode: '638001', phone: '+91 94430 11122', email: 'sales@erodetextiles.gov.in', website: 'https://erodetextiles.gov.in', industry: 'Textiles' },
];

(enabled ? describe : describe.skip)('Real PostgreSQL: an admin import is stored and can be read back', () => {
  let pool: Pool;
  let app: INestApplication;
  let helper: TestAppHelper;
  let db: any;
  let adminToken = '';
  let batchId = '';
  const adminEmail = `pg.import.${Date.now()}@monarchsoftwares.com`;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const target = assertLocalDatabaseAllowed(URL_ENV);
    if (!target.local || !isDisposableOrionDatabase(target.database)) {
      throw new Error(`Refusing to run: ${target.database} is not a disposable local scratch database (orion_scratch*, orion_test*, orion_verify*).`);
    }
    pool = new Pool({ connectionString: URL_ENV, max: 10 });
    const existing = await pool.query(`SELECT to_regclass('public.users') AS t`);
    if (existing.rows[0].t) throw new Error('Refusing to run: the scratch database already has Orion tables; use a new empty database.');
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(__dirname, '../src/database/migrations') });
    db = drizzle(pool, { schema });

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL).useValue(pool)
      .overrideProvider(DRIZZLE_DATABASE).useValue(db)
      .overrideProvider(GoogleOAuthProvider).useClass(MockGoogleOAuthProvider)
      .overrideProvider(MicrosoftOAuthProvider).useClass(MockMicrosoftOAuthProvider)
      .compile();
    app = module.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
    await app.init();
    app.get(MailService).transport = { send: async () => undefined };

    helper = new TestAppHelper();
    (helper as any).db = db;
    const adminId = await helper.provisionAdmin(adminEmail, 'SUPER_ADMIN');
    adminToken = jwt.sign({ sub: adminId, email: adminEmail, role: 'SUPER_ADMIN', status: 'ACTIVE' }, TEST_SECRETS.jwtAccess, { expiresIn: '1h', issuer: 'orion-api', audience: 'orion-client' });
  }, 120_000);
  beforeEach(() => (app.get(ThrottlerStorage) as any).storage.clear());
  afterAll(async () => {
    if (!app) return;
    await app.close();
    await pool.end().catch(() => undefined);
  });

  it('submits three rows through the admin import route and gets a completed batch', async () => {
    const sourceId = await createApprovedSource(db);
    const res = await api().post('/api/v1/admin/import/submit').set('Authorization', `Bearer ${adminToken}`).send({ filename: 'pg_import_verification.csv', rows: ROWS, autoPublish: false, sourceId });
    expect(res.status).toBe(201);
    const data = res.body.data || res.body;
    expect(data.batchId).toBeTruthy();
    expect(data.failedCount).toBe(0);
    batchId = data.batchId;
  });

  it('the batch row is stored with its file name and counts (read back with a separate query)', async () => {
    const r = await pool.query('SELECT filename, total_records, status::text AS status FROM import_batches WHERE id = $1', [batchId]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].filename).toBe('pg_import_verification.csv');
    expect(Number(r.rows[0].total_records)).toBe(3);
    expect(r.rows[0].status).toBe('COMPLETED');
  });

  it('one staged import record per row is stored, keeping each website exactly as supplied (any extension, http or https)', async () => {
    const r = await pool.query(
      'SELECT row_number, status::text AS status, is_published, raw_payload->>$2 AS name, raw_payload->>$3 AS website FROM import_records WHERE batch_id = $1 ORDER BY row_number',
      [batchId, 'business_name', 'website'],
    );
    expect(r.rows.map((x: any) => [x.name, x.website])).toEqual(ROWS.map((x) => [x.business_name, x.website]));
    expect(r.rows.every((x: any) => x.status !== 'PUBLISHED')).toBe(true); // staged, not published yet
    const q = await pool.query('SELECT count(*)::int AS n FROM publish_queue pq JOIN import_records ir ON ir.id = pq.record_id WHERE ir.batch_id = $1', [batchId]);
    expect(q.rows[0].n).toBe(3);
  });

  it('no business exists until the batch is published', async () => {
    const found = await db.select().from(schema.businesses).where(inArray(schema.businesses.name, NAMES));
    expect(found).toHaveLength(0);
  });

  it('publishing the batch writes the three businesses, their locations and their websites into PostgreSQL', async () => {
    const res = await api().post(`/api/v1/admin/import/publish-batch/${batchId}`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(res.status).toBe(200);
    const found = await db.select().from(schema.businesses).where(inArray(schema.businesses.name, NAMES));
    expect(found.map((x: any) => x.name).sort()).toEqual([...NAMES].sort());
    const sites = await db.select().from(schema.digitalPresences).where(inArray(schema.digitalPresences.businessId, found.map((x: any) => x.id)));
    const siteOf = (n: string) => sites.find((p: any) => p.businessId === found.find((x: any) => x.name === n).id && p.platform === 'WEBSITE')?.url;
    expect(siteOf(NAMES[0])).toBe('https://www.vannamdesignhub.in');
    expect(siteOf(NAMES[1])).toBe('http://www.printworks.co.in');
    expect(siteOf(NAMES[2])).toBe('https://erodetextiles.gov.in');
    const locs = await db.select().from(schema.businessLocations).where(inArray(schema.businessLocations.businessId, found.map((x: any) => x.id)));
    expect(locs.some((l: any) => l.city === 'Erode' && l.state === 'Tamil Nadu' && l.pincode === '638001')).toBe(true);
    const pub = await pool.query("SELECT count(*)::int AS n FROM import_records WHERE batch_id = $1 AND status::text = 'PUBLISHED'", [batchId]);
    expect(pub.rows[0].n).toBe(3);
  });

  it('importing and publishing the same rows again does not create a second copy of any business', async () => {
    const sourceId = await createApprovedSource(db);
    const again = await api().post('/api/v1/admin/import/submit').set('Authorization', `Bearer ${adminToken}`).send({ filename: 'pg_import_verification_again.csv', rows: ROWS, autoPublish: false, sourceId });
    expect(again.status).toBe(201);
    const id2 = (again.body.data || again.body).batchId;
    await api().post(`/api/v1/admin/import/publish-batch/${id2}`).set('Authorization', `Bearer ${adminToken}`).send({});
    const found = await db.select().from(schema.businesses).where(inArray(schema.businesses.name, NAMES));
    expect(found).toHaveLength(3);
  });
});
