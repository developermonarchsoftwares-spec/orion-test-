import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { CreditScheduler } from '../../src/modules/credit/credit.scheduler';
import { GoogleOAuthProvider } from '../../src/modules/oauth/providers/google.provider';
import { MicrosoftOAuthProvider } from '../../src/modules/oauth/providers/microsoft.provider';
import { MockGoogleOAuthProvider, MockMicrosoftOAuthProvider } from '../mocks/mock-oauth-providers';
import { DRIZZLE_DATABASE, PG_POOL } from '../../src/database/database.constants';
import { DrizzleDb } from '../../src/database/database.provider';
import * as schema from '../../src/database/schema';
import { inArray, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createHermeticDatabase } from './pglite-db';
import * as fs from 'fs';
import * as path from 'path';
import { assertMigratedBranch } from '../../src/database/staging-guard';

export class TestAppHelper {
  app: INestApplication;
  module: TestingModule;
  db: DrizzleDb;
  pool: Pool;
  private hermetic?: Awaited<ReturnType<typeof createHermeticDatabase>>;
  private closed = false;

  async init(): Promise<INestApplication> {
    // Hermetic database: never a real server (see setup-env.ts, which also makes DATABASE_URL unusable).
    // Staging mode (setup-staging-env.ts, E2E_TARGET=staging): the application's own pool, pointed at the verified Neon rehearsal branch.
    const staging = process.env.E2E_TARGET === 'staging';
    if (!staging) this.hermetic = await createHermeticDatabase();
    let builder = Test.createTestingModule({
      imports: [AppModule],
    });
    if (this.hermetic) builder = builder.overrideProvider(PG_POOL).useValue(this.hermetic.pool).overrideProvider(DRIZZLE_DATABASE).useValue(this.hermetic.db);
    // On the branch (a copy of real customer data) the daily-rollover worker must not touch wallets of real users: the suites create their own.
    if (staging) builder = builder.overrideProvider(CreditScheduler).useValue({});
    this.module = await builder
      .overrideProvider(GoogleOAuthProvider)
      .useClass(MockGoogleOAuthProvider)
      .overrideProvider(MicrosoftOAuthProvider)
      .useClass(MockMicrosoftOAuthProvider)
      .compile();

    this.app = this.module.createNestApplication({ rawBody: true });

    // Set Global Prefix to match production main.ts
    this.app.setGlobalPrefix('api/v1');

    // Set ValidationPipe to match production main.ts
    this.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: {
          enableImplicitConversion: true,
        },
      }),
    );

    await this.app.init();
    // listen once so parallel supertest requests share one live server (otherwise each starts it and the first to finish closes it: ECONNRESET)
    await this.app.listen(0, '127.0.0.1');

    this.db = this.app.get<DrizzleDb>(DRIZZLE_DATABASE);
    this.pool = this.app.get<Pool>(PG_POOL);

    if (staging) await this.assertConnectedToMigratedBranch();

    return this.app;
  }

  /**
   * Positive proof, before any request: the connected database carries the complete migration history of this repository
   * (production, not yet migrated, does not), and its name and host are the confirmed rehearsal ones. Throws otherwise.
   */
  private async assertConnectedToMigratedBranch(): Promise<void> {
    const journal = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/database/migrations/meta/_journal.json'), 'utf8')) as { entries: unknown[] };
    const rows = Number((await this.pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n);
    try {
      assertMigratedBranch(rows, journal.entries.length);
    } catch (err) {
      await this.app.close();
      throw err;
    }
    const db = (await this.pool.query('SELECT current_database() AS d')).rows[0].d;
    console.log(`[staging] target host ${process.env.STAGING_TARGET_HOST}, database ${db}, ${rows} migrations recorded (isolation proof passed)`);
  }

  /** Admins are provisioned (persisted role), never created by logging in. */
  async provisionAdmin(email: string, role: 'ADMIN' | 'SUPER_ADMIN' | 'USER' = 'SUPER_ADMIN', status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
    const [existing] = await this.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (existing) {
      await this.db.update(schema.users).set({ role, status }).where(eq(schema.users.id, existing.id));
      return existing.id;
    }
    const [created] = await this.db
      .insert(schema.users)
      .values({ email, firstName: 'Test', lastName: 'Admin', displayName: 'Test Admin', role, status, isEmailVerified: true, emailVerifiedAt: new Date(), provider: 'EMAIL' })
      .returning();
    return created.id;
  }

  async cleanupUsers(emails: string[]): Promise<void> {
    if (!emails.length) return;

    try {
      // Delete any admin OTPs for these emails
      await this.db
        .delete(schema.adminOtps)
        .where(inArray(schema.adminOtps.email, emails));

      const usersFound = await this.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(inArray(schema.users.email, emails));

      const userIds = usersFound.map((u) => u.id);

      if (userIds.length > 0) {
        // Delete lead unlocks
        await this.db
          .delete(schema.leadUnlocks)
          .where(inArray(schema.leadUnlocks.userId, userIds));

        // Delete saved leads
        await this.db
          .delete(schema.savedLeads)
          .where(inArray(schema.savedLeads.userId, userIds));

        // Delete saved searches
        await this.db
          .delete(schema.savedSearches)
          .where(inArray(schema.savedSearches.userId, userIds));

        // Delete audit logs associated with these users
        await this.db
          .delete(schema.auditLogs)
          .where(inArray(schema.auditLogs.userId, userIds));

        // Delete credit transactions
        await this.db
          .delete(schema.creditTransactions)
          .where(inArray(schema.creditTransactions.userId, userIds));

        // Delete user wallets
        await this.db
          .delete(schema.userWallets)
          .where(inArray(schema.userWallets.userId, userIds));

        // Delete refresh tokens
        await this.db
          .delete(schema.refreshTokens)
          .where(inArray(schema.refreshTokens.userId, userIds));

        // Delete api keys
        await this.db
          .delete(schema.apiKeys)
          .where(inArray(schema.apiKeys.userId, userIds));

        // Delete users
        await this.db
          .delete(schema.users)
          .where(inArray(schema.users.id, userIds));
      }
    } catch (err: any) {
      console.warn(`[TestAppHelper] User Cleanup warning: ${err.message}`);
    }
  }

  async createTestBusiness(params: {
    slug: string;
    name: string;
    contactEmail: string;
    contactPhone: string;
    city?: string;
    state?: string;
  }) {
    // 1. Insert business
    const [biz] = await this.db
      .insert(schema.businesses)
      .values({
        slug: params.slug,
        name: params.name,
        legalName: `${params.name} Pvt Ltd`,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        employeeCountRange: '50-200',
        annualRevenueRange: '10M-50M',
      })
      .returning();

    // 2. Insert primary location
    await this.db.insert(schema.businessLocations).values({
      businessId: biz.id,
      addressLine1: '42 Cyber City Tower 3',
      city: params.city || 'Bangalore',
      district: params.city || 'Bangalore',
      state: params.state || 'Karnataka',
      pincode: '560001',
      country: 'India',
      isPrimary: true,
    });

    // 3. Insert primary contact
    await this.db.insert(schema.businessContacts).values({
      businessId: biz.id,
      fullName: 'Vikram Aditya Sharma',
      title: 'Chief Technology Officer',
      email: params.contactEmail,
      phone: params.contactPhone,
      isPrimary: true,
      isDecisionMaker: true,
    });

    return biz;
  }

  async cleanupBusinesses(slugs: string[]): Promise<void> {
    if (!slugs.length) return;
    try {
      const found = await this.db
        .select({ id: schema.businesses.id })
        .from(schema.businesses)
        .where(inArray(schema.businesses.slug, slugs));

      const bizIds = found.map((b) => b.id);
      if (bizIds.length > 0) {
        await this.db.delete(schema.leadUnlocks).where(inArray(schema.leadUnlocks.businessId, bizIds));
        await this.db.delete(schema.savedLeads).where(inArray(schema.savedLeads.businessId, bizIds));
        await this.db.delete(schema.businessContacts).where(inArray(schema.businessContacts.businessId, bizIds));
        await this.db.delete(schema.businessLocations).where(inArray(schema.businessLocations.businessId, bizIds));
        await this.db.delete(schema.businesses).where(inArray(schema.businesses.id, bizIds));
      }
    } catch (err: any) {
      console.warn(`[TestAppHelper] Business Cleanup warning: ${err.message}`);
    }
  }

  /**
   * Closes the application exactly once. app.close() stops the schedulers / workers (onModuleDestroy) and then the application's own
   * DatabaseService ends the pool (shutdown phase), so the pool is deliberately NOT ended again here; only the in-memory database,
   * which the application does not own, is closed afterwards.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.app) await this.app.close();
    if (this.hermetic) await this.hermetic.close();
  }
}
