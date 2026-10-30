import { randomBytes, createHash } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { asc, inArray, notInArray, and, sql } from 'drizzle-orm';
import { BusinessException } from '../../common/errors/business.exception';
import { AuditLogService } from '../../common/services/audit-log.service';
import { DRIZZLE_DATABASE } from '../../database/database.constants';
import { DrizzleDb } from '../../database/database.provider';
import * as s from '../../database/schema';
import { MailService } from '../../auth/mail/mail.service';
import { REQUEST_DEADLINE_MS, RIGHTS_REQUEST_TYPES } from './privacy.config';
import { CreateRightsRequestDto } from './dto/rights-request.dto';
import { IRequestContext } from './privacy.service';

/** Types that need the requester to say what is wrong or what they want, so an empty request is refused. */
const NEEDS_DETAILS = new Set(['CORRECTION', 'GRIEVANCE', 'NOMINATION']);
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
    // tokenHash is NOT NULL in the table; no status page exists yet, so the secret is generated, hashed and never shown or sent
    const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex');

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

    if (this.mail) {
      const sent = await this.mail
        .sendChecked({
          to: email,
          subject: `We received your request (${reference})`,
          text:
            `Hello ${dto.name.trim()},\n\nWe received your ${dto.type.toLowerCase()} request under India's Digital Personal Data Protection Act.\n` +
            `Reference: ${reference}\nWe will respond by ${dueAt.toISOString().slice(0, 10)}. We may ask you to confirm your identity first.\n\n` +
            `If you did not make this request, ignore this message.\n`,
        })
        .catch(() => false);
      if (!sent) this.logger.warn(`Acknowledgement e-mail for ${reference} was not sent`);
    }
    return { accepted: true, reference, dueAt: dueAt.toISOString() };
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
