import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessException } from '../../common/errors/business.exception';
import { AuditLogService } from '../../common/services/audit-log.service';
import { auditValues } from '../../common/services/audit-values';
import { DRIZZLE_DATABASE } from '../../database/database.constants';
import { DrizzleDb } from '../../database/database.provider';
import { UserRepository } from '../../modules/user/user.repository';
import { MailService } from '../mail/mail.service';
import {
  EMAIL_OTP_DAILY_LIMIT_PER_EMAIL,
  EMAIL_OTP_HOURLY_LIMIT_PER_IP,
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_PROOF_TTL_SECONDS,
  EMAIL_OTP_PURPOSES,
  EMAIL_OTP_RESEND_COOLDOWN_SECONDS,
  EMAIL_OTP_TTL_SECONDS,
  EmailOtpPurpose,
  generateOtp,
  hashClientAddress,
  hashEmailOtp,
  maskEmail,
  newProof,
  normalizeEmail,
  normalizeOtp,
  parseProof,
  safeEqualHex,
} from '../email-otp.util';
import { buildEmailOtpMail, buildExistingAccountMail } from '../mail/email-otp.mail';
import * as crypto from 'crypto';

export const GENERIC_OTP_SENT_MESSAGE = 'If this email can be used for verification, a 6-digit code has been sent.';

export interface IOtpContext {
  ipAddress?: string;
  userAgent?: string;
}

type Q = Pick<DrizzleDb, 'execute'>;

/**
 * Sign-up e-mail ownership check.
 *
 *  send   -> a fresh six-digit code is e-mailed to the exact address typed; only its keyed hash is stored. Sending again replaces the earlier code.
 *            The answer is identical for an address that already has an account: no code is sent to it, a decoy row keeps the cooldown and
 *            daily limits identical, and nothing in the answer says which case it was.
 *  verify -> the newest live code for the address is tried. Each try is counted BEFORE it is compared, in one atomic statement, so parallel
 *            requests cannot get more than the allowed number of guesses. A correct code is consumed in the same statement that accepts it and
 *            yields a one-time proof.
 *  consumeProof -> called by registration inside the transaction that creates the account: the proof is single use, bound to the address.
 *
 * Nothing here trusts the browser: validity lives only in `email_otp_challenges`.
 */
@Injectable()
export class EmailOtpService {
  private readonly logger = new Logger(EmailOtpService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: DrizzleDb,
    private readonly userRepo: UserRepository,
    private readonly mail: MailService,
    @Optional() private readonly audit?: AuditLogService,
  ) {}

  private purposeOf(raw: unknown): EmailOtpPurpose {
    const p = typeof raw === 'string' && raw ? raw.toUpperCase() : 'REGISTER';
    if (!(EMAIL_OTP_PURPOSES as readonly string[]).includes(p)) {
      throw new BusinessException('Unsupported verification purpose', 'INVALID_OTP_PURPOSE', HttpStatus.BAD_REQUEST);
    }
    return p as EmailOtpPurpose;
  }

  private emailOf(raw: unknown): string {
    const e = normalizeEmail(raw);
    if (!e) throw new BusinessException('Please enter a valid email address.', 'INVALID_EMAIL', HttpStatus.BAD_REQUEST);
    return e;
  }

