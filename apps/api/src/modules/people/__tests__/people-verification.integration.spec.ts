import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { UserRole } from '@orion/shared';
import { desc, eq, sql } from 'drizzle-orm';
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
import { CreditRepository } from '../../credit/credit.repository';
import { CreditService } from '../../credit/credit.service';
import { IRawPersonRecord } from '../ingestion/ingestion.types';
import { PeopleIngestionService } from '../ingestion/people-ingestion.service';
import { PeopleController } from '../people.controller';
import { PeopleExportService } from '../people-export.service';
import { PeoplePublishingService } from '../people-publishing.service';
import { PeopleSearchService } from '../people-search.service';
import { PeopleUnlockService } from '../people-unlock.service';
import { PeopleWriteService } from '../people-write.service';
import { PeopleService } from '../people.service';
import { PeopleQuarantineService } from '../review/people-quarantine.service';
import { PeopleReviewController } from '../review/people-review.controller';
import { PeopleReviewService } from '../review/people-review.service';
import { PeopleTriageService } from '../review/people-triage.service';
import { PeopleVerificationController } from '../verification/people-verification.controller';
import { PeopleVerificationService } from '../verification/people-verification.service';
import { ILedgerRow, claimState } from '../policies/claim-verification.policy';
import { collectLedgerViolations, expectLedgerConsistent } from './ledger-invariants';
import { createTestDb, seedBusiness, seedUser } from './pglite-test-db';

const SECRET = 'verification-test-secret';
class TestJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: SECRET });
  }
  validate(payload: unknown) {
    return payload;
  }
}

const SRC = { type: 'MANUAL_IMPORT', label: 'unit', reference: 'sheet-1' };
const V = '/internal/people-verification';
const R = '/internal/people-review';
const REGISTRY = { sourceType: 'GOVERNMENT_REGISTRY', evidenceType: 'REGISTRY_FILING', sourceReference: 'MCA filing SRN-778' };
const CALL = { sourceType: 'MANUAL_IMPORT', evidenceType: 'DIRECT_CONFIRMATION', sourceReference: 'call log 2026-09-30 10:15' };
const PROFILE = { sourceType: 'WEB_SCRAPING', evidenceType: 'PROFESSIONAL_PROFILE', sourceUrl: 'https://www.linkedin.com/in/verified-person-1' };
const SRC_DIR = path.resolve(__dirname, '../../..');

