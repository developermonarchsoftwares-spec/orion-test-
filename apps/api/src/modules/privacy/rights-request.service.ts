import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { asc, eq, inArray, notInArray, and, sql } from 'drizzle-orm';
import { BusinessException } from '../../common/errors/business.exception';
import { AuditLogService } from '../../common/services/audit-log.service';
import { DRIZZLE_DATABASE } from '../../database/database.constants';
import { DrizzleDb } from '../../database/database.provider';
import * as s from '../../database/schema';
import { MailService } from '../../auth/mail/mail.service';
import { oauthFrontendUrl } from '../oauth/oauth-urls';
import { ContactSuppressionService } from './contact-suppression.service';
import { REQUEST_DEADLINE_MS, RIGHTS_REQUEST_TYPES } from './privacy.config';
import { CreateRightsRequestDto } from './dto/rights-request.dto';
import { IRequestContext } from './privacy.service';

/** Types that need the requester to say what is wrong or what they want, so an empty request is refused. */
const NEEDS_DETAILS = new Set(['CORRECTION', 'GRIEVANCE', 'NOMINATION']);
/** How long the e-mailed confirmation link works. */
const VERIFY_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const REFERENCE_ALPHABET ='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const newReference = () => {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length];
  return `DR-${out}`;
};

export interface IRightsRequestReceipt {
  accepted: true;
  /** Null when an identical request from this address is already open: it carries on, and no second ticket is created. */
  reference: string | null;
  dueAt: string | null;
}

/**
 * Public intake for Data Principal requests (DPDP Act): access, correction, erasure, withdrawal of consent, grievance and nomination.
 * Rows go into `data_subject_requests` (migration 0024) so one queue holds every privacy request. The row keeps the requester's contact
 * e-mail only so the request can be answered; the table's existing retention clears it when the request ends.
 *
 * What this does NOT do: verify who the requester is, or act on the request. A person reviews it (evidence stays NONE until they do).
 */
@Injectable()
export class RightsRequestService {
  private readonly logger = new Logger(RightsRequestService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: DrizzleDb,
    @Optional() private readonly audit?: AuditLogService,
    @Optional() private readonly mail?: MailService,
    @Optional() private readonly suppression?: ContactSuppressionService,
  ) {}

  async create(dto: CreateRightsRequestDto, ctx: IRequestContext): Promise<IRightsRequestReceipt> {
    if (!(RIGHTS_REQUEST_TYPES as readonly string[]).includes(dto.type)) throw new BusinessException('Unknown request type', 'INVALID_REQUEST_TYPE');
    const details = (dto.details ?? '').trim();
    if (NEEDS_DETAILS.has(dto.type) && details.length < 10) {
      throw new BusinessException('Please describe your request in a few words (at least 10 characters).', 'DETAILS_REQUIRED');
    }

    const email = dto.email.trim().toLowerCase();
    // the same digest function the contact-suppression register uses, so a later suppression can be matched to this request
    const res: any = await this.db.execute(sql`SELECT orion_contact_digest('EMAIL', ${email}) AS d`);
    const digest: string | undefined = (Array.isArray(res) ? res : res?.rows ?? [])[0]?.d;
    if (!digest) throw new BusinessException('Enter a valid e-mail address.', 'INVALID_EMAIL');

    const now = new Date();
    const dueAt = new Date(now.getTime() + REQUEST_DEADLINE_MS);
    const reference = newReference();
    // The secret goes only to the requester's mailbox. For an ERASURE request it is the proof of control of that address: opening the link is
    // what lets the request be applied. For the other types it is generated and never used (tokenHash is NOT NULL in the table).
    const token = randomBytes(24).toString('base64url');
    const tokenHash = sha256(token);

    try {
      await this.db.insert(s.dataSubjectRequests).values({
        reference,
        tokenHash,
        type: dto.type,
        subjectKind: 'EMAIL',
        subjectDigest: digest,
        requesterRole: 'SUBJECT',
        evidence: 'NONE',
        contactEmail: email,
        details: details || null,
        requesterNote: `${dto.relationship}: ${dto.name.trim()}`.slice(0, 500),
        dueAt,
      });
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
      if (code === '23505') return { accepted: true, reference: null, dueAt: null }; // an identical request is already open
      throw e;
    }

    await this.audit?.record({
      action: 'DPDP_RIGHTS_REQUEST',
      entityType: 'data_subject_request',
      entityId: reference,
      newValues: { type: dto.type, relationship: dto.relationship },
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });

    // The confirmation token travels in the URL fragment, so it is never sent to a server or written to a log by the link click itself
    const base = oauthFrontendUrl(process.env);
    const confirmLink = dto.type === 'ERASURE' && base ? `${base}/data-rights/verify?ref=${reference}#token=${token}` : null;
    const erasureStep =
      dto.type !== 'ERASURE'
        ? ''
        : confirmLink
          ? `To remove this e-mail address from Orion, confirm that it is yours by opening this link within 7 days:\n${confirmLink}\nNothing is removed until you do.\n\n`
          : 'We will write to you to confirm that this address is yours before anything is removed.\n\n';
    if (this.mail) {
      const sent = await this.mail
        .sendChecked({
          to: email,
          subject: `We received your request (${reference})`,
          text:
            `Hello ${dto.name.trim()},\n\nWe received your ${dto.type.toLowerCase()} request under India's Digital Personal Data Protection Act.\n` +
            `Reference: ${reference}\nWe will respond by ${dueAt.toISOString().slice(0, 10)}. We may ask you to confirm your identity first.\n\n` +
            erasureStep +
            `If you did not make this request, ignore this message.\n`,
          sensitive: confirmLink !== null, // the body holds a secret link: it is never written to the log
        })
        .catch(() => false);
      if (!sent) this.logger.warn(`Acknowledgement e-mail for ${reference} was not sent`);
    }
    return { accepted: true, reference, dueAt: dueAt.toISOString() };
  }

