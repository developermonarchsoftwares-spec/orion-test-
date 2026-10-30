import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { and, eq, sql } from 'drizzle-orm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../../../common/interceptors/transform.interceptor';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { DRIZZLE_DATABASE } from '../../../database/database.constants';
import { DrizzleDb } from '../../../database/database.provider';
import * as schema from '../../../database/schema';
import { CreditRepository } from '../../credit/credit.repository';
import { CreditService } from '../../credit/credit.service';
import { DiscoverService } from '../../discover/discover.service';
import { SavedLeadsRepository } from '../../saved-leads/saved-leads.repository';
import { SavedLeadsService } from '../../saved-leads/saved-leads.service';
import { PeopleController } from '../people.controller';
import { PeopleExportService } from '../people-export.service';
import { PeopleSearchService } from '../people-search.service';
import { PeopleUnlockService } from '../people-unlock.service';
import { PeopleWriteService } from '../people-write.service';
import { PeopleService } from '../people.service';
import { createTestDb, readMigration, seedBusiness, seedUser } from './pglite-test-db';

const JWT_SECRET = 'test-secret';
const token = (userId: string) => jwt.sign({ sub: userId, email: `${userId}@test.dev`, role: 'USER' }, JWT_SECRET);

class TestJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: JWT_SECRET });
  }
  validate(payload: unknown) {
    return payload;
  }
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const EMAIL = 'anita.rao@sharmatextiles.example';
const MOBILE = '+91 98765 43210';
const LINKEDIN = 'https://in.linkedin.com/in/anita-rao-1234?trk=x';
const SOURCE_URL = 'https://registry.example/internal/filing/998877';