describe('People verification (Phase 5): field-level, evidence-backed, separate from approval', () => {
  let app: INestApplication;
  let db: DrizzleDb;
  let closeDb: () => Promise<void>;
  let ingest: PeopleIngestionService;
  let write: PeopleWriteService;
  let service: PeopleVerificationService;
  let admin: { id: string; token: string; email: string };
  let superAdmin: { id: string; token: string };
  let dataManager: { id: string; token: string };
  let customer: { id: string; token: string };
  let seq = 0;
  let coSeq = 0;

  const tokenFor = (id: string, role: string, email = `${id}@t.dev`) => jwt.sign({ sub: id, email, role }, SECRET);
  const http = () => request(app.getHttpServer());
  const withAuth = (r: request.Test, t?: string) => (t ? r.set('Authorization', `Bearer ${t}`) : r);
  const GET = (url: string, t?: string) => withAuth(http().get(url), t);
  const POST = (url: string, t?: string, body: object = {}) => withAuth(http().post(url), t).send(body);
  const PATCH = (url: string, t: string, body: object = {}) => withAuth(http().patch(url), t).send(body);

  const alpha = (n: number) => 'Vq' + n.toString(26).replace(/[0-9]/g, (d) => String.fromCharCode(103 + Number(d)));
  const newCompany = () => seedBusiness(db, `verif-${++coSeq}-${Math.random().toString(36).slice(2, 6)}`);
  const ingestOne = async (over: Partial<IRawPersonRecord> = {}) => {
    const co = over.businessId ? { id: over.businessId } : await newCompany();
    const rec: IRawPersonRecord = { businessId: co.id, personName: `Person ${alpha(++seq)}`, jobTitle: 'CEO', source: SRC, ...over };
    const r = (await ingest.ingest([rec])).results[0];
    if (!r.companyPersonId) throw new Error(`ingest failed: ${JSON.stringify(r)}`);
    return { personId: r.personId!, roleId: r.companyPersonId!, businessId: co.id };
  };
  const role = async (id: string) => (await db.select().from(schema.companyPeople).where(eq(schema.companyPeople.id, id)))[0];
  const person = async (id: string) => (await db.select().from(schema.people).where(eq(schema.people.id, id)))[0];
  const contactsOf = (personId: string) => db.select().from(schema.personContacts).where(eq(schema.personContacts.personId, personId));
  const ledger = (personId: string) => db.select().from(schema.peopleVerifications).where(eq(schema.peopleVerifications.personId, personId));
  const audits = (entityId: string, action?: string) =>
    db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, entityId)).orderBy(desc(schema.auditLogs.createdAt)).then((rows) => (action ? rows.filter((r) => r.action === action) : rows));
  const verify = (roleId: string, body: object, t = admin.token) => POST(`${V}/roles/${roleId}/verify`, t, body);
  const panel = async (roleId: string) => (await GET(`${V}/roles/${roleId}`, admin.token).expect(200)).body.data.claims as any[];
  const claim = async (roleId: string, name: string, contactId?: string) => (await panel(roleId)).find((c) => c.claim === name && (contactId ? c.contactId === contactId : true));
  const custList = async (businessId: string) => (await GET(`/companies/${businessId}/people?status=all`, customer.token).expect(200)).body.data.people as any[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    closeDb = () => t.client.close();
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [PeopleController, PeopleReviewController, PeopleVerificationController],
      providers: [
        { provide: DRIZZLE_DATABASE, useValue: db },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        TestJwtStrategy, JwtAuthGuard, RolesGuard, Reflector,
        CreditRepository, CreditService,
        PeopleService, PeopleUnlockService, PeopleExportService, PeopleSearchService,
        PeopleWriteService, PeopleIngestionService, PeoplePublishingService,
        PeopleReviewService, PeopleQuarantineService, PeopleVerificationService, PeopleTriageService,
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // listen once so parallel supertest requests share one live server (otherwise each starts it and the first to finish closes it: ECONNRESET)
    await app.listen(0, '127.0.0.1');
    ingest = module.get(PeopleIngestionService);
    write = module.get(PeopleWriteService);
    service = module.get(PeopleVerificationService);

    const a = await seedUser(db, 'verifier.admin@orion.test', undefined, 'ADMIN');
    const s = await seedUser(db, 'verifier.super@orion.test', undefined, 'SUPER_ADMIN');
    const d = await seedUser(db, 'verifier.dm@orion.test', undefined, 'DATA_MANAGER');
    const c = await seedUser(db, 'verifier.customer@orion.test', { daily: 5, purchased: 5 });
    admin = { id: a.id, email: a.email, token: tokenFor(a.id, UserRole.ADMIN, a.email) };
    superAdmin = { id: s.id, token: tokenFor(s.id, UserRole.SUPER_ADMIN, s.email) };
    dataManager = { id: d.id, token: tokenFor(d.id, UserRole.DATA_MANAGER) };
    customer = { id: c.id, token: tokenFor(c.id, UserRole.USER) };
  }, 60_000);

  afterAll(async () => {
    // whatever the tests did, the status columns still agree with the ledger
    await expectLedgerConsistent(db);
    await app?.close();
    await closeDb?.();
  });

  // ================================================================ per-claim verification
  describe('verifying each claim (1-6)', () => {
    it('1. identity: needs registry-like evidence; records who/when/why/on what; does NOT approve or publish', async () => {
      const r = await ingestOne({ personName: 'Ident Ifyer' });
      const res = await verify(r.roleId, { claim: 'IDENTITY', evidence: REGISTRY, note: 'Filing names this person' }).expect(200);
      expect(res.body.data).toMatchObject({ outcome: 'VERIFIED', claim: 'IDENTITY', state: 'VERIFIED', changed: true });

      const [row] = await ledger(r.personId);
      expect(row).toMatchObject({ claimType: 'IDENTITY', claimedValue: 'ident ifyer', status: 'VERIFIED', verifiedById: admin.id, verifiedByLabel: admin.email, note: 'Filing names this person' });
      expect(row.evidenceId).toBeTruthy();
      const [ev] = await db.select().from(schema.peopleEvidence).where(eq(schema.peopleEvidence.id, row.evidenceId!));
      expect(ev).toMatchObject({ evidenceType: 'REGISTRY_FILING', sourceType: 'GOVERNMENT_REGISTRY', sourceReference: 'MCA filing SRN-778' });
      expect(ev.verifiedAt).not.toBeNull();

      // approval and publication are untouched
      expect(await role(r.roleId)).toMatchObject({ reviewStatus: 'PENDING', isPublished: false });
      expect(await person(r.personId)).toMatchObject({ dataStatus: 'DRAFT' });
      const c = await claim(r.roleId, 'IDENTITY');
      expect(c).toMatchObject({ state: 'VERIFIED', verifiedBy: admin.email, note: 'Filing names this person' });
      expect(c.basis).toMatchObject({ evidenceType: 'REGISTRY_FILING', reference: 'MCA filing SRN-778' });
    });

    it('2. company relationship: verifying one role claim makes the role PARTIALLY_VERIFIED, and never publishes it', async () => {
      const r = await ingestOne();
      await verify(r.roleId, { claim: 'RELATIONSHIP', evidence: REGISTRY, note: 'Listed as officer of this company' }).expect(200);
      const ro = await role(r.roleId);
      expect(ro.verificationStatus).toBe('PARTIALLY_VERIFIED');
      expect(ro.confidenceScore).toBeGreaterThanOrEqual(70);
      expect(ro.lastVerifiedAt).not.toBeNull();
      expect(ro).toMatchObject({ reviewStatus: 'PENDING', isPublished: false });
      expect((await claim(r.roleId, 'RELATIONSHIP')).currentValue).toBe(r.businessId);
    });

    it('3. title: relationship + title verified -> role VERIFIED; the person rollup follows', async () => {
      const r = await ingestOne();
      await verify(r.roleId, { claim: 'RELATIONSHIP', evidence: REGISTRY, note: 'officer of this company' }).expect(200);
      await verify(r.roleId, { claim: 'TITLE', evidence: { ...REGISTRY, sourceReference: 'MCA filing SRN-779' }, note: 'designation on the filing' }).expect(200);
      const ro = await role(r.roleId);
      expect(ro.verificationStatus).toBe('VERIFIED');
      expect(ro.confidenceScore).toBeGreaterThanOrEqual(85);
      expect((await person(r.personId)).verificationStatus).toBe('VERIFIED');
      expect((await claim(r.roleId, 'TITLE')).state).toBe('VERIFIED');
    });

    it('4. email: verified by direct confirmation, contact becomes VERIFIED but stays unpublished', async () => {
      const r = await ingestOne({ email: 'verify.me@corp-verif.co.in' });
      const [c] = await contactsOf(r.personId);
      await verify(r.roleId, { claim: 'EMAIL', contactId: c.id, evidence: CALL, note: 'Confirmed by phone with the person' }).expect(200);
      const [after] = await contactsOf(r.personId);
      expect(after).toMatchObject({ verificationStatus: 'VERIFIED', isPublished: false });
      expect(after.lastVerifiedAt).not.toBeNull();
      const ev = await db.select().from(schema.peopleEvidence).where(eq(schema.peopleEvidence.contactId, c.id));
      expect(ev.find((e) => e.evidenceType === 'DIRECT_CONFIRMATION')?.verifiedAt).toBeTruthy();
      expect((await audits(c.id, 'PEOPLE_CLAIM_VERIFIED'))).toHaveLength(1);
    });

    it('5. phone: same rules; a mobile number carries a PHONE claim; an email cannot carry a PHONE claim', async () => {
      const r = await ingestOne({ mobile: '9876543210', email: 'phone.case@corp-verif.co.in' });
      const cs = await contactsOf(r.personId);
      const mobile = cs.find((c) => c.contactType === 'MOBILE')!;
      const email = cs.find((c) => c.contactType === 'WORK_EMAIL')!;
      await verify(r.roleId, { claim: 'PHONE', contactId: email.id, evidence: CALL, note: 'wrong contact kind' }).expect(400);
      await verify(r.roleId, { claim: 'PHONE', contactId: mobile.id, evidence: CALL, note: 'Called and spoke to them' }).expect(200);
      expect((await contactsOf(r.personId)).find((c) => c.id === mobile.id)!.verificationStatus).toBe('VERIFIED');
    });

    it('6. LinkedIn: only professional-profile evidence counts, and a well-formed URL alone is not verification', async () => {
      const r = await ingestOne({ linkedinUrl: 'https://www.linkedin.com/in/verified-person-1' });
      expect((await claim(r.roleId, 'LINKEDIN')).state).toBe('UNVERIFIED'); // valid-looking URL, no evidence
      await verify(r.roleId, { claim: 'LINKEDIN', evidence: REGISTRY, note: 'wrong evidence type' }).expect(400);
      await verify(r.roleId, { claim: 'LINKEDIN', evidence: PROFILE, note: 'Opened the profile; matches name and company' }).expect(200);
      expect((await claim(r.roleId, 'LINKEDIN')).state).toBe('VERIFIED');
      // no LinkedIn on file -> nothing to verify
      const none = await ingestOne();
      await verify(none.roleId, { claim: 'LINKEDIN', evidence: PROFILE, note: 'nothing on file' }).expect(400);
    });
  });

  // ================================================================ evidence rules
  describe('evidence requirements (7-8)', () => {
    it('7. missing evidence: no evidence, or both kinds at once, is refused', async () => {
      const r = await ingestOne();
      const a = await verify(r.roleId, { claim: 'TITLE', note: 'trust me' }).expect(400);
      expect(JSON.stringify(a.body)).toMatch(/EVIDENCE_REQUIRED/);
      const [ev] = await db.select().from(schema.peopleEvidence).where(eq(schema.peopleEvidence.companyPersonId, r.roleId));
      await verify(r.roleId, { claim: 'TITLE', evidenceId: ev.id, evidence: REGISTRY, note: 'both given' }).expect(400);
      expect(await ledger(r.personId)).toHaveLength(0);
    });

    it('8. invalid evidence: the upload row that made the claim, uncited, future-dated, wrong subject, other person, wrong claim type', async () => {
      const r = await ingestOne({ email: 'inv.ev@corp-verif.co.in' });
      const other = await ingestOne({ email: 'other.person@corp-verif.co.in' });
      const [roleEv] = await db.select().from(schema.peopleEvidence).where(eq(schema.peopleEvidence.companyPersonId, r.roleId));
      const [contact] = await contactsOf(r.personId);
      const [otherContact] = await contactsOf(other.personId);
      const [otherEv] = await db.select().from(schema.peopleEvidence).where(eq(schema.peopleEvidence.companyPersonId, other.roleId));

      // the ingestion claim itself (UPLOAD_ROW) can never verify what it claimed
      const upload = await verify(r.roleId, { claim: 'TITLE', evidenceId: roleEv.id, note: 'the upload says so' }).expect(400);
      expect(JSON.stringify(upload.body)).toMatch(/EVIDENCE_TYPE_NOT_ACCEPTED/);
      // no reference / URL
      await verify(r.roleId, { claim: 'TITLE', evidence: { sourceType: 'GOVERNMENT_REGISTRY', evidenceType: 'REGISTRY_FILING' }, note: 'uncited' }).expect(400);
      // future observation date
      await verify(r.roleId, { claim: 'TITLE', evidence: { ...REGISTRY, observedAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }, note: 'from the future' }).expect(400);
      // unknown enum / bad url
      await verify(r.roleId, { claim: 'TITLE', evidence: { ...REGISTRY, evidenceType: 'GUT_FEELING' }, note: 'made up' }).expect(400);
      await verify(r.roleId, { claim: 'TITLE', evidence: { sourceType: 'WEB_SCRAPING', evidenceType: 'COMPANY_WEBSITE', sourceUrl: 'not a url' }, note: 'bad url' }).expect(400);
      // email cannot be verified by a registry-less profile
      await verify(r.roleId, { claim: 'EMAIL', contactId: contact.id, evidence: PROFILE, note: 'wrong type for email' }).expect(400);
      // another person's evidence / contact (IDOR)
      await verify(r.roleId, { claim: 'TITLE', evidenceId: otherEv.id, note: 'borrowed evidence' }).expect(404);
      await verify(r.roleId, { claim: 'EMAIL', contactId: otherContact.id, evidence: CALL, note: 'someone else contact' }).expect(404);
      // evidence about a different subject (contact evidence for a title claim)
      const [contactEv] = await db.select().from(schema.peopleEvidence).where(eq(schema.peopleEvidence.contactId, contact.id));
      await verify(r.roleId, { claim: 'TITLE', evidenceId: contactEv.id, note: 'wrong subject' }).expect(400);
      // contactId on a non-contact claim, unknown claim, bad ids, empty note
      await verify(r.roleId, { claim: 'TITLE', contactId: contact.id, evidence: REGISTRY, note: 'stray contact' }).expect(400);
      await verify(r.roleId, { claim: 'IS_VERIFIED', evidence: REGISTRY, note: 'boolean flag' }).expect(400);
      await verify('not-a-uuid', { claim: 'TITLE', evidence: REGISTRY, note: 'bad id' }).expect(400);
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'x' }).expect(400);
      expect(await ledger(r.personId)).toHaveLength(0);
      expect((await role(r.roleId)).verificationStatus).toBe('UNVERIFIED');
    });

    it('a reviewer-added evidence row (edit flow) can be cited later, by id', async () => {
      const r = await ingestOne();
      await PATCH(`${R}/roles/${r.roleId}`, admin.token, {
        reason: 'attach the filing',
        addEvidence: [{ sourceType: 'GOVERNMENT_REGISTRY', evidenceType: 'REGISTRY_FILING', sourceReference: 'SRN-900' }],
      }).expect(200);
      const c = await claim(r.roleId, 'TITLE');
      expect(c.eligibleEvidence).toHaveLength(1);
      await verify(r.roleId, { claim: 'TITLE', evidenceId: c.eligibleEvidence[0].id, note: 'filing SRN-900 shows this title' }).expect(200);
      expect((await claim(r.roleId, 'TITLE')).state).toBe('VERIFIED');
    });
  });

  // ================================================================ repeat / duplicate / upgrade
  describe('duplicate, repeated and stronger/weaker verification (9-11)', () => {
    it('9/10. the same verification twice is a no-op; weaker evidence never replaces stronger; stronger upgrades', async () => {
      const r = await ingestOne();
      await verify(r.roleId, { claim: 'TITLE', evidence: { sourceType: 'WEB_SCRAPING', evidenceType: 'COMPANY_WEBSITE', sourceUrl: 'https://corp.example/team' }, note: 'listed on the team page' }).expect(200);
      const again = await verify(r.roleId, { claim: 'TITLE', evidence: { sourceType: 'WEB_SCRAPING', evidenceType: 'COMPANY_WEBSITE', sourceUrl: 'https://corp.example/team' }, note: 'again' }).expect(200);
      expect(again.body.data).toMatchObject({ outcome: 'ALREADY_VERIFIED', changed: false });
      expect(await ledger(r.personId)).toHaveLength(1);
      expect(await audits(r.roleId, 'PEOPLE_CLAIM_VERIFIED')).toHaveLength(1);

      // equally strong, different source: kept as is
      const equal = await verify(r.roleId, { claim: 'TITLE', evidence: { sourceType: 'WEB_SCRAPING', evidenceType: 'PROFESSIONAL_PROFILE', sourceUrl: 'https://profiles.example/p/1' }, note: 'profile agrees' }).expect(200);
      expect(equal.body.data.outcome).toBe('ALREADY_VERIFIED');

      // stronger (registry) upgrades the basis and keeps the old evidence row
      const up = await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'registry filing found' }).expect(200);
      expect(up.body.data.outcome).toBe('UPGRADED');
      const [row] = await ledger(r.personId);
      expect(row.evidenceStrength).toBe(3);
      expect(await ledger(r.personId)).toHaveLength(1);
      const weaker = await verify(r.roleId, { claim: 'TITLE', evidence: { sourceType: 'WEB_SCRAPING', evidenceType: 'COMPANY_WEBSITE', sourceUrl: 'https://corp.example/about' }, note: 'website again' }).expect(200);
      expect(weaker.body.data.outcome).toBe('ALREADY_VERIFIED');
      expect((await ledger(r.personId))[0].evidenceStrength).toBe(3);
      // earlier evidence rows were preserved
      const ev = await db.select().from(schema.peopleEvidence).where(eq(schema.peopleEvidence.companyPersonId, r.roleId));
      expect(ev.filter((e) => e.evidenceType === 'COMPANY_WEBSITE').length).toBeGreaterThanOrEqual(2);
      const [up1] = await audits(r.roleId, 'PEOPLE_CLAIM_VERIFIED');
      expect(up1.newValues).toMatchObject({ outcome: 'UPGRADED' });
    });

    it('approval does not verify: approving an unverified role leaves every claim unverified', async () => {
      const r = await ingestOne({ email: 'approve.only@corp-verif.co.in' });
      await POST(`${R}/roles/${r.roleId}/approve`, admin.token, {}).expect(200);
      expect(await role(r.roleId)).toMatchObject({ reviewStatus: 'APPROVED', isPublished: true, verificationStatus: 'UNVERIFIED' });
      expect((await panel(r.roleId)).every((c) => c.state === 'UNVERIFIED')).toBe(true);
      expect(await ledger(r.personId)).toHaveLength(0);
    });
  });

  // ================================================================ no downgrade / re-ingestion
  describe('no downgrade and re-ingestion (12-13)', () => {
    it('12. upload -> verify -> approve -> re-upload: same person/role, no duplicates, verification and approval preserved', async () => {
      const r = await ingestOne({ personName: 'Steady Saroja', jobTitle: 'Managing Director', email: 'steady@corp-verif.co.in' });
      const [c] = await contactsOf(r.personId);
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      await verify(r.roleId, { claim: 'RELATIONSHIP', evidence: REGISTRY, note: 'filing' }).expect(200);
      await verify(r.roleId, { claim: 'EMAIL', contactId: c.id, evidence: CALL, note: 'confirmed' }).expect(200);
      await POST(`${R}/roles/${r.roleId}/approve`, admin.token, { publishContactIds: [c.id] }).expect(200);

      const count = async () => ({
        people: (await db.select().from(schema.people)).length,
        roles: (await db.select().from(schema.companyPeople)).length,
        evidence: (await db.select().from(schema.peopleEvidence)).length,
        ledger: (await db.select().from(schema.peopleVerifications)).length,
      });
      const before = await count();
      for (let i = 0; i < 2; i++) {
        const again = await ingestOne({ businessId: r.businessId, personName: 'Steady Saroja', jobTitle: 'Managing Director', email: 'steady@corp-verif.co.in' });
        expect(again.roleId).toBe(r.roleId);
      }
      expect(await count()).toEqual(before);
      expect(await role(r.roleId)).toMatchObject({ verificationStatus: 'VERIFIED', reviewStatus: 'APPROVED', isPublished: true });
      expect((await contactsOf(r.personId))[0]).toMatchObject({ verificationStatus: 'VERIFIED', isPublished: true });
      expect((await panel(r.roleId)).filter((x) => x.state === 'VERIFIED').map((x) => x.claim).sort()).toEqual(['EMAIL', 'RELATIONSHIP', 'TITLE']);
    });

    it('11/H. weaker or different input never downgrades: same title with UNVERIFIED input; a different title becomes its own PENDING role', async () => {
      const r = await ingestOne({ personName: 'Nodown Nalini', jobTitle: 'CEO', confidenceScore: 10 });
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      await verify(r.roleId, { claim: 'RELATIONSHIP', evidence: REGISTRY, note: 'filing' }).expect(200);
      const strong = await role(r.roleId);

      await ingestOne({ businessId: r.businessId, personName: 'Nodown Nalini', jobTitle: 'CEO', confidenceScore: 1 });
      const founder = await ingestOne({ businessId: r.businessId, personName: 'Nodown Nalini', jobTitle: 'Founder' });
      expect(founder.roleId).not.toBe(r.roleId);
      const after = await role(r.roleId);
      expect(after.verificationStatus).toBe('VERIFIED');
      expect(after.confidenceScore).toBe(strong.confidenceScore);
      expect((await claim(r.roleId, 'TITLE')).state).toBe('VERIFIED');
      expect(await role(founder.roleId)).toMatchObject({ verificationStatus: 'UNVERIFIED', reviewStatus: 'PENDING', isPublished: false });
      expect((await claim(founder.roleId, 'TITLE')).state).toBe('UNVERIFIED');
    });

    it('a dispute is not cleared by a re-upload; only a reviewer verifying again resolves it', async () => {
      const r = await ingestOne({ personName: 'Dispute Devika', jobTitle: 'Director' });
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      const d = await POST(`${V}/roles/${r.roleId}/dispute`, admin.token, { claim: 'TITLE', note: 'a later filing shows she resigned' }).expect(200);
      expect(d.body.data).toMatchObject({ outcome: 'DISPUTED', state: 'DISPUTED' });
      expect((await role(r.roleId)).verificationStatus).toBe('CONFLICTED');
      expect((await audits(r.roleId, 'PEOPLE_CLAIM_DISPUTED'))[0].oldValues).toMatchObject({ claim: 'TITLE', state: 'VERIFIED' });

      await ingestOne({ businessId: r.businessId, personName: 'Dispute Devika', jobTitle: 'Director' });
      expect((await role(r.roleId)).verificationStatus).toBe('CONFLICTED');
      expect((await claim(r.roleId, 'TITLE')).state).toBe('DISPUTED');
      // disputing twice is a no-op
      expect((await POST(`${V}/roles/${r.roleId}/dispute`, admin.token, { claim: 'TITLE', note: 'again' }).expect(200)).body.data.outcome).toBe('ALREADY_DISPUTED');

      const fix = await verify(r.roleId, { claim: 'TITLE', evidence: { ...REGISTRY, sourceReference: 'SRN-newer' }, note: 'the resignation was reversed' }).expect(200);
      expect(fix.body.data.outcome).toBe('DISPUTE_RESOLVED');
      expect((await role(r.roleId)).verificationStatus).toBe('PARTIALLY_VERIFIED');
    });

    it('an old verification is reported STALE (computed, never silently VERIFIED)', async () => {
      const r = await ingestOne();
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      await db.update(schema.peopleVerifications).set({ verifiedAt: new Date(Date.now() - 400 * 86_400_000) }).where(eq(schema.peopleVerifications.personId, r.personId));
      expect((await claim(r.roleId, 'TITLE')).state).toBe('STALE');
    });
  });

  // ================================================================ reviewer edit after verification
  describe('reviewer edit after verification (13)', () => {
    it('editing a verified title marks it NEEDS_REVIEW and lowers the role status; verifying the new title makes it authoritative against the old upload', async () => {
      const r = await ingestOne({ personName: 'Edited Eshwar', jobTitle: 'CEO' });
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      await verify(r.roleId, { claim: 'RELATIONSHIP', evidence: REGISTRY, note: 'filing' }).expect(200);
      expect((await role(r.roleId)).verificationStatus).toBe('VERIFIED');

      const edit = await PATCH(`${R}/roles/${r.roleId}`, admin.token, { reason: 'registry says Managing Director', jobTitle: 'Managing Director' }).expect(200);
      expect(edit.body.data.invalidatedClaims).toEqual(['TITLE']);
      const c = await claim(r.roleId, 'TITLE');
      expect(c).toMatchObject({ state: 'NEEDS_REVIEW', previousValue: 'ceo' });
      expect((await role(r.roleId)).verificationStatus).toBe('PARTIALLY_VERIFIED'); // relationship still stands
      expect((await audits(r.roleId, 'PEOPLE_CLAIM_NEEDS_REVIEW'))).toHaveLength(1);

      await verify(r.roleId, { claim: 'TITLE', evidence: { ...REGISTRY, sourceReference: 'SRN-md' }, note: 'new filing confirms MD' }).expect(200);
      expect((await claim(r.roleId, 'TITLE')).state).toBe('VERIFIED');
      expect((await role(r.roleId)).verificationStatus).toBe('VERIFIED');

      // the old upload reappears: same role, reviewer-verified title untouched, nothing downgraded
      const back = await ingestOne({ businessId: r.businessId, personName: 'Edited Eshwar', jobTitle: 'CEO' });
      expect(back.roleId).toBe(r.roleId);
      expect(await role(r.roleId)).toMatchObject({ jobTitleAtCompany: 'Managing Director', verificationStatus: 'VERIFIED' });
      expect((await claim(r.roleId, 'TITLE')).state).toBe('VERIFIED');
      expect((await db.select().from(schema.companyPeople).where(eq(schema.companyPeople.personId, r.personId)))).toHaveLength(1);
    });

    it('correcting a verified name asks for identity re-verification', async () => {
      const r = await ingestOne({ personName: 'Nameless Nikhil' });
      await verify(r.roleId, { claim: 'IDENTITY', evidence: REGISTRY, note: 'filing' }).expect(200);
      const edit = await PATCH(`${R}/roles/${r.roleId}`, admin.token, { reason: 'spelling per filing', fullName: 'Nikhil Nameless' }).expect(200);
      expect(edit.body.data.invalidatedClaims).toContain('IDENTITY');
      expect((await claim(r.roleId, 'IDENTITY')).state).toBe('NEEDS_REVIEW');
    });

    it('editing something unrelated (e.g. adding evidence) does not touch verification', async () => {
      const r = await ingestOne();
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      const edit = await PATCH(`${R}/roles/${r.roleId}`, admin.token, { reason: 'extra source', addEvidence: [{ sourceType: 'WEB_SCRAPING', evidenceType: 'COMPANY_WEBSITE', sourceUrl: 'https://x.example/team' }] }).expect(200);
      expect(edit.body.data.invalidatedClaims).toEqual([]);
      expect((await claim(r.roleId, 'TITLE')).state).toBe('VERIFIED');
    });
  });

  // ================================================================ RBAC / audit / leakage
  describe('access control (14-15)', () => {
    it('14. customers get 403 and anonymous callers 401 on every verification route; verification routes are not on customer controllers', async () => {
      const r = await ingestOne();
      const routes: Array<[string, string]> = [['GET', `${V}/roles/${r.roleId}`], ['POST', `${V}/roles/${r.roleId}/verify`], ['POST', `${V}/roles/${r.roleId}/dispute`]];
      for (const [m, url] of routes) {
        const call = (t?: string) => (m === 'GET' ? GET(url, t) : POST(url, t, { claim: 'TITLE', evidence: REGISTRY, note: 'attempt' }));
        expect((await call(customer.token)).status).toBe(403);
        expect((await call()).status).toBe(401);
      }
      expect(await ledger(r.personId)).toHaveLength(0);
      const customerController = fs.readFileSync(path.resolve(SRC_DIR, 'modules/people/people.controller.ts'), 'utf8');
      expect(customerController).not.toMatch(/people-verification|\/verify|\/dispute/);
    });

    it('15. DATA_MANAGER can read the panel but not verify or dispute; ADMIN and SUPER_ADMIN can', async () => {
      const r = await ingestOne();
      expect((await GET(`${V}/roles/${r.roleId}`, dataManager.token)).status).toBe(200);
      expect((await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'dm attempt' }, dataManager.token)).status).toBe(403);
      expect((await POST(`${V}/roles/${r.roleId}/dispute`, dataManager.token, { claim: 'TITLE', note: 'dm attempt' })).status).toBe(403);
      expect(await ledger(r.personId)).toHaveLength(0);
      expect((await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'super admin ok' }, superAdmin.token)).status).toBe(200);
      expect((await ledger(r.personId))[0].verifiedById).toBe(superAdmin.id);
      expect((await verify(r.roleId, { claim: 'RELATIONSHIP', evidence: REGISTRY, note: 'admin ok' })).status).toBe(200);
    });

    it('the reviewer detail includes the verification panel (one fetch)', async () => {
      const r = await ingestOne({ email: 'detail.panel@corp-verif.co.in' });
      const d = (await GET(`${R}/roles/${r.roleId}`, dataManager.token).expect(200)).body.data;
      expect(d.verification.map((c: any) => c.claim).sort()).toEqual(['EMAIL', 'IDENTITY', 'RELATIONSHIP', 'TITLE']);
      expect(d.verification.every((c: any) => c.state === 'UNVERIFIED')).toBe(true);
      // the company relationship is shown by company NAME, not the raw id (both the embedded panel and the verification route)
      const rel = d.verification.find((c: any) => c.claim === 'RELATIONSHIP');
      expect(rel.displayValue).toBe(d.company.name);
      expect(rel.displayValue).not.toBe(r.businessId);
      expect((await panel(r.roleId)).find((c: any) => c.claim === 'RELATIONSHIP').displayValue).toBe(d.company.name);
    });
  });

  describe('audit (16) and customer contract (17)', () => {
    it('16. every verification action leaves an audit row: action, target, reviewer, previous/new state, evidence reference', async () => {
      const r = await ingestOne({ email: 'audit.me@corp-verif.co.in' });
      const [c] = await contactsOf(r.personId);
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing lists the title' }).expect(200);
      await verify(r.roleId, { claim: 'IDENTITY', evidence: REGISTRY, note: 'filing lists the name' }).expect(200);
      await verify(r.roleId, { claim: 'EMAIL', contactId: c.id, evidence: CALL, note: 'confirmed by call' }).expect(200);

      const [t] = await audits(r.roleId, 'PEOPLE_CLAIM_VERIFIED');
      expect(t).toMatchObject({ entityType: 'PEOPLE_ROLE', userId: admin.id });
      expect(t.oldValues).toMatchObject({ claim: 'TITLE', state: 'UNVERIFIED' });
      expect(t.newValues).toMatchObject({
        claim: 'TITLE', state: 'VERIFIED', outcome: 'VERIFIED', evidenceType: 'REGISTRY_FILING', evidenceReference: 'MCA filing SRN-778',
        reviewedBy: admin.email, reason: 'filing lists the title', personId: r.personId, companyId: r.businessId,
      });
      expect(t.newValues).toHaveProperty('evidenceId');
      const [i] = await audits(r.personId, 'PEOPLE_CLAIM_VERIFIED');
      expect(i).toMatchObject({ entityType: 'PEOPLE_PERSON' });
      const [e] = await audits(c.id, 'PEOPLE_CLAIM_VERIFIED');
      expect(e).toMatchObject({ entityType: 'PEOPLE_CONTACT' });
      // and the reviewer detail shows them
      const detail = (await GET(`${R}/roles/${r.roleId}`, admin.token).expect(200)).body.data;
      expect(detail.auditTrail.filter((a: any) => a.action === 'PEOPLE_CLAIM_VERIFIED')).toHaveLength(3);
    });

    it('17. customers see the improved data quality but none of the verification internals', async () => {
      const r = await ingestOne({ personName: 'Public Padma', jobTitle: 'CEO', email: 'padma.public@corp-verif.co.in', linkedinUrl: 'https://www.linkedin.com/in/verified-person-1x' });
      const [c] = await contactsOf(r.personId);
      await verify(r.roleId, { claim: 'TITLE', evidence: { ...REGISTRY, sourceReference: 'SECRET-INTERNAL-FILING-4471', sourceUrl: 'https://registry.internal.example/filing/4471' }, note: 'internal reviewer note XYZ' }).expect(200);
      await verify(r.roleId, { claim: 'RELATIONSHIP', evidence: REGISTRY, note: 'officer' }).expect(200);
      await verify(r.roleId, { claim: 'EMAIL', contactId: c.id, evidence: CALL, note: 'confirmed' }).expect(200);
      expect(await custList(r.businessId)).toEqual([]); // verified is not published

      await POST(`${R}/roles/${r.roleId}/approve`, admin.token, { publishContactIds: [c.id] }).expect(200);
      const res = await GET(`/companies/${r.businessId}/people?status=all`, customer.token).expect(200);
      const text = JSON.stringify(res.body);
      const card = res.body.data.people[0];
      expect(card.fullName).toBe('Public Padma');
      expect(card.verification.status).toBe('VERIFIED'); // existing contract, improved by reviewer verification
      expect(card.contacts.email.value).toBeNull(); // still locked until unlocked
      for (const leak of ['SECRET-INTERNAL', 'registry.internal.example', 'internal reviewer note', admin.email, 'verifiedBy', 'people_verifications', 'fingerprint', 'auditTrail', 'claimedValue', 'evidenceStrength', 'padma.public@corp-verif', 'NEEDS_REVIEW', 'DISPUTED']) {
        expect(text).not.toContain(leak);
      }
      // a disputed claim is a reviewer matter: the customer still sees no workflow state or reason
      await POST(`${V}/roles/${r.roleId}/dispute`, admin.token, { claim: 'TITLE', note: 'private dispute reason QQQ' }).expect(200);
      const after = JSON.stringify((await GET(`/companies/${r.businessId}/people?status=all`, customer.token).expect(200)).body);
      expect(after).not.toContain('private dispute reason');
      expect(after).not.toContain('SECRET-INTERNAL');
    });
  });

  // ================================================================ single source of truth
  describe('ledger is the source of truth; status columns are derived (cannot diverge)', () => {
    it('every normal flow leaves the status columns consistent with the ledger (checked independently of the production derivation)', async () => {
      const a = await ingestOne({ personName: 'Truth Tara', email: 'truth.tara@corp-verif.co.in' });
      const [c] = await contactsOf(a.personId);
      await verify(a.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      await verify(a.roleId, { claim: 'EMAIL', contactId: c.id, evidence: CALL, note: 'confirmed' }).expect(200);
      await POST(`${V}/roles/${a.roleId}/dispute`, admin.token, { claim: 'RELATIONSHIP', note: 'looks wrong' }).expect(200);
      await PATCH(`${R}/roles/${a.roleId}`, admin.token, { reason: 'retitle', jobTitle: 'Managing Director' }).expect(200);
      await ingestOne({ businessId: a.businessId, personName: 'Truth Tara', jobTitle: 'CEO', email: 'truth.tara@corp-verif.co.in' });
      await PATCH(`${R}/roles/${a.roleId}`, admin.token, { reason: 'new phone', contacts: [{ contactId: c.id, type: 'WORK_EMAIL', value: 'tara.new@corp-verif.co.in', source: { type: 'MANUAL_IMPORT', reference: 'sheet' } }] }).expect(200);
      await expectLedgerConsistent(db);
      expect((await contactsOf(a.personId))[0].verificationStatus).toBe('UNVERIFIED'); // value changed -> not verified any more
    });

    it('the status columns are written only by the reconcile functions (structural)', () => {
      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
      const writers = walk(path.join(SRC_DIR, 'modules'))
        .filter((f) => f.endsWith('.ts'))
        .filter((f) => /\.(set|values)\(\{[^}]*\bverificationStatus\b/s.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(SRC_DIR, f).replace(/\\/g, '/'));
      expect(writers.sort()).toEqual(['modules/people/people-rollup.ts', 'modules/people/verification/verification-state.ts']);
    });

    it('a verified role without a ledger row cannot exist after it is touched (legacy unbacked status is normalised)', async () => {
      const r = await ingestOne();
      await db.update(schema.companyPeople).set({ verificationStatus: 'VERIFIED', lastVerifiedAt: new Date() }).where(eq(schema.companyPeople.id, r.roleId)); // simulate legacy drift
      expect((await collectLedgerViolations(db)).length).toBeGreaterThan(0);
      await ingestOne({ businessId: r.businessId, personName: (await person(r.personId)).fullName, jobTitle: 'CEO' }); // any touch reconciles
      expect((await role(r.roleId)).verificationStatus).toBe('UNVERIFIED');
      await expectLedgerConsistent(db);
    });
  });

  // ================================================================ ingestion-attested verification
  describe('ingestion-attested verification is a SYSTEM event, never a human reviewer', () => {
    const REG_SOURCE = (ref: string) => ({ type: 'GOVERNMENT_REGISTRY', label: 'registry sheet', reference: ref, evidenceType: 'REGISTRY_FILING' });
    const ingestAttested = async (name: string, status: 'VERIFIED' | 'PARTIALLY_VERIFIED', extra: Record<string, unknown> = {}) => {
      const co = await newCompany();
      const r = (await ingest.ingest([{ businessId: co.id, personName: name, jobTitle: 'Director', source: REG_SOURCE('REG-ATT-1'), verification: { status, verifiedAt: new Date(Date.now() - 3 * 86_400_000), verifiedBy: 'source desk' }, ...extra } as any])).results[0];
      return { personId: r.personId!, roleId: r.companyPersonId!, businessId: co.id };
    };

    it('VERIFIED input is recorded as system events for TITLE and RELATIONSHIP with the source, evidence, method and time', async () => {
      const r = await ingestAttested('Attested Anand', 'VERIFIED');
      const rows = await ledger(r.personId);
      expect(rows.map((x) => x.claimType).sort()).toEqual(['RELATIONSHIP', 'TITLE']);
      for (const row of rows) {
        expect(row).toMatchObject({ verifiedByKind: 'SYSTEM', method: 'INGESTION_ATTESTED', verifiedById: null, verifiedByLabel: 'system:ingestion', attestedBy: 'GOVERNMENT_REGISTRY', status: 'VERIFIED' });
        expect(row.evidenceId).toBeTruthy();
        expect(row.verifiedAt.getTime()).toBeLessThan(Date.now());
        expect(row.note).toMatch(/no reviewer involved/);
      }
      expect((await role(r.roleId)).verificationStatus).toBe('VERIFIED');
      const t = await claim(r.roleId, 'TITLE');
      expect(t).toMatchObject({ state: 'VERIFIED', verifiedByKind: 'SYSTEM', method: 'INGESTION_ATTESTED', attestedBy: 'GOVERNMENT_REGISTRY', verifiedBy: 'system:ingestion' });
      await expectLedgerConsistent(db);
    });

    it('PARTIALLY_VERIFIED covers the company relationship only; a claim without verified evidence is not recorded at all', async () => {
      const r = await ingestAttested('Partial Pooja', 'PARTIALLY_VERIFIED');
      expect((await ledger(r.personId)).map((x) => x.claimType)).toEqual(['RELATIONSHIP']);
      expect((await role(r.roleId)).verificationStatus).toBe('PARTIALLY_VERIFIED');

      // a claim that reaches the write service with NO verified evidence is refused and leaves no ledger trace
      const co = await newCompany();
      const bare = await write.upsertPersonForBusiness({ businessId: co.id, person: { fullName: 'Bare Bhaskar' }, role: { jobTitle: 'CEO' }, verificationStatus: 'VERIFIED' });
      expect(bare.warnings).toContain('VERIFICATION_CLAIM_WITHOUT_EVIDENCE');
      expect(await ledger(bare.personId)).toHaveLength(0);
      expect((await role(bare.companyPersonId)).verificationStatus).toBe('UNVERIFIED');
    });

    it('re-ingesting the same attested record adds nothing; a weaker re-upload cannot downgrade it', async () => {
      const r = await ingestAttested('Repeat Ramya', 'VERIFIED');
      const before = (await ledger(r.personId)).length;
      for (let i = 0; i < 2; i++) await ingestOne({ businessId: r.businessId, personName: 'Repeat Ramya', jobTitle: 'Director' });
      expect((await ledger(r.personId)).length).toBe(before);
      expect((await role(r.roleId)).verificationStatus).toBe('VERIFIED');
    });

    it('a system attestation never overrides a reviewer decision; a reviewer can take it over with evidence at least as strong', async () => {
      const r = await ingestAttested('Takeover Tanvi', 'VERIFIED');
      const up = await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'I checked the filing myself' }).expect(200);
      expect(up.body.data.outcome).toBe('UPGRADED');
      const [title] = (await ledger(r.personId)).filter((x) => x.claimType === 'TITLE');
      expect(title).toMatchObject({ verifiedByKind: 'REVIEWER', method: 'REVIEWER_EVIDENCE', verifiedById: admin.id, attestedBy: null });
      // the source now re-reports it: the reviewer's row is untouched
      await ingest.ingest([{ businessId: r.businessId, personName: 'Takeover Tanvi', jobTitle: 'Director', source: REG_SOURCE('REG-ATT-2'), verification: { status: 'VERIFIED', verifiedAt: new Date(), verifiedBy: 'x' } } as any]);
      expect((await ledger(r.personId)).find((x) => x.claimType === 'TITLE')).toMatchObject({ verifiedByKind: 'REVIEWER', verifiedById: admin.id });
    });

    it('a source conflict report flips a system attestation but is ignored (with a warning) against a reviewer decision', async () => {
      const sys = await ingestAttested('Conflict Chandra', 'VERIFIED');
      await ingest.ingest([{ businessId: sys.businessId, personName: 'Conflict Chandra', jobTitle: 'Director', source: REG_SOURCE('REG-ATT-3'), verification: { status: 'CONFLICTED' } } as any]);
      expect((await role(sys.roleId)).verificationStatus).toBe('CONFLICTED');
      expect((await ledger(sys.personId)).every((x) => x.status === 'DISPUTED' && x.verifiedByKind === 'SYSTEM')).toBe(true);

      const rev = await ingestOne({ personName: 'Reviewed Revathi', jobTitle: 'Director' });
      await verify(rev.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      await verify(rev.roleId, { claim: 'RELATIONSHIP', evidence: REGISTRY, note: 'filing' }).expect(200);
      const res = await ingest.ingest([{ businessId: rev.businessId, personName: 'Reviewed Revathi', jobTitle: 'Director', source: REG_SOURCE('REG-ATT-4'), verification: { status: 'CONFLICTED' } } as any]);
      expect(JSON.stringify(res.results[0])).toMatch(/CONFLICT_REPORT_IGNORED_REVIEWER_DECISION/);
      expect((await role(rev.roleId)).verificationStatus).toBe('VERIFIED');
      await expectLedgerConsistent(db);
    });

    it('contact attestation needs verified contact evidence; without it the contact stays unverified with a warning', async () => {
      const co = await newCompany();
      const when = new Date(Date.now() - 86_400_000);
      const noEvidence = await write.upsertPersonForBusiness({
        businessId: co.id, person: { fullName: 'Contact Chitra' }, role: { jobTitle: 'Director' },
        contacts: [{ type: 'WORK_EMAIL', value: 'chitra.a@corp-verif.co.in', verificationStatus: 'VERIFIED', lastVerifiedAt: when }],
      });
      expect(noEvidence.warnings).toContain('CONTACT_VERIFICATION_WITHOUT_EVIDENCE:WORK_EMAIL');
      expect((await contactsOf(noEvidence.personId))[0].verificationStatus).toBe('UNVERIFIED');
      expect(await ledger(noEvidence.personId)).toHaveLength(0);

      const withEvidence = await write.upsertPersonForBusiness({
        businessId: co.id, person: { fullName: 'Contact Chandran' }, role: { jobTitle: 'Director' },
        contacts: [{ type: 'WORK_EMAIL', value: 'chandran@corp-verif.co.in', verificationStatus: 'VERIFIED', lastVerifiedAt: when }],
        evidence: [{ scope: 'CONTACT', contact: { type: 'WORK_EMAIL', value: 'chandran@corp-verif.co.in' }, sourceType: 'GOVERNMENT_REGISTRY', evidenceType: 'DOCUMENT', sourceReference: 'DOC-1', verifiedAt: when } as any],
      });
      const [c] = await contactsOf(withEvidence.personId);
      expect(c.verificationStatus).toBe('VERIFIED');
      const [row] = await ledger(withEvidence.personId);
      expect(row).toMatchObject({ claimType: 'EMAIL', verifiedByKind: 'SYSTEM', method: 'INGESTION_ATTESTED', verifiedById: null, attestedBy: 'GOVERNMENT_REGISTRY' });
      expect(row.claimedValue).toMatch(/^h:[0-9a-f]{64}$/);
      // partial contact verification has no claim to map to: reported, not invented
      const partial = await write.upsertPersonForBusiness({
        businessId: co.id, person: { fullName: 'Contact Chaitra' }, role: { jobTitle: 'Director' },
        contacts: [{ type: 'PHONE', value: '9876500099', verificationStatus: 'PARTIALLY_VERIFIED', lastVerifiedAt: when }],
      });
      expect(partial.warnings).toContain('CONTACT_PARTIAL_VERIFICATION_NOT_RECORDED:PHONE');
      await expectLedgerConsistent(db);
    });

    it('the database refuses a SYSTEM ledger row that names a human account', async () => {
      const r = await ingestOne();
      const base = { claimType: 'TITLE', targetKey: `TITLE:${r.roleId}`, personId: r.personId, companyPersonId: r.roleId, claimedValue: 'x', status: 'VERIFIED', verifiedByLabel: 'system:ingestion', note: 'n' };
      await expect(db.insert(schema.peopleVerifications).values({ ...base, verifiedByKind: 'SYSTEM', verifiedById: admin.id })).rejects.toThrow();
      await expect(db.insert(schema.peopleVerifications).values({ ...base, claimedValue: 'y', method: 'MAGIC' })).rejects.toThrow();
      await db.insert(schema.peopleVerifications).values({ ...base, claimedValue: 'z', verifiedByKind: 'SYSTEM', method: 'INGESTION_ATTESTED' });
    });

    it('customers are never told a person verified anything: no kind, method, source label, system marker or reviewer wording', async () => {
      const r = await ingestAttested('Public Pranav', 'VERIFIED');
      await POST(`${R}/roles/${r.roleId}/approve`, admin.token, {}).expect(200);
      const res = await GET(`/companies/${r.businessId}/people?status=all`, customer.token).expect(200);
      const text = JSON.stringify(res.body);
      expect(res.body.data.people[0].verification.status).toBe('VERIFIED');
      for (const leak of ['system:', 'INGESTION_ATTESTED', 'LEGACY_BACKFILL', 'verifiedByKind', 'attestedBy', 'REVIEWER', 'reviewer', 'REG-ATT-1', 'people_verifications']) {
        expect(text).not.toContain(leak);
      }
    });
  });

  // ================================================================ privacy of the ledger
  describe('the ledger does not duplicate contact data', () => {
    it('email, phone and LinkedIn claims store only a digest; nothing readable lands in the ledger or the audit rows', async () => {
      const r = await ingestOne({ email: 'private.person@corp-verif.co.in', mobile: '9876512345', linkedinUrl: 'https://www.linkedin.com/in/private-person-77' });
      const cs = await contactsOf(r.personId);
      const email = cs.find((c) => c.contactType === 'WORK_EMAIL')!;
      const mobile = cs.find((c) => c.contactType === 'MOBILE')!;
      await verify(r.roleId, { claim: 'EMAIL', contactId: email.id, evidence: CALL, note: 'confirmed by call' }).expect(200);
      await verify(r.roleId, { claim: 'PHONE', contactId: mobile.id, evidence: CALL, note: 'called the number' }).expect(200);
      await verify(r.roleId, { claim: 'LINKEDIN', evidence: PROFILE, note: 'profile matches' }).expect(200);
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);

      const rows = await ledger(r.personId);
      const sensitive = rows.filter((x) => ['EMAIL', 'PHONE', 'LINKEDIN'].includes(x.claimType));
      expect(sensitive).toHaveLength(3);
      for (const row of sensitive) expect(row.claimedValue).toMatch(/^h:[0-9a-f]{64}$/);
      // non-sensitive role-level claims keep the readable value (needed to show "was X" after a change)
      expect(rows.find((x) => x.claimType === 'TITLE')!.claimedValue).toBe('ceo');

      const everything = JSON.stringify(rows) + JSON.stringify((await db.select().from(schema.auditLogs)).filter((a) => [r.roleId, r.personId, email.id, mobile.id].includes(a.entityId!)));
      for (const secret of ['private.person', '9876512345', 'private-person-77']) expect(everything).not.toContain(secret);
      // the API panel is not a leak either, apart from the reviewer-facing current value of the contact itself
      const panelClaims = await panel(r.roleId);
      expect(JSON.stringify(panelClaims.map((c) => c.previousValue))).not.toContain('h:');
    });

    it('editing a verified contact value in place makes it unverified again and never shows the old value', async () => {
      const r = await ingestOne({ email: 'old.value@corp-verif.co.in' });
      const [c] = await contactsOf(r.personId);
      await verify(r.roleId, { claim: 'EMAIL', contactId: c.id, evidence: CALL, note: 'confirmed' }).expect(200);
      await PATCH(`${R}/roles/${r.roleId}`, admin.token, { reason: 'corrected address', contacts: [{ contactId: c.id, type: 'WORK_EMAIL', value: 'new.value@corp-verif.co.in', source: { type: 'MANUAL_IMPORT', reference: 'sheet' } }] }).expect(200);
      const claimView = await claim(r.roleId, 'EMAIL', c.id);
      expect(claimView.state).toBe('NEEDS_REVIEW');
      expect(claimView.previousValue).toBeNull();
      expect((await contactsOf(r.personId))[0].verificationStatus).toBe('UNVERIFIED');
      await expectLedgerConsistent(db);
    });
  });

  // ================================================================ concurrency
  describe('concurrent verification is deterministic', () => {
    it('two simultaneous first verifications of the same claim: one creates, the other sees ALREADY_VERIFIED; no 500, one row, one audit, one evidence row', async () => {
      const r = await ingestOne();
      const body = { claim: 'TITLE', evidence: REGISTRY, note: 'filing' };
      const [a, b] = await Promise.all([verify(r.roleId, body), verify(r.roleId, body)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.data.outcome, b.body.data.outcome].sort()).toEqual(['ALREADY_VERIFIED', 'VERIFIED']);
      expect(await ledger(r.personId)).toHaveLength(1);
      expect(await audits(r.roleId, 'PEOPLE_CLAIM_VERIFIED')).toHaveLength(1);
      expect((await db.select().from(schema.peopleEvidence).where(eq(schema.peopleEvidence.companyPersonId, r.roleId))).filter((e) => e.evidenceType === 'REGISTRY_FILING')).toHaveLength(1);
      await expectLedgerConsistent(db);
    });

    it('losing the race after the existence check (the exact failure window) resolves to ALREADY_VERIFIED, not a unique-violation 500', async () => {
      const r = await ingestOne();
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      const spy = jest.spyOn(service as any, 'ledgerRows').mockResolvedValueOnce([]); // the check saw nothing, but a row now exists
      const res = await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'racing writer' });
      spy.mockRestore();
      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('ALREADY_VERIFIED');
      expect(await ledger(r.personId)).toHaveLength(1);
      expect(await audits(r.roleId, 'PEOPLE_CLAIM_VERIFIED')).toHaveLength(1);
    });

    it('simultaneous verify and dispute end in a coherent state (whichever runs last wins, never a half-written row)', async () => {
      const r = await ingestOne();
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      const [a, b] = await Promise.all([
        POST(`${V}/roles/${r.roleId}/dispute`, admin.token, { claim: 'TITLE', note: 'contested' }),
        verify(r.roleId, { claim: 'TITLE', evidence: { ...REGISTRY, sourceReference: 'SRN-race' }, note: 'more evidence' }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await ledger(r.personId)).toHaveLength(1);
      await expectLedgerConsistent(db);
    });
  });

  // ================================================================ transitions
  describe('state transitions', () => {
    it('claimState is a pure, deterministic function of (ledger, current value, time)', () => {
      const row = (over: Partial<ILedgerRow> = {}): ILedgerRow => ({
        id: 'r', claimType: 'TITLE', targetKey: 'TITLE:x', claimedValue: 'ceo', status: 'VERIFIED', evidenceId: 'e', evidenceStrength: 3,
        verifiedByLabel: 'a@b', verifiedByKind: 'REVIEWER', method: 'REVIEWER_EVIDENCE', attestedBy: null, verifiedAt: new Date('2026-01-01T00:00:00Z'), note: 'n', ...over,
      });
      const day = 86_400_000;
      const at = (d: number) => new Date(new Date('2026-01-01T00:00:00Z').getTime() + d * day);
      const table: Array<[string, ILedgerRow[], string | null, Date, string]> = [
        ['no rows', [], 'ceo', at(1), 'UNVERIFIED'],
        ['no current value', [row()], null, at(1), 'UNVERIFIED'],
        ['verified, fresh', [row()], 'ceo', at(1), 'VERIFIED'],
        ['verified, exactly 365 days', [row()], 'ceo', at(365), 'VERIFIED'],
        ['verified, 366 days', [row()], 'ceo', at(366), 'STALE'],
        ['value changed', [row()], 'cfo', at(1), 'NEEDS_REVIEW'],
        ['value changed back', [row(), row({ id: 's', claimedValue: 'cfo', verifiedAt: at(2) })], 'ceo', at(3), 'VERIFIED'],
        ['disputed', [row({ status: 'DISPUTED' })], 'ceo', at(1), 'DISPUTED'],
        ['disputed beats age', [row({ status: 'DISPUTED' })], 'ceo', at(900), 'DISPUTED'],
        ['other value disputed, current unverified', [row({ status: 'DISPUTED', claimedValue: 'cfo' })], 'ceo', at(1), 'NEEDS_REVIEW'],
      ];
      for (const [name, rows, value, when, expected] of table) expect({ name, state: claimState(rows, value, when).state }).toEqual({ name, state: expected });
      // the stored-column view ignores age: STALE is a read-time state only
      expect(claimState([row()], 'ceo', at(900), { ignoreAge: true }).state).toBe('VERIFIED');
    });

    it('VERIFIED -> value edited -> NEEDS_REVIEW -> edited back -> VERIFIED again (the original evidence still stands)', async () => {
      const r = await ingestOne({ personName: 'Flip Flora', jobTitle: 'CEO' });
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      await PATCH(`${R}/roles/${r.roleId}`, admin.token, { reason: 'try', jobTitle: 'Managing Director' }).expect(200);
      expect((await claim(r.roleId, 'TITLE')).state).toBe('NEEDS_REVIEW');
      await PATCH(`${R}/roles/${r.roleId}`, admin.token, { reason: 'revert', jobTitle: 'CEO' }).expect(200);
      expect((await claim(r.roleId, 'TITLE')).state).toBe('VERIFIED');
      expect((await role(r.roleId)).verificationStatus).toBe('PARTIALLY_VERIFIED');
      await expectLedgerConsistent(db);
    });

    it('NEEDS_REVIEW -> verify the new value -> VERIFIED, and the old decision stays as history', async () => {
      const r = await ingestOne({ personName: 'History Hema', jobTitle: 'CEO' });
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      await PATCH(`${R}/roles/${r.roleId}`, admin.token, { reason: 'change', jobTitle: 'Managing Director' }).expect(200);
      await verify(r.roleId, { claim: 'TITLE', evidence: { ...REGISTRY, sourceReference: 'SRN-md' }, note: 'new filing' }).expect(200);
      expect((await ledger(r.personId)).map((x) => x.claimedValue).sort()).toEqual(['ceo', 'managing director']);
      expect((await claim(r.roleId, 'TITLE')).state).toBe('VERIFIED');
    });

    it('STALE -> fresh evidence of the same strength renews it (REFRESHED); before that it is not silently VERIFIED', async () => {
      const r = await ingestOne();
      await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'filing' }).expect(200);
      await db.update(schema.peopleVerifications).set({ verifiedAt: new Date(Date.now() - 400 * 86_400_000) }).where(eq(schema.peopleVerifications.personId, r.personId));
      expect((await claim(r.roleId, 'TITLE')).state).toBe('STALE');
      const res = await verify(r.roleId, { claim: 'TITLE', evidence: { ...REGISTRY, sourceReference: 'SRN-renew' }, note: 'checked again' }).expect(200);
      expect(res.body.data.outcome).toBe('REFRESHED');
      expect((await claim(r.roleId, 'TITLE')).state).toBe('VERIFIED');
    });

    it('DISPUTED stays DISPUTED through a re-upload (reviewer dispute, system attestation, and a contact); it resolves only with valid evidence', async () => {
      const r = await ingestOne({ personName: 'Sticky Sarita', jobTitle: 'Director', email: 'sticky@corp-verif.co.in' });
      const [c] = await contactsOf(r.personId);
      await verify(r.roleId, { claim: 'EMAIL', contactId: c.id, evidence: CALL, note: 'confirmed' }).expect(200);
      await POST(`${V}/roles/${r.roleId}/dispute`, admin.token, { claim: 'EMAIL', contactId: c.id, note: 'bounced later' }).expect(200);
      await POST(`${V}/roles/${r.roleId}/dispute`, admin.token, { claim: 'TITLE', note: 'contested' }).expect(200);
      for (let i = 0; i < 2; i++) await ingestOne({ businessId: r.businessId, personName: 'Sticky Sarita', jobTitle: 'Director', email: 'sticky@corp-verif.co.in' });
      expect((await claim(r.roleId, 'EMAIL', c.id)).state).toBe('DISPUTED');
      expect((await claim(r.roleId, 'TITLE')).state).toBe('DISPUTED');
      expect((await role(r.roleId)).verificationStatus).toBe('CONFLICTED');

      // invalid evidence does not resolve it
      await verify(r.roleId, { claim: 'TITLE', evidence: { sourceType: 'MANUAL_IMPORT', evidenceType: 'ROLE_CLAIM', sourceReference: 'the upload' }, note: 'upload again' }).expect(400);
      await verify(r.roleId, { claim: 'TITLE' , note: 'no evidence' }).expect(400);
      expect((await claim(r.roleId, 'TITLE')).state).toBe('DISPUTED');
      // valid evidence does
      const fix = await verify(r.roleId, { claim: 'TITLE', evidence: REGISTRY, note: 'dispute settled' }).expect(200);
      expect(fix.body.data.outcome).toBe('DISPUTE_RESOLVED');
      expect((await claim(r.roleId, 'TITLE')).state).toBe('VERIFIED');
      expect((await role(r.roleId)).verificationStatus).toBe('PARTIALLY_VERIFIED');
      await expectLedgerConsistent(db);
    });
  });

  // ================================================================ structural guarantees
  describe('structure', () => {
    it('ingestion and the import module reach the ledger only through recordSystemAttestation (which can only write SYSTEM events)', () => {
      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
      const offenders = [...walk(path.join(SRC_DIR, 'modules/import')), ...walk(path.join(SRC_DIR, 'modules/people/ingestion')), path.join(SRC_DIR, 'modules/people/people-write.service.ts')]
        .filter((f) => f.endsWith('.ts'))
        .filter((f) => /peopleVerifications|people_verifications/.test(fs.readFileSync(f, 'utf8')));
      expect(offenders).toEqual([]);
      const state = fs.readFileSync(path.join(SRC_DIR, 'modules/people/verification/verification-state.ts'), 'utf8');
      const fn = state.slice(state.indexOf('export async function recordSystemAttestation'));
      expect(fn).toMatch(/verifiedByKind: 'SYSTEM'/);
      expect(fn).toMatch(/verifiedById: null/);
      expect(fn).not.toMatch(/REVIEWER'?,?\s*$/m);
    });

    it('verification never touches publication columns', () => {
      const src = fs.readFileSync(path.join(SRC_DIR, 'modules/people/verification/people-verification.service.ts'), 'utf8');
      // it may READ dataStatus (to refuse suppressed people) but must never write a publication column
      expect(src).not.toMatch(/\.set\(\{[^}]*(isPublished|reviewStatus|dataStatus)/s);
      expect(src).not.toMatch(/publishRole|publishContact|approve/);
    });

    it('the ledger enforces one row per (target, value) and only known claim/status values', async () => {
      const r = await ingestOne();
      const base = { claimType: 'TITLE', targetKey: `TITLE:${r.roleId}`, personId: r.personId, companyPersonId: r.roleId, claimedValue: 'some other title', status: 'VERIFIED', verifiedByLabel: 'x', note: 'n' };
      await db.insert(schema.peopleVerifications).values(base);
      await expect(db.insert(schema.peopleVerifications).values(base)).rejects.toThrow();
      await expect(db.insert(schema.peopleVerifications).values({ ...base, claimedValue: 'cto', status: 'MAYBE' })).rejects.toThrow();
      await expect(db.insert(schema.peopleVerifications).values({ ...base, claimedValue: 'cfo', claimType: 'IS_VERIFIED' })).rejects.toThrow();
      // cascades with the person
      await db.execute(sql`DELETE FROM people WHERE id = ${r.personId}`);
      expect(await ledger(r.personId)).toHaveLength(0);
    });
  });
});