  /**
   * Confirms an ERASURE request with the secret e-mailed to the address, then applies it: the address is registered in the contact
   * suppression register and removed from company contacts (ContactSuppressionService, which also expires stored exports that held it).
   * People records are NOT changed here: a person is suppressed only by a reviewer (PeoplePublishingService.suppressPerson), so when the
   * address matches a person's contact the request stays APPROVED with the count for that reviewer; otherwise it is COMPLETED and the
   * requester's address and free text are cleared. Opening the link twice is harmless. Every refusal answers the same way.
   */
  async verifyErasure(reference: string, token: string, ctx: IRequestContext): Promise<{ verified: true; completed: boolean }> {
    const refuse = () => new BusinessException('This confirmation link is not valid or has expired.', 'INVALID_CONFIRMATION', 400);
    if (typeof reference !== 'string' || typeof token !== 'string' || reference.length > 20 || token.length > 200) throw refuse();
    const [row] = await this.db.select().from(s.dataSubjectRequests).where(eq(s.dataSubjectRequests.reference, reference)).limit(1);
    if (!row || row.type !== 'ERASURE') throw refuse();
    const given = Buffer.from(sha256(token), 'hex');
    const stored = Buffer.from(row.tokenHash, 'hex');
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw refuse();
    if (row.verifiedAt) return { verified: true, completed: row.status === 'COMPLETED' }; // second click: nothing more to do
    if (Date.now() - row.createdAt.getTime() > VERIFY_LINK_TTL_MS) throw refuse();
    if (!row.contactEmail) throw refuse();

    // claim it once: a concurrent second click does nothing
    const claimed = await this.db
      .update(s.dataSubjectRequests)
      .set({ verifiedAt: new Date(), evidence: 'EMAIL_CONTROL', status: 'VALIDATING', updatedAt: new Date() })
      .where(and(eq(s.dataSubjectRequests.id, row.id), sql`${s.dataSubjectRequests.verifiedAt} IS NULL`))
      .returning({ id: s.dataSubjectRequests.id });
    if (!claimed.length) return { verified: true, completed: false };

    const email = row.contactEmail;
    let applied = { contactsRemoved: 0, fieldsCleared: 0, storedExportsExpired: 0 };
    if (this.suppression) {
      const r = await this.suppression.suppress({ kind: 'EMAIL', value: email, scope: 'CONTACT', reasonCode: 'REMOVAL', requestId: row.id });
      applied = { contactsRemoved: r.contactsRemoved, fieldsCleared: r.fieldsCleared, storedExportsExpired: r.storedExportsExpired };
    }
    const found: any = await this.db.execute(
      sql`SELECT count(DISTINCT person_id)::int AS n FROM person_contacts WHERE contact_type = 'WORK_EMAIL' AND normalized_value = lower(${email})`,
    );
    const peopleMatched: number = (Array.isArray(found) ? found : found?.rows ?? [])[0]?.n ?? 0;
    const completed = peopleMatched === 0 && !!this.suppression;

    await this.db
      .update(s.dataSubjectRequests)
      .set({
        status: completed ? 'COMPLETED' : 'APPROVED',
        appliedAt: this.suppression ? new Date() : null,
        completedAt: completed ? new Date() : null,
        resultSummary: { ...applied, peopleMatchedForReview: peopleMatched },
        // an ended request keeps no contact address or free text
        ...(completed ? { contactEmail: null, details: null, requesterNote: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.dataSubjectRequests.id, row.id));
    await this.audit?.record({
      action: 'DPDP_ERASURE_CONFIRMED',
      entityType: 'data_subject_request',
      entityId: reference,
      newValues: { ...applied, peopleMatchedForReview: peopleMatched, completed },
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { verified: true, completed };
  }

  /** Open rights requests, soonest deadline first (admin queue). */
  async listOpen() {
    return this.db
      .select({
        reference: s.dataSubjectRequests.reference,
        type: s.dataSubjectRequests.type,
        status: s.dataSubjectRequests.status,
        contactEmail: s.dataSubjectRequests.contactEmail,
        requesterNote: s.dataSubjectRequests.requesterNote,
        details: s.dataSubjectRequests.details,
        dueAt: s.dataSubjectRequests.dueAt,
        createdAt: s.dataSubjectRequests.createdAt,
      })
      .from(s.dataSubjectRequests)
      .where(and(inArray(s.dataSubjectRequests.type, [...RIGHTS_REQUEST_TYPES]), notInArray(s.dataSubjectRequests.status, ['COMPLETED', 'REJECTED'])))
      .orderBy(asc(s.dataSubjectRequests.dueAt))
      .limit(500);
  }
}