describe('People / Decision Maker layer (real Postgres schema via PGlite)', () => {
  let app: INestApplication;
  let db: DrizzleDb;
  let closeDb: () => Promise<void>;
  let write: PeopleWriteService;
  let people: PeopleService;
  let credit: CreditService;
  let savedLeads: SavedLeadsService;
  let searchSvc: PeopleSearchService;

  let bizA: { id: string; slug: string };
  let bizDraft: { id: string; slug: string };
  let bizChennai: { id: string; slug: string };
  let bizExtra: { id: string; slug: string }; // scratch company for duplicate / multi-role tests
  let rich: { userId: string; token: string };
  let poor: { userId: string; token: string };
  let outsider: { userId: string; token: string };
  let anita: string; // verified founder & CEO with email+mobile+linkedin
  let ravi: string; // unverified head of procurement, no contacts
  let meena: string; // partially verified sales director, phone only
  let suppressed: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    closeDb = () => t.client.close();

    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [PeopleController],
      providers: [
        { provide: DRIZZLE_DATABASE, useValue: db },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        TestJwtStrategy,
        CreditRepository,
        CreditService,
        PeopleService,
        PeopleUnlockService,
        PeopleExportService,
        PeopleWriteService,
        PeopleSearchService,
        JwtAuthGuard,
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // listen once so parallel supertest requests share one live server (otherwise each starts it and the first to finish closes it: ECONNRESET)
    await app.listen(0, '127.0.0.1');

    write = module.get(PeopleWriteService);
    people = module.get(PeopleService);
    credit = module.get(CreditService);
    searchSvc = module.get(PeopleSearchService);
    savedLeads = new SavedLeadsService(new SavedLeadsRepository(db), db);

    bizA = await seedBusiness(db, 'sharma-textiles');
    bizDraft = await seedBusiness(db, 'hidden-co', { status: 'DRAFT' });
    bizChennai = await seedBusiness(db, 'chennai-foods', { city: 'Chennai' });
    bizExtra = await seedBusiness(db, 'extra-co', { city: 'Madurai' });

    const u1 = await seedUser(db, 'rich@test.dev', { daily: 3, purchased: 2 });
    const u2 = await seedUser(db, 'poor@test.dev', { daily: 0, purchased: 0 });
    const u3 = await seedUser(db, 'outsider@test.dev', { daily: 5, purchased: 0 });
    rich = { userId: u1.id, token: token(u1.id) };
    poor = { userId: u2.id, token: token(u2.id) };
    outsider = { userId: u3.id, token: token(u3.id) };

    // ---- People (written the way the future pipeline will: through the ingestion port)
    const a = await write.upsertPersonForBusiness({
      businessId: bizA.id,
      person: { fullName: 'Anita Rao', linkedinUrl: LINKEDIN, city: 'Coimbatore', state: 'Tamil Nadu' },
      role: { jobTitle: 'Founder & CEO' },
      verificationStatus: 'VERIFIED',
      confidenceScore: 92,
      lastVerifiedAt: daysAgo(20),
      dataStatus: 'PUBLISHED',
      // Anita later gets a second company (below). Her contacts were reported for this one, which is what lets customers see them here
      // and nowhere else (Phase 10B: an unattributed contact is not guessed into a company once the person has two).
      observation: { sourceKey: 'people-json', sourceVersion: '1', sourceRecordId: 'rel-anita-sharma', batchRef: 'fixture-anita', acquiredAt: new Date(), observedAt: null, contentFingerprint: 'f'.repeat(64), payloadBytes: 10 },
      contacts: [
        { type: 'WORK_EMAIL', value: EMAIL, isPublished: true, isPrimary: true, verificationStatus: 'VERIFIED', lastVerifiedAt: daysAgo(20) },
        { type: 'MOBILE', value: MOBILE, isPublished: true },
        { type: 'PHONE', value: '+91 422 000 1111', isPublished: false }, // unpublished: never exposed
      ],
      evidence: [
        { sourceType: 'GOVERNMENT_REGISTRY', evidenceType: 'REGISTRY_FILING', sourceUrl: SOURCE_URL, verifiedAt: daysAgo(20), confidenceScore: 95 },
        { sourceType: 'WEB_SCRAPING', evidenceType: 'PROFESSIONAL_PROFILE', verifiedAt: daysAgo(20), scope: 'PERSON' },
        { sourceType: 'API_INTEGRATION', evidenceType: 'EMAIL_CHECK', verifiedAt: daysAgo(20), scope: 'CONTACT', contact: { type: 'WORK_EMAIL', value: EMAIL } },
      ],
    });
    anita = a.personId;

    const r = await write.upsertPersonForBusiness({
      businessId: bizA.id,
      person: { fullName: 'Ravi Kumar', city: 'Chennai', state: 'Tamil Nadu' },
      role: { jobTitle: 'Head of Procurement' },
      verificationStatus: 'VERIFIED', // claimed without evidence -> must be stored UNVERIFIED
      confidenceScore: 80,
      dataStatus: 'PUBLISHED',
    });
    ravi = r.personId;

    const m = await write.upsertPersonForBusiness({
      businessId: bizA.id,
      person: { fullName: 'Meena Iyer', city: 'Coimbatore' },
      role: { jobTitle: 'Sales Director' },
      verificationStatus: 'PARTIALLY_VERIFIED',
      confidenceScore: 60,
      lastVerifiedAt: daysAgo(5),
      dataStatus: 'PUBLISHED',
      contacts: [{ type: 'PHONE', value: '0422 555 0100', isPublished: true }],
      evidence: [{ sourceType: 'MANUAL_IMPORT', evidenceType: 'MANUAL_REVIEW', verifiedAt: daysAgo(5) }],
    });
    meena = m.personId;

    // Former employee, staff (non decision maker), draft and suppressed people
    await write.upsertPersonForBusiness({
      businessId: bizA.id,
      person: { fullName: 'Old Timer' },
      role: { jobTitle: 'Managing Director', isCurrent: false, endDate: '2020-03-31' },
      dataStatus: 'PUBLISHED',
    });
    await write.upsertPersonForBusiness({
      businessId: bizA.id,
      person: { fullName: 'Sam Coder' },
      role: { jobTitle: 'Software Engineer' },
      dataStatus: 'PUBLISHED',
    });
    await write.upsertPersonForBusiness({
      businessId: bizA.id,
      person: { fullName: 'Draft Person' },
      role: { jobTitle: 'CFO' },
      contacts: [{ type: 'WORK_EMAIL', value: 'draft@x.example', isPublished: true }],
    });
    const s = await write.upsertPersonForBusiness({
      businessId: bizA.id,
      person: { fullName: 'Opted Out' },
      role: { jobTitle: 'COO' },
      dataStatus: 'PUBLISHED',
      contacts: [{ type: 'WORK_EMAIL', value: 'optout@x.example', isPublished: true }],
    });
    suppressed = s.personId;
    await write.setDataStatus(suppressed, 'SUPPRESSED');

    // People at an unpublished company and at the Chennai company
    await write.upsertPersonForBusiness({
      businessId: bizDraft.id,
      person: { fullName: 'Hidden Owner' },
      role: { jobTitle: 'Owner' },
      dataStatus: 'PUBLISHED',
    });
    await write.upsertPersonForBusiness({
      businessId: bizChennai.id,
      person: { fullName: 'Chennai Founder' },
      role: { jobTitle: 'Founder' },
      dataStatus: 'PUBLISHED',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
  });

  const get = (url: string, t?: string) => {
    const r = request(app.getHttpServer()).get(url);
    return t ? r.set('Authorization', `Bearer ${t}`) : r;
  };
  const post = (url: string, t?: string, body: object = {}) => {
    const r = request(app.getHttpServer()).post(url);
    return (t ? r.set('Authorization', `Bearer ${t}`) : r).send(body);
  };
  const walletBalance = async (userId: string) => (await credit.getWallet(userId)).balance;
  const ledger = async (userId: string) =>
    db.select().from(schema.creditTransactions).where(and(eq(schema.creditTransactions.userId, userId), eq(schema.creditTransactions.type, 'UNLOCK_LEAD')));

  // ------------------------------------------------------------------ data model
  describe('person creation and company-person relationship', () => {
    it('creates a person with a classified role', async () => {
      const [p] = await db.select().from(schema.people).where(eq(schema.people.id, anita));
      expect(p).toMatchObject({ fullName: 'Anita Rao', normalizedName: 'anita rao', firstName: 'Anita', lastName: 'Rao' });
      expect(p.normalizedLinkedinUrl).toBe('linkedin.com/in/anita-rao-1234');

      const [role] = await db.select().from(schema.companyPeople).where(eq(schema.companyPeople.personId, anita));
      expect(role).toMatchObject({
        businessId: bizA.id,
        jobTitleAtCompany: 'Founder & CEO',
        normalizedJobTitle: 'founder and ceo',
        seniorityLevel: 'EXECUTIVE',
        department: 'EXECUTIVE',
        decisionMakerType: 'FOUNDER_CEO',
        relationshipType: 'FOUNDER',
        isCurrent: true,
      });
    });

    it('one person can hold roles at several companies', async () => {
      const res = await write.upsertPersonForBusiness({
        businessId: bizChennai.id,
        person: { fullName: 'Anita Rao', linkedinUrl: 'linkedin.com/in/ANITA-RAO-1234/' },
        role: { jobTitle: 'Director' },
        dataStatus: 'PUBLISHED',
      });
      expect(res.personId).toBe(anita);
      expect(res.personCreated).toBe(false);
      const roles = await db.select().from(schema.companyPeople).where(eq(schema.companyPeople.personId, anita));
      expect(roles).toHaveLength(2);
    });

    it('rejects a person for a business that does not exist', async () => {
      await expect(
        write.upsertPersonForBusiness({
          businessId: '00000000-0000-0000-0000-000000000000',
          person: { fullName: 'Ghost' },
          role: { jobTitle: 'CEO' },
        }),
      ).rejects.toMatchObject({ errorCode: 'BUSINESS_NOT_FOUND' });
    });
  });

  describe('duplicate people', () => {
    it('matches on normalised LinkedIn URL even when the name differs', async () => {
      const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.people);
      const res = await write.upsertPersonForBusiness({
        businessId: bizExtra.id,
        person: { fullName: 'A. Rao', linkedinUrl: 'https://www.linkedin.com/in/anita-rao-1234' },
        role: { jobTitle: 'Board Director' },
      });
      const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.people);
      expect(res.personId).toBe(anita);
      expect(after[0].n).toBe(before[0].n);
    });

    it('reuses the person for the same name at the same company, adding a second role', async () => {
      const first = await write.upsertPersonForBusiness({
        businessId: bizExtra.id, person: { fullName: 'Kavya S' }, role: { jobTitle: 'Sales Director' }, dataStatus: 'PUBLISHED',
      });
      const res = await write.upsertPersonForBusiness({
        businessId: bizExtra.id,
        person: { fullName: 'Dr. Kavya  S' },
        role: { jobTitle: 'Marketing Director' },
        dataStatus: 'PUBLISHED', // a new role is invisible unless published
      });
      expect(res.personId).toBe(first.personId);
      expect(res.roleCreated).toBe(true);
    });

    it('shows a person with several roles once per company, listing the other roles', async () => {
      const res = await get(`/companies/${bizExtra.id}/people`, rich.token).expect(200);
      const kavya = res.body.data.people.filter((p: any) => p.fullName === 'Kavya S');
      expect(kavya).toHaveLength(1);
      expect(kavya[0].jobTitle).toBe('Sales Director');
      expect(kavya[0].additionalRoles).toEqual(['Marketing Director']);
      // a filter that only the secondary role satisfies still finds her, showing that role
      const mkt = await get(`/companies/${bizExtra.id}/people?department=MARKETING`, rich.token).expect(200);
      expect(mkt.body.data.people).toHaveLength(1);
      expect(mkt.body.data.people[0].jobTitle).toBe('Marketing Director');
      // Anita's role here (added by the LinkedIn-dedupe test) is unpublished, so only Kavya is visible
      expect(res.body.data.summary.total).toBe(1);
    });

    it('does not let person-level evidence verify a role', async () => {
      const res = await write.upsertPersonForBusiness({
        businessId: bizExtra.id,
        person: { fullName: 'Profile Only' },
        role: { jobTitle: 'CEO' },
        verificationStatus: 'VERIFIED',
        evidence: [{ sourceType: 'WEB_SCRAPING', evidenceType: 'PROFESSIONAL_PROFILE', verifiedAt: daysAgo(1), scope: 'PERSON' }],
      });
      expect(res.storedVerificationStatus).toBe('UNVERIFIED');
    });

    it('re-importing the same role does not duplicate it', async () => {
      const res = await write.upsertPersonForBusiness({
        businessId: bizA.id,
        person: { fullName: 'Ravi Kumar' },
        role: { jobTitle: 'HEAD of  procurement' },
      });
      expect(res.personId).toBe(ravi);
      expect(res.roleCreated).toBe(false);
    });

    it('does not merge same-named people at different companies without a shared key', async () => {
      const a = await write.upsertPersonForBusiness({ businessId: bizA.id, person: { fullName: 'John Smith' }, role: { jobTitle: 'Manager' } });
      const b = await write.upsertPersonForBusiness({ businessId: bizChennai.id, person: { fullName: 'John Smith' }, role: { jobTitle: 'Manager' } });
      expect(a.personId).not.toBe(b.personId);
    });

    it('merges same-named people when a contact point is shared', async () => {
      const a = await write.upsertPersonForBusiness({
        businessId: bizA.id,
        person: { fullName: 'Priya Nair' },
        role: { jobTitle: 'Manager' },
        contacts: [{ type: 'WORK_EMAIL', value: 'Priya.Nair@Corp.example' }],
      });
      const b = await write.upsertPersonForBusiness({
        businessId: bizChennai.id,
        person: { fullName: 'priya nair' },
        role: { jobTitle: 'Manager' },
        contacts: [{ type: 'WORK_EMAIL', value: 'priya.nair@corp.example' }],
      });
      expect(b.personId).toBe(a.personId);
      expect(b.contactsCreated).toBe(0); // same normalised email: deduped, not re-inserted
    });

    it('does not merge different people who only share a switchboard number', async () => {
      const a = await write.upsertPersonForBusiness({
        businessId: bizA.id, person: { fullName: 'Reception One' }, role: { jobTitle: 'Executive' },
        contacts: [{ type: 'PHONE', value: '0422 100 2000' }],
      });
      const b = await write.upsertPersonForBusiness({
        businessId: bizChennai.id, person: { fullName: 'Reception Two' }, role: { jobTitle: 'Executive' },
        contacts: [{ type: 'PHONE', value: '0422 100 2000' }],
      });
      expect(a.personId).not.toBe(b.personId);
    });

    it('enforces uniqueness in the database itself', async () => {
      await expect(
        db.insert(schema.people).values({ fullName: 'Dup', normalizedName: 'dup', normalizedLinkedinUrl: 'linkedin.com/in/anita-rao-1234' }),
      ).rejects.toBeDefined();
    });
  });

  // ------------------------------------------------------------------ verification / confidence
  describe('verification and confidence', () => {
    it('stores VERIFIED only when verified evidence backs it', async () => {
      const [ravRole] = await db.select().from(schema.companyPeople).where(eq(schema.companyPeople.personId, ravi));
      expect(ravRole.verificationStatus).toBe('UNVERIFIED');
      const [anitaRole] = await db
        .select()
        .from(schema.companyPeople)
        .where(and(eq(schema.companyPeople.personId, anita), eq(schema.companyPeople.businessId, bizA.id)));
      expect(anitaRole.verificationStatus).toBe('VERIFIED');
    });

    it('rejects out-of-range confidence at the database', async () => {
      await expect(
        db.insert(schema.people).values({ fullName: 'Bad', normalizedName: 'bad', confidenceScore: 500 }),
      ).rejects.toBeDefined();
    });

    it('serves Known / Likely / Unverified with capped confidence', async () => {
      const res = await get(`/companies/${bizA.id}/people`, rich.token).expect(200);
      const byName = Object.fromEntries(res.body.data.people.map((p: any) => [p.fullName, p]));

      expect(byName['Anita Rao'].verification).toMatchObject({ status: 'VERIFIED', assertion: 'KNOWN' });
      expect(byName['Anita Rao'].verification.confidence.level).toBe('HIGH');
      expect(byName['Anita Rao'].decisionMaker.claim).toMatch(/^Decision maker/);

      expect(byName['Meena Iyer'].verification).toMatchObject({ status: 'PARTIALLY_VERIFIED', assertion: 'LIKELY' });
      expect(byName['Meena Iyer'].decisionMaker.claim).toMatch(/^Likely decision maker/);

      // 80 raw confidence but no evidence: must not show HIGH, must not claim verified
      expect(byName['Ravi Kumar'].verification).toMatchObject({ status: 'UNVERIFIED', assertion: 'UNVERIFIED' });
      expect(byName['Ravi Kumar'].verification.confidence.level).toBe('MEDIUM');
      expect(byName['Ravi Kumar'].decisionMaker.claim).toMatch(/^Unverified role/);
      expect(byName['Ravi Kumar'].relevance).toMatch(/not verified/i);
    });

    it('reports an old verification as STALE', async () => {
      const stale = await write.upsertPersonForBusiness({
        businessId: bizChennai.id,
        person: { fullName: 'Stale Sam' },
        role: { jobTitle: 'CTO' },
        verificationStatus: 'VERIFIED',
        lastVerifiedAt: daysAgo(600),
        dataStatus: 'PUBLISHED',
        evidence: [{ sourceType: 'MANUAL_IMPORT', evidenceType: 'MANUAL_REVIEW', verifiedAt: daysAgo(600) }],
      });
      const res = await get(`/companies/${bizChennai.id}/people?q=Stale`, rich.token).expect(200);
      expect(res.body.data.people[0].verification.status).toBe('STALE');
      expect(res.body.data.people[0].verification.assertion).toBe('UNVERIFIED');
      expect(stale.storedVerificationStatus).toBe('VERIFIED');
    });
  });

  // ------------------------------------------------------------------ authn / authz
  describe('authentication and authorisation', () => {
    it.each([
      ['GET', () => get(`/companies/${bizA.id}/people`)],
      ['GET', () => get(`/people/${anita}`)],
      ['GET', () => get('/people/taxonomy')],
      ['GET', () => get('/people/unlocked')],
      ['POST', () => post(`/people/${anita}/unlock`)],
      ['POST', () => post('/people/export')],
    ])('%s requires a valid token', async (_m, call) => {
      await call().expect(401);
    });

    it('rejects a forged token', async () => {
      const forged = jwt.sign({ sub: rich.userId, email: 'x@y.z' }, 'wrong-secret');
      await get(`/companies/${bizA.id}/people`, forged).expect(401);
    });

    it('hides people of unpublished companies', async () => {
      await get(`/companies/${bizDraft.id}/people`, rich.token).expect(404);
      await get(`/companies/hidden-co/people`, rich.token).expect(404);
    });

    it('hides DRAFT and SUPPRESSED people (list and detail)', async () => {
      const res = await get(`/companies/${bizA.id}/people?status=all`, rich.token).expect(200);
      const names = res.body.data.people.map((p: any) => p.fullName);
      expect(names).not.toContain('Draft Person');
      expect(names).not.toContain('Opted Out');
      await get(`/people/${suppressed}`, rich.token).expect(404);
      await post(`/people/${suppressed}/unlock`, rich.token).expect(404);
    });

    it('validates ids and query params', async () => {
      await get('/people/not-a-uuid', rich.token).expect(400);
      await get(`/companies/${bizA.id}/people?limit=9999`, rich.token).expect(400);
      await get(`/companies/${bizA.id}/people?status=bogus`, rich.token).expect(400);
      await get(`/companies/${bizA.id}/people?nope=1`, rich.token).expect(400);
    });

    it('exposes the company people route under both /companies and /company', async () => {
      await get(`/company/${bizA.id}/people`, rich.token).expect(200);
    });
  });

  // ------------------------------------------------------------------ company people API + filters
  describe('GET companies/:id/people', () => {
    const names = async (qs: string) =>
      (await get(`/companies/${bizA.id}/people${qs}`, rich.token).expect(200)).body.data.people.map((p: any) => p.fullName);

    it('returns current published people, decision makers first, with summary and facets', async () => {
      const res = await get(`/companies/${bizA.id}/people`, rich.token).expect(200);
      const d = res.body.data;
      expect(d.business).toMatchObject({ id: bizA.id, slug: 'sharma-textiles' });
      expect(d.people.map((p: any) => p.fullName).slice(0, 3)).toEqual(['Anita Rao', 'Meena Iyer', 'Ravi Kumar']);
      expect(d.summary.decisionMakers).toBeGreaterThanOrEqual(3);
      expect(d.facets.decisionMakerTypes.map((f: any) => f.key)).toEqual(
        expect.arrayContaining(['FOUNDER_CEO', 'SALES_DECISION_MAKER', 'PROCUREMENT_DECISION_MAKER']),
      );
      expect(res.body.pagination).toBeUndefined(); // lives inside data (not unwrapped by the interceptor)
      expect(d.pagination.totalItems).toBe(d.people.length);
    });

    it('filters by department', async () => {
      expect(await names('?department=PROCUREMENT')).toEqual(['Ravi Kumar']);
      expect(await names('?department=sales,procurement')).toEqual(expect.arrayContaining(['Meena Iyer', 'Ravi Kumar']));
    });

    it('filters by seniority', async () => {
      expect(await names('?seniority=HEAD')).toEqual(['Ravi Kumar']);
      expect(await names('?seniority=DIRECTOR')).toContain('Meena Iyer');
    });

    it('filters by decision-maker type and decisionMakersOnly', async () => {
      expect(await names('?decisionMakerType=FOUNDER_CEO')).toEqual(['Anita Rao']);
      const dms = await names('?decisionMakersOnly=true');
      expect(dms).not.toContain('Sam Coder');
    });

    it('filters current / former / all', async () => {
      expect(await names('')).not.toContain('Old Timer');
      expect(await names('?status=former')).toEqual(['Old Timer']);
      expect(await names('?status=all')).toEqual(expect.arrayContaining(['Old Timer', 'Anita Rao']));
    });

    it('filters by effective verification status', async () => {
      expect(await names('?verification=VERIFIED')).toEqual(['Anita Rao']);
      expect(await names('?verification=PARTIALLY_VERIFIED')).toEqual(['Meena Iyer']);
      expect(await names('?verification=UNVERIFIED')).toContain('Ravi Kumar'); // claimed VERIFIED, no evidence
      expect(await names('?verification=UNVERIFIED')).not.toContain('Anita Rao');
    });

    it('filters by location', async () => {
      expect(await names('?location=coimbatore')).toEqual(expect.arrayContaining(['Anita Rao', 'Meena Iyer']));
      expect(await names('?location=coimbatore')).not.toContain('Ravi Kumar');
      expect(await names('?location=chennai')).toEqual(['Ravi Kumar']);
    });

    it('filters by contact availability (published contacts only)', async () => {
      const withContact = await names('?hasContact=true');
      expect(withContact).toEqual(expect.arrayContaining(['Anita Rao', 'Meena Iyer']));
      expect(withContact).not.toContain('Ravi Kumar');
    });

    it('searches name and title, and paginates', async () => {
      expect(await names('?q=procurement')).toEqual(['Ravi Kumar']);
      expect(await names('?q=anita')).toEqual(['Anita Rao']);
      const page = await get(`/companies/${bizA.id}/people?limit=2&page=2`, rich.token).expect(200);
      expect(page.body.data.people).toHaveLength(2);
      expect(page.body.data.pagination).toMatchObject({ page: 2, limit: 2 });
    });

    it('serves the taxonomy for the UI', async () => {
      const res = await get('/people/taxonomy', rich.token).expect(200);
      expect(res.body.data.decisionMakerTypes.map((d: any) => d.key)).toContain('PROCUREMENT_DECISION_MAKER');
      expect(res.body.data.unlockCostCredits).toBe(1);
    });
  });

  // ------------------------------------------------------------------ locked / unlocked
  describe('locked contacts are protected server-side', () => {
    const SENSITIVE = [EMAIL, 'anita-rao-1234', '98765', '43210', '422 000 1111', SOURCE_URL, 'registry.example', 'draft@x.example', 'optout@x.example'];

    it('never puts contact values, LinkedIn URL or source URLs in a locked response', async () => {
      const list = await get(`/companies/${bizA.id}/people?status=all`, outsider.token).expect(200);
      const detail = await get(`/people/${anita}`, outsider.token).expect(200);
      for (const body of [JSON.stringify(list.body), JSON.stringify(detail.body)]) {
        for (const secret of SENSITIVE) expect(body.toLowerCase()).not.toContain(secret.toLowerCase());
      }
    });

    it('still tells the customer what exists, without values', async () => {
      const res = await get(`/companies/${bizA.id}/people?q=Anita`, outsider.token).expect(200);
      const c = res.body.data.people[0].contacts;
      expect(c.isUnlocked).toBe(false);
      expect(c.email).toEqual({ available: true, verificationStatus: 'VERIFIED', value: null });
      expect(c.mobile).toMatchObject({ available: true, value: null });
      expect(c.linkedin).toMatchObject({ available: true, verificationStatus: 'VERIFIED', value: null });
      expect(c.phone.available).toBe(false); // the only phone is unpublished
    });

    it('does not use partial-mask formats that leak characters', async () => {
      const body = JSON.stringify((await get(`/people/${anita}`, outsider.token).expect(200)).body);
      expect(body).not.toMatch(/a\*+o@/i);
      expect(body).not.toMatch(/\+91 ?98\*+/);
    });
  });

  describe('unlock and credits', () => {
    it('unlocks, reveals only published contacts, and deducts exactly one credit', async () => {
      const before = await walletBalance(rich.userId);
      const res = await post(`/people/${anita}/unlock`, rich.token).expect(200);
      expect(res.body.data).toMatchObject({ success: true, alreadyUnlocked: false, creditsSpent: 1, balance: before - 1 });

      const c = res.body.data.person.contacts;
      expect(c.isUnlocked).toBe(true);
      expect(c.email.value).toBe(EMAIL);
      expect(c.mobile.value).toBe(MOBILE);
      expect(c.linkedin.value).toBe(LINKEDIN);
      expect(c.phone).toMatchObject({ available: false, value: null }); // unpublished contact stays hidden
      expect(JSON.stringify(res.body)).not.toContain(SOURCE_URL);

      expect(await walletBalance(rich.userId)).toBe(before - 1);
      const tx = await ledger(rich.userId);
      expect(tx).toHaveLength(1);
      expect(tx[0]).toMatchObject({ amount: -1, referenceId: anita });
      expect(tx[0].description).toMatch(/Unlocked contact: Anita Rao/);
    });

    it('repeat unlock is free and idempotent', async () => {
      const before = await walletBalance(rich.userId);
      const again = await post(`/people/${anita}/unlock`, rich.token).expect(200);
      expect(again.body.data).toMatchObject({ alreadyUnlocked: true, creditsSpent: 0, balance: before });
      expect(await ledger(rich.userId)).toHaveLength(1);
      const rows = await db.select().from(schema.personUnlocks).where(eq(schema.personUnlocks.userId, rich.userId));
      expect(rows).toHaveLength(1);
    });

    it('concurrent unlock requests charge once', async () => {
      const before = await walletBalance(rich.userId);
      const results = await Promise.all([1, 2, 3, 4].map(() => post(`/people/${meena}/unlock`, rich.token)));
      results.forEach((r) => expect(r.status).toBe(200));
      expect(await walletBalance(rich.userId)).toBe(before - 1);
      const rows = await db.select().from(schema.personUnlocks).where(and(eq(schema.personUnlocks.userId, rich.userId), eq(schema.personUnlocks.personId, meena)));
      expect(rows).toHaveLength(1);
    });

    it('the unlock is per user: others stay locked', async () => {
      const res = await get(`/people/${anita}`, outsider.token).expect(200);
      expect(res.body.data.contacts.isUnlocked).toBe(false);
      expect(res.body.data.contacts.email.value).toBeNull();
    });

    it('unlocked values now appear in the company list for the buyer only', async () => {
      const mine = await get(`/companies/${bizA.id}/people?q=Anita`, rich.token).expect(200);
      expect(mine.body.data.people[0].contacts.email.value).toBe(EMAIL);
      const theirs = await get(`/companies/${bizA.id}/people?q=Anita`, outsider.token).expect(200);
      expect(theirs.body.data.people[0].contacts.email.value).toBeNull();
    });

    it('returns 402 and creates nothing when credits are insufficient', async () => {
      const res = await post(`/people/${anita}/unlock`, poor.token).expect(402);
      expect(res.body.errorCode ?? res.body.error?.code ?? JSON.stringify(res.body)).toMatch(/INSUFFICIENT_CREDITS/);
      expect(await db.select().from(schema.personUnlocks).where(eq(schema.personUnlocks.userId, poor.userId))).toHaveLength(0);
      expect(await ledger(poor.userId)).toHaveLength(0);
    });

    it('does not charge for a person with no contact information', async () => {
      const before = await walletBalance(outsider.userId);
      const bare = (await db.select().from(schema.people).where(eq(schema.people.fullName, 'Sam Coder')))[0];
      const res = await post(`/people/${bare.id}/unlock`, outsider.token).expect(409);
      expect(JSON.stringify(res.body)).toMatch(/NO_CONTACT_AVAILABLE/);
      expect(await walletBalance(outsider.userId)).toBe(before);
    });

    it('lists unlocked people', async () => {
      const res = await get('/people/unlocked', rich.token).expect(200);
      const names = res.body.data.unlocked.map((u: any) => u.roles[0].fullName);
      expect(names).toEqual(expect.arrayContaining(['Anita Rao', 'Meena Iyer']));
      expect(names).toHaveLength(2);
    });

    it('a suppressed person disappears from the unlocked list', async () => {
      // unlock then suppress
      const p = await write.upsertPersonForBusiness({
        businessId: bizA.id, person: { fullName: 'Soon Gone' }, role: { jobTitle: 'CEO' }, dataStatus: 'PUBLISHED',
        contacts: [{ type: 'WORK_EMAIL', value: 'gone@x.example', isPublished: true }],
      });
      await post(`/people/${p.personId}/unlock`, outsider.token).expect(200);
      await write.setDataStatus(p.personId, 'SUPPRESSED');
      const res = await get('/people/unlocked', outsider.token).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('gone@x.example');
      await get(`/people/${p.personId}`, outsider.token).expect(404);
    });
  });

  // ------------------------------------------------------------------ saved people
  describe('saved leads: companies and people', () => {
    it('saves a person-at-company lead, distinct from the company lead', async () => {
      const company = await savedLeads.saveLead(rich.userId, { businessId: bizA.id });
      const person = await savedLeads.saveLead(rich.userId, { businessId: bizA.id, personId: anita, tags: ['dm'] });
      expect(person.id).not.toBe(company.id);
      expect(person.personId).toBe(anita);
      expect((company as any).personId ?? null).toBeNull();
    });

    it('saving the same person again updates instead of duplicating', async () => {
      await savedLeads.saveLead(rich.userId, { businessId: bizA.id, personId: anita, pipelineStage: 'CONTACTED' });
      const rows = await db.select().from(schema.savedLeads).where(and(eq(schema.savedLeads.userId, rich.userId), eq(schema.savedLeads.personId, anita)));
      expect(rows).toHaveLength(1);
      expect(rows[0].pipelineStage).toBe('CONTACTED');
    });

    it('saving the company again does not touch the person lead', async () => {
      await savedLeads.saveLead(rich.userId, { businessId: bizA.id, pipelineStage: 'QUALIFIED' });
      const [personLead] = await db.select().from(schema.savedLeads).where(and(eq(schema.savedLeads.userId, rich.userId), eq(schema.savedLeads.personId, anita)));
      expect(personLead.pipelineStage).toBe('CONTACTED');
    });

    it('refuses to save hidden, unpublished or mismatched people', async () => {
      await expect(savedLeads.saveLead(rich.userId, { businessId: bizA.id, personId: suppressed })).rejects.toMatchObject({ errorCode: 'PERSON_NOT_FOUND' });
      await expect(savedLeads.saveLead(rich.userId, { businessId: bizDraft.id, personId: anita })).rejects.toMatchObject({ errorCode: 'PERSON_NOT_FOUND' });
      await expect(savedLeads.saveLead(rich.userId, { businessId: bizA.id, personId: '00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({ errorCode: 'PERSON_NOT_FOUND' });
    });

    it('lists people on saved leads without leaking contact values for locked people', async () => {
      await savedLeads.saveLead(outsider.userId, { businessId: bizA.id, personId: ravi });
      const list = await savedLeads.getSavedLeads(outsider.userId, {} as any);
      const item = list.items.find((i: any) => i.personId === ravi)!;
      expect(item.person).toMatchObject({ fullName: 'Ravi Kumar', jobTitle: 'Head of Procurement', isUnlocked: false });
      expect(JSON.stringify(list)).not.toMatch(/@/);
    });

    it('reflects saved state on the company people list', async () => {
      const res = await get(`/companies/${bizA.id}/people?q=Anita`, rich.token).expect(200);
      expect(res.body.data.people[0].isSaved).toBe(true);
      const other = await get(`/companies/${bizA.id}/people?q=Anita`, poor.token).expect(200);
      expect(other.body.data.people[0].isSaved).toBe(false);
    });

    it('removing the company lead by business id keeps the person lead', async () => {
      await savedLeads.removeLead(rich.userId, bizA.id);
      const remaining = await db.select().from(schema.savedLeads).where(and(eq(schema.savedLeads.userId, rich.userId), eq(schema.savedLeads.businessId, bizA.id)));
      expect(remaining).toHaveLength(1);
      expect(remaining[0].personId).toBe(anita);
    });
  });

  // ------------------------------------------------------------------ export
  describe('export authorisation', () => {
    it('exports only unlocked people, with authorised fields', async () => {
      const res = await post('/people/export', rich.token).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      const csv = res.text;
      expect(csv.split('\n')[0]).toContain('"Company","Person","Job Title","Department"');
      expect(csv).toContain('Anita Rao');
      expect(csv).toContain(EMAIL);
      expect(csv).toContain('Meena Iyer');
      expect(csv).not.toContain('Ravi Kumar'); // never unlocked by this user
      expect(csv).not.toContain('Old Timer');
      expect(csv).not.toContain(SOURCE_URL);
      expect(csv).not.toContain('422 000 1111'); // unpublished contact
    });

    it('never exports locked contacts even when explicitly requested', async () => {
      const res = await post('/people/export', outsider.token, { personIds: [anita, ravi] }).expect(200);
      expect(res.text).not.toContain('Anita Rao');
      expect(res.text).not.toContain(EMAIL);
      expect(res.text).not.toContain('Ravi Kumar');
      expect(res.headers['x-export-skipped-locked']).toBe('2');
    });

    it('limits the export to requested unlocked people', async () => {
      const res = await post('/people/export', rich.token, { personIds: [anita] }).expect(200);
      expect(res.text).toContain('Anita Rao');
      expect(res.text).not.toContain('Meena Iyer');
    });

    it('rejects malformed ids', async () => {
      await post('/people/export', rich.token, { personIds: ['nope'] }).expect(400);
    });

    it('neutralises spreadsheet formula injection in exported cells', async () => {
      const p = await write.upsertPersonForBusiness({
        businessId: bizA.id, person: { fullName: '=HYPERLINK("http://evil")' }, role: { jobTitle: 'CEO' }, dataStatus: 'PUBLISHED',
        contacts: [{ type: 'WORK_EMAIL', value: 'formula@x.example', isPublished: true }],
      });
      await post(`/people/${p.personId}/unlock`, rich.token).expect(200);
      const res = await post('/people/export', rich.token, { personIds: [p.personId] }).expect(200);
      expect(res.text).not.toMatch(/"=HYPERLINK/);
      expect(res.text).toContain(`"'=HYPERLINK`);
    });

    it('a user with no unlocks gets a header-only file', async () => {
      const res = await post('/people/export', poor.token).expect(200);
      expect(res.text.trim().split('\n')).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ search
  describe('company search by people', () => {
    const ids = async (f: Parameters<PeopleSearchService['buildBusinessPredicate']>[0]) => {
      const pred = searchSvc.buildBusinessPredicate(f, sql`${schema.businesses.id}`)!;
      // The predicate only answers "has a matching person"; discover adds the PUBLISHED-company rule.
      const rows = await db
        .select({ slug: schema.businesses.slug })
        .from(schema.businesses)
        .where(and(eq(schema.businesses.status, 'PUBLISHED'), pred));
      return rows.map((r) => r.slug).sort();
    };

    it('finds companies by decision-maker type', async () => {
      expect(await ids({ decisionMakerTypes: ['PROCUREMENT_DECISION_MAKER'] })).toEqual(['sharma-textiles']);
      expect(await ids({ decisionMakerTypes: ['FOUNDER_CEO'] })).toEqual(['chennai-foods', 'sharma-textiles']);
    });

    it('ignores unpublished people, suppressed people and unpublished... companies are excluded by status elsewhere', async () => {
      expect(await ids({ decisionMakerTypes: ['FINANCE_DECISION_MAKER'] })).toEqual([]); // CFO is DRAFT
      expect(await ids({ decisionMakerTypes: ['OPERATIONS_DECISION_MAKER'] })).toEqual([]); // COO is SUPPRESSED
    });

    it('ignores former roles', async () => {
      // Old Timer (former MD) is the only MANAGING_DIRECTOR
      expect(await ids({ decisionMakerTypes: ['MANAGING_DIRECTOR'] })).toEqual([]);
    });

    it('has-decision-maker / verified / contact-available', async () => {
      expect(await ids({ hasDecisionMaker: true })).toEqual(expect.arrayContaining(['sharma-textiles', 'chennai-foods']));
      expect(await ids({ hasVerifiedDecisionMaker: true })).toEqual(['sharma-textiles']);
      // Contact availability follows the company (Phase 10B): Anita's contacts were reported for sharma-textiles only, so her published
      // director role at chennai-foods does not make chennai-foods "contactable". Her unpublished role at extra-co does not count either.
      expect(await ids({ hasDecisionMakerContact: true })).toEqual(['sharma-textiles']);
    });

    it('verified requires evidence and a fresh verification', async () => {
      // Chennai has a STALE verified CTO with old evidence: must not count
      expect(await ids({ hasVerifiedDecisionMaker: true, decisionMakerTypes: ['TECHNOLOGY_DECISION_MAKER'] })).toEqual([]);
    });

    it('DiscoverService answers "Companies in Coimbatore with a Founder/CEO"', async () => {
      const searchStub = { searchBusinesses: () => { throw new Error('typesense must not be used for people filters'); } };
      const discover = new DiscoverService(searchStub as any, {} as any, searchSvc, db);

      const res: any = await discover.search({ q: 'Companies in Coimbatore with a Founder/CEO' } as any, rich.userId);
      expect(res.items.map((i: any) => i.slug)).toEqual(['sharma-textiles']);

      const chennai: any = await discover.search({ q: 'Companies in Chennai with a Founder/CEO' } as any, rich.userId);
      expect(chennai.items.map((i: any) => i.slug)).toEqual(['chennai-foods']);

      const proc: any = await discover.search({ q: 'Companies with a Head of Procurement' } as any, rich.userId);
      expect(proc.items.map((i: any) => i.slug)).toEqual(['sharma-textiles']);

      const explicit: any = await discover.search({ decisionMakerType: 'PROCUREMENT_DECISION_MAKER,bogus' } as any, rich.userId);
      expect(explicit.items.map((i: any) => i.slug)).toEqual(['sharma-textiles']);

      const verified: any = await discover.search({ hasVerifiedDecisionMaker: true } as any, rich.userId);
      expect(verified.items.map((i: any) => i.slug)).toEqual(['sharma-textiles']);
      // The published-only rule still holds: the DRAFT company is never returned
      const all: any = await discover.search({ hasDecisionMaker: true } as any, rich.userId);
      expect(all.items.map((i: any) => i.slug)).not.toContain('hidden-co');
    });

    it('falls back to the normal search path when no people filter is present', async () => {
      const searchStub = { searchBusinesses: jest.fn().mockRejectedValue(new Error('down')) };
      const discover = new DiscoverService(searchStub as any, {} as any, searchSvc, db);
      const res: any = await discover.search({ q: 'sharma' } as any, rich.userId);
      expect(searchStub.searchBusinesses).toHaveBeenCalled();
      expect(res.items.map((i: any) => i.slug)).toEqual(['sharma-textiles']);
    });
  });

  // ------------------------------------------------------------------ migration
  describe('migration 0004', () => {
    it('is idempotent (safe to re-run)', async () => {
      const t = await createTestDb();
      await expect(t.client.exec(readMigration('0004_decision_maker_people.sql'))).resolves.toBeDefined();
      await t.client.close();
    });

    it('adds only a nullable person_id to saved_leads and keeps existing rows valid', async () => {
      const res: any = await db.execute(sql`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'saved_leads' AND column_name = 'person_id'`);
      expect((res.rows ?? res)[0].is_nullable).toBe('YES');
    });

    it('cascades person deletion to roles, contacts, evidence, unlocks and person leads', async () => {
      const p = await write.upsertPersonForBusiness({
        businessId: bizA.id, person: { fullName: 'Cascade Test' }, role: { jobTitle: 'CEO' }, dataStatus: 'PUBLISHED',
        contacts: [{ type: 'WORK_EMAIL', value: 'c@x.example', isPublished: true }],
        evidence: [{ sourceType: 'MANUAL_IMPORT', evidenceType: 'MANUAL_REVIEW' }],
      });
      await post(`/people/${p.personId}/unlock`, outsider.token).expect(200);
      await savedLeads.saveLead(outsider.userId, { businessId: bizA.id, personId: p.personId });
      await db.delete(schema.people).where(eq(schema.people.id, p.personId));
      for (const [t, col] of [['company_people', 'person_id'], ['person_contacts', 'person_id'], ['people_evidence', 'person_id'], ['person_unlocks', 'person_id'], ['saved_leads', 'person_id']]) {
        const r: any = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t} WHERE ${col} = '${p.personId}'`));
        expect((r.rows ?? r)[0].n).toBe(0);
      }
    });
  });
});