  private async auditOtp(action: string, outcome: 'SUCCESS' | 'FAILURE' | 'DENIED', email: string, ctx: IOtpContext, extra: Record<string, unknown> = {}) {
    await this.audit?.record({
      userId: null,
      action,
      entityType: 'AUTH',
      entityId: null,
      outcome,
      // never the code, never the address: a short digest lets repeated attempts on one address be correlated
      newValues: auditValues({ ...extra, emailDigest: crypto.createHash('sha256').update(email).digest('hex').slice(0, 16) }),
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  async send(rawEmail: unknown, rawPurpose: unknown, ctx: IOtpContext = {}) {
    const email = this.emailOf(rawEmail);
    const purpose = this.purposeOf(rawPurpose);
    const accountExists = Boolean(await this.userRepo.findByEmail(email));
    const ipHash = hashClientAddress(ctx.ipAddress);
    const code = accountExists ? null : generateOtp();
    // An existing account gets a DECOY row: it looks live (same expiry, same attempt counter and lockout) but holds a random value no code can
    // match, so cooldown, daily limit, verify errors and lockout behave the same whether or not the address has an account.
    const storedHash = code ? hashEmailOtp(email, purpose, code) : crypto.randomBytes(32).toString('hex');

    const challengeId = await this.db.transaction(async (tx) => {
      const q = tx as unknown as Q;
      await q.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`email-otp:${purpose}:${email}`}))`);
      const stats: any = (
        await q.execute(sql`
          SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(created_at))), 1e9)::float AS since,
                 count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS daily
          FROM email_otp_challenges WHERE email = ${email} AND purpose = ${purpose}`)
      ).rows[0];
      if (Number(stats.since) < EMAIL_OTP_RESEND_COOLDOWN_SECONDS) {
        const wait = Math.max(1, Math.ceil(EMAIL_OTP_RESEND_COOLDOWN_SECONDS - Number(stats.since)));
        throw new BusinessException(`Please wait ${wait} seconds before requesting another code.`, 'OTP_RESEND_COOLDOWN', HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds: wait });
      }
      if (Number(stats.daily) >= EMAIL_OTP_DAILY_LIMIT_PER_EMAIL) {
        throw new BusinessException('Too many verification codes were requested for this address today. Please try again tomorrow.', 'OTP_DAILY_LIMIT', HttpStatus.TOO_MANY_REQUESTS);
      }
      if (ipHash) {
        const ip: any = (await q.execute(sql`SELECT count(*)::int AS n FROM email_otp_challenges WHERE ip_hash = ${ipHash} AND created_at > now() - interval '1 hour'`)).rows[0];
        if (Number(ip.n) >= EMAIL_OTP_HOURLY_LIMIT_PER_IP) {
          throw new BusinessException('Too many verification requests from this network. Please try again later.', 'OTP_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
        }
      }
      await q.execute(sql`UPDATE email_otp_challenges SET invalidated_at = now() WHERE email = ${email} AND purpose = ${purpose} AND consumed_at IS NULL AND invalidated_at IS NULL`);
      const ins: any = await q.execute(sql`
        INSERT INTO email_otp_challenges (email, purpose, otp_hash, max_attempts, expires_at, ip_hash)
        VALUES (${email}, ${purpose}, ${storedHash}, ${EMAIL_OTP_MAX_ATTEMPTS}, now() + make_interval(secs => ${EMAIL_OTP_TTL_SECONDS}), ${ipHash})
        RETURNING id`);
      return ins.rows[0].id as string;
    });

    if (code) {
      const delivered = await this.mail.sendChecked(buildEmailOtpMail(email, code, Math.round(EMAIL_OTP_TTL_SECONDS / 60)));
      if (!delivered) {
        // The code never left: remove it so the user can try again at once instead of waiting out a cooldown for nothing.
        await this.db.execute(sql`DELETE FROM email_otp_challenges WHERE id = ${challengeId}`);
        await this.auditOtp('EMAIL_OTP_SEND_FAILED', 'FAILURE', email, ctx, { purpose });
        throw new BusinessException('We could not send the verification code right now. Please try again in a moment.', 'EMAIL_DELIVERY_FAILED', HttpStatus.SERVICE_UNAVAILABLE);
      }
    }
    if (!code) {
      // The address already has an account, so no code exists. The screen's answer stays identical, but the owner is told by e-mail why no code
      // arrives and where to sign in. Awaited like the code mail so the response takes the same time; a failure here changes nothing.
      await this.mail.sendChecked(buildExistingAccountMail(email, this.mail.webUrl()));
    }
    await this.auditOtp('EMAIL_OTP_REQUESTED', 'SUCCESS', email, ctx, { purpose, delivered: Boolean(code), accountExists });

    return {
      success: true,
      message: GENERIC_OTP_SENT_MESSAGE,
      maskedEmail: maskEmail(email),
      expiresInSeconds: EMAIL_OTP_TTL_SECONDS,
      resendAfterSeconds: EMAIL_OTP_RESEND_COOLDOWN_SECONDS,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  async verify(rawEmail: unknown, rawOtp: unknown, rawPurpose: unknown, ctx: IOtpContext = {}) {
    const email = this.emailOf(rawEmail);
    const purpose = this.purposeOf(rawPurpose);
    const otp = normalizeOtp(rawOtp);
    if (!otp) throw new BusinessException('Enter the 6-digit code.', 'OTP_INVALID', HttpStatus.BAD_REQUEST);

    // Count the try first, in the same statement that selects the row. The outer conditions are re-checked against the locked row, so two
    // parallel requests cannot both take the last attempt.
    const claimed: any = (
      await this.db.execute(sql`
        UPDATE email_otp_challenges
           SET attempts = attempts + 1,
               locked_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE locked_at END
         WHERE id = (SELECT id FROM email_otp_challenges
                      WHERE email = ${email} AND purpose = ${purpose} AND consumed_at IS NULL AND invalidated_at IS NULL
                        AND locked_at IS NULL AND expires_at > now() AND attempts < max_attempts
                      ORDER BY created_at DESC LIMIT 1)
           AND consumed_at IS NULL AND invalidated_at IS NULL AND locked_at IS NULL AND expires_at > now() AND attempts < max_attempts
        RETURNING id, otp_hash, attempts, max_attempts`)
    ).rows[0];

    if (!claimed) {
      const last: any = (
        await this.db.execute(sql`
          SELECT consumed_at, invalidated_at, locked_at, (expires_at <= now()) AS expired
            FROM email_otp_challenges WHERE email = ${email} AND purpose = ${purpose} ORDER BY created_at DESC LIMIT 1`)
      ).rows[0];
      await this.auditOtp('EMAIL_OTP_FAILED', 'FAILURE', email, ctx, { purpose, reason: !last ? 'NONE' : last.locked_at ? 'LOCKED' : last.expired ? 'EXPIRED' : 'INACTIVE' });
      if (last?.locked_at) throw new BusinessException('Too many incorrect attempts. Request a new code.', 'OTP_ATTEMPTS_EXCEEDED', HttpStatus.TOO_MANY_REQUESTS);
      if (last && last.expired && !last.consumed_at && !last.invalidated_at) throw new BusinessException('This code has expired. Request a new one.', 'OTP_EXPIRED', HttpStatus.BAD_REQUEST);
      throw new BusinessException('That code is not valid. Request a new one.', 'OTP_INVALID', HttpStatus.BAD_REQUEST);
    }

    const matches = safeEqualHex(hashEmailOtp(email, purpose, otp), String(claimed.otp_hash));
    if (!matches) {
      const remaining = Math.max(0, Number(claimed.max_attempts) - Number(claimed.attempts));
      await this.auditOtp(remaining === 0 ? 'EMAIL_OTP_LOCKED' : 'EMAIL_OTP_FAILED', 'FAILURE', email, ctx, { purpose, reason: 'WRONG_CODE', attemptsRemaining: remaining });
      if (remaining === 0) throw new BusinessException('Too many incorrect attempts. Request a new code.', 'OTP_ATTEMPTS_EXCEEDED', HttpStatus.TOO_MANY_REQUESTS);
      throw new BusinessException('Incorrect code. Check it and try again.', 'OTP_INVALID', HttpStatus.BAD_REQUEST, { attemptsRemaining: remaining });
    }

    const proof = newProof(claimed.id);
    const accepted: any = await this.db.transaction(async (tx) => {
      const q = tx as unknown as Q;
      // Accepting the code and consuming it are one statement: of two parallel correct submissions only one gets a row back.
      const upd: any = await q.execute(sql`
        UPDATE email_otp_challenges
           SET consumed_at = now(), proof_hash = ${proof.hash}, proof_expires_at = now() + make_interval(secs => ${EMAIL_OTP_PROOF_TTL_SECONDS})
         WHERE id = ${claimed.id} AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
        RETURNING id`);
      if (!upd.rows[0]) return null;
      await q.execute(sql`UPDATE email_otp_challenges SET invalidated_at = now() WHERE email = ${email} AND purpose = ${purpose} AND id <> ${claimed.id} AND consumed_at IS NULL AND invalidated_at IS NULL`);
      return upd.rows[0];
    });
    if (!accepted) {
      await this.auditOtp('EMAIL_OTP_FAILED', 'FAILURE', email, ctx, { purpose, reason: 'RACE_LOST' });
      throw new BusinessException('That code is not valid. Request a new one.', 'OTP_INVALID', HttpStatus.BAD_REQUEST);
    }

    await this.auditOtp('EMAIL_OTP_VERIFIED', 'SUCCESS', email, ctx, { purpose });
    return { success: true, verified: true, verificationToken: proof.token, expiresInSeconds: EMAIL_OTP_PROOF_TTL_SECONDS, message: 'Email verified.' };
  }

  // ---------------------------------------------------------------------------------------------------------------
  /**
   * Spends a proof. Call inside the transaction that creates the account: if the account cannot be created the proof is not spent.
   * Throws 403 EMAIL_OTP_REQUIRED for anything that is not a live, unspent proof for exactly this address and purpose.
   */
  async consumeProof(tx: Q, rawEmail: unknown, token: unknown, purpose: EmailOtpPurpose = 'REGISTER'): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const parsed = parseProof(token);
    const deny = () => new BusinessException('Please verify your email address with the code we send you before continuing.', 'EMAIL_OTP_REQUIRED', HttpStatus.FORBIDDEN);
    if (!email || !parsed) throw deny();
    const res: any = await tx.execute(sql`
      UPDATE email_otp_challenges SET proof_consumed_at = now()
       WHERE id = ${parsed.id} AND email = ${email} AND purpose = ${purpose} AND proof_hash = ${parsed.hash}
         AND consumed_at IS NOT NULL AND proof_consumed_at IS NULL AND proof_expires_at > now()
      RETURNING id`);
    if (!res.rows[0]) throw deny();
  }
}
