import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  Res,
  Optional,
  Inject,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import * as crypto from 'crypto';
import { eq, and, gt, lt, or, sql } from 'drizzle-orm';
import { Public, CurrentUser } from './decorators';
import { AdminSendOtpDto, AdminVerifyOtpDto } from './dto/auth.dto';
import { UserRepository } from '../modules/user/user.repository';
import { AuthTokenService } from './services/auth-token.service';
import { DRIZZLE_DATABASE } from '../database/database.constants';
import { DrizzleDb } from '../database/database.provider';
import { adminOtps } from '../database/schema';
import { AuditLogService } from '../common/services/audit-log.service';
import { IJwtPayload } from '@orion/shared';
import { CsvSecurityUtil } from '../common/utils/csv-security.util';
import { hashOtp, timingSafeHexEqual } from './admin-otp.util';
import { MailService } from './mail/mail.service';
import { buildAdminOtpMail } from './mail/admin-otp.mail';

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function isLocalDbUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOCAL_DB_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}
/**
 * S-03: the deterministic OTP (123456) is honoured ONLY under automated tests (NODE_ENV=test) AND when the
 * database is local, so the well-known code can never authenticate against a remote/production database.
 * `development` no longer enables it.
 */
export function fixedOtpAllowed(): boolean {
  return process.env.NODE_ENV === 'test' && isLocalDbUrl(process.env.DATABASE_URL);
}

/** Minimum gap between two codes for the same account: a stranger cannot keep invalidating an administrator's code or flood their inbox. */
const OTP_MIN_RESEND_SECONDS = 30;

@ApiTags('Admin Authentication')
@Controller('admin')
export class AdminAuthController {
  private readonly logger = new Logger(AdminAuthController.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly authTokenService: AuthTokenService,
    @Inject(DRIZZLE_DATABASE) private readonly db: DrizzleDb,
    @Optional() private readonly auditLogService?: AuditLogService,
    @Optional() private readonly mail?: MailService,
  ) {}

  /** The persisted account for this email when it is an ACTIVE ADMIN or SUPER_ADMIN; otherwise undefined. */
  private async findAdminAccount(email: string) {
    const user = await this.userRepository.findByEmail(email);
    if (!user || user.status !== 'ACTIVE' || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) return undefined;
    return user;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 300000 } }) // 5 requests per 5 minutes
  @Post('auth/send-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send admin OTP verification code' })
  async sendOtp(@Body() body: AdminSendOtpDto, @Req() req: Request) {
    const email = body?.email?.toLowerCase()?.trim();
    if (!email) {
      throw new BadRequestException('Please provide your administrator email.');
    }

    // Authorize any email address belonging to @monarchsoftwares.com domain
    const emailParts = email.split('@');
    const isAuthorized =
      emailParts.length === 2 && Boolean(emailParts[0]) && emailParts[1] === 'monarchsoftwares.com';

    if (!isAuthorized) {
      await this.auditLogService?.record({
        action: 'ADMIN_OTP_UNAUTHORIZED_DOMAIN',
        entityType: 'ADMIN_AUTH',
        entityId: email,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      throw new ForbiddenException(
        'Access Denied: Only @monarchsoftwares.com email addresses are authorized for administrative access.',
      );
    }

    // The domain is only a first filter. Administrative access requires a persisted, ACTIVE ADMIN / SUPER_ADMIN account; for any
    // other address no code is generated and the response is identical (no account enumeration).
    const adminUser = await this.findAdminAccount(email);
    if (!adminUser) {
      await this.auditLogService?.record({
        action: 'ADMIN_OTP_NOT_AN_ADMIN',
        entityType: 'ADMIN_AUTH',
        entityId: email,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return { success: true, message: `Verification code generated for ${email}`, data: { expiresIn: 300 } };
    }

    // A code issued moments ago stays valid; refusing a new one (instead of replacing it) keeps the real administrator's code
    // from being invalidated by anyone who merely knows the address.
    const recent = await this.db
      .select({ id: adminOtps.id })
      .from(adminOtps)
      .where(and(eq(adminOtps.email, email), gt(adminOtps.createdAt, new Date(Date.now() - OTP_MIN_RESEND_SECONDS * 1000))))
      .limit(1);
    if (recent.length > 0) {
      throw new HttpException(
        'A verification code was just sent. Please wait a moment before requesting another.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // S-03: a random code everywhere except local automated tests
    const otp = fixedOtpAllowed()
      ? '123456'
      : crypto.randomInt(100000, 999999).toString();
    const ttlSeconds = 300; // 5 minutes

    // Clean expired OTPs and any existing OTP for this email, then insert new OTP into the database
    try {
      await this.db
        .delete(adminOtps)
        .where(or(lt(adminOtps.expiresAt, new Date()), eq(adminOtps.email, email)));

      await this.db.insert(adminOtps).values({
        email,
        otp: hashOtp(email, otp), // S-21: store only the HMAC, never the clear-text code
        attempts: 0,
        maxAttempts: 5,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      });
    } catch (err: any) {
      // A code that was not stored can never be verified, so it is not e-mailed and the administrator is told to retry.
      this.logger.error(`Failed to store OTP in the database: ${err.message}`, err.stack);
      throw new ServiceUnavailableException('We could not create a verification code right now. Please try again in a moment.');
    }

    // The code only exists to be read from an e-mail, so it is sent here (the web gateway forwards this request to the API and does not send
    // anything itself). Local automated tests use the fixed code and read it from the response instead of a mailbox.
    if (!fixedOtpAllowed()) {
      const delivered = this.mail ? await this.mail.sendChecked(buildAdminOtpMail(email, otp, Math.round(ttlSeconds / 60))) : false;
      if (!delivered) {
        // The code never left: remove it so the administrator can ask again at once instead of waiting out the resend delay for nothing.
        await this.db.delete(adminOtps).where(eq(adminOtps.email, email)).catch(() => undefined);
        await this.auditLogService?.record({
          action: 'ADMIN_OTP_SEND_FAILED',
          entityType: 'ADMIN_AUTH',
          entityId: crypto.createHash('sha256').update(email).digest('hex').slice(0, 16),
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        });
        throw new ServiceUnavailableException('We could not send the verification code right now. Please try again in a moment.');
      }
    }

    await this.auditLogService?.record({
      action: 'ADMIN_OTP_GENERATED',
      entityType: 'ADMIN_AUTH',
      // a short digest, not the address (Phase 13): enough to see repeated requests for the same account
      entityId: crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 16),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const responseData: Record<string, unknown> = {
      expiresIn: ttlSeconds,
    };

    // previewOtp is strictly ONLY exposed during local automated tests (same rule as the fixed code), never because NODE_ENV alone says "test"
    if (fixedOtpAllowed()) {
      responseData.previewOtp = otp;
    }

    return {
      success: true,
      message: `Verification code generated for ${email}`,
      data: responseData,
    };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 300000 } })
  @Post('auth/verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify admin OTP and issue administrator session token' })
  async verifyOtp(@Body() body: AdminVerifyOtpDto, @Req() req: Request) {
    const email = body?.email?.toLowerCase()?.trim();
    const otp = body?.otp?.trim();

    if (!email || !otp) {
      throw new BadRequestException('Email and verification code are required.');
    }

    const emailParts = email.split('@');
    const isAuthorized =
      emailParts.length === 2 && Boolean(emailParts[0]) && emailParts[1] === 'monarchsoftwares.com';

    if (!isAuthorized) {
      throw new ForbiddenException(
        'Access Denied: Only @monarchsoftwares.com email addresses are authorized for administrative access.',
      );
    }

    const adminAccount = await this.findAdminAccount(email);
    if (!adminAccount) {
      // same answer as a wrong code, and no attempt counter to burn
      throw new BadRequestException('Invalid or expired verification code.');
    }

    // Retrieve active OTP record from the database
    let otpRecord: typeof adminOtps.$inferSelect | undefined;
    try {
      const records = await this.db
        .select()
        .from(adminOtps)
        .where(and(eq(adminOtps.email, email), gt(adminOtps.expiresAt, new Date())))
        .limit(1);
      otpRecord = records[0];
    } catch (err: any) {
      this.logger.error(`Failed to read OTP from the database: ${err.message}`, err.stack);
    }

    // Claim an attempt BEFORE comparing the code, in one atomic statement that only succeeds while attempts remain. A read-then-
    // increment lets a burst of parallel guesses all see "0 attempts used" and all be evaluated; claiming first caps the total
    // number of guesses per code at maxAttempts however the requests are interleaved.
    if (otpRecord) {
      const claimed = await this.db
        .update(adminOtps)
        .set({ attempts: sql`${adminOtps.attempts} + 1` })
        .where(and(eq(adminOtps.id, otpRecord.id), lt(adminOtps.attempts, adminOtps.maxAttempts)))
        .returning({ id: adminOtps.id });
      if (claimed.length === 0) {
        throw new HttpException(
          'Too many failed attempts. This verification session is locked. Please request a new code.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    // S-03: deterministic '123456' fallback is honoured only under local automated tests
    // S-21: the submitted code is HMAC'd and compared in constant time against the stored hash. The
    // deterministic test code is honoured only when no record is present (cross-instance) and only under
    // local automated tests, exactly as before.
    const isValidOtp =
      otpRecord !== undefined
        ? timingSafeHexEqual(String(otpRecord.otp), hashOtp(email, otp))
        : fixedOtpAllowed() && otp === '123456';

    if (!isValidOtp) {
      // the attempt was already counted when it was claimed above
      await this.auditLogService?.record({
        action: 'ADMIN_OTP_FAILED',
        entityType: 'ADMIN_AUTH',
        entityId: email,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      throw new BadRequestException('Invalid or expired verification code.');
    }

    // Single use, and race-safe: the delete is the redemption, and only one concurrent request can delete the row. A second request
    // carrying the same correct code finds nothing to delete and is refused, so a code can never mint two sessions.
    if (otpRecord) {
      const redeemed = await this.db.delete(adminOtps).where(eq(adminOtps.id, otpRecord.id)).returning({ id: adminOtps.id });
      if (redeemed.length === 0) {
        throw new BadRequestException('Invalid or expired verification code.');
      }
    }

    // Accounts are never created here: the role comes from the persisted record (provisioned by the seed / an existing admin)
    const user = adminAccount;

    // A privileged session is revocable like a customer one: it carries a session id that is stored as the account's active session. A newer
    // administrator sign-in, or a logout, replaces that id, and the JwtStrategy session check then refuses the older token at once.
    const sessionId = crypto.randomUUID();
    await this.setActiveSession(user.id, sessionId);

    const adminToken = await this.authTokenService.generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role as any,
      status: user.status as any,
      organizationId: user.organizationId,
      sessionId,
    });

    await this.auditLogService?.record({
      userId: user.id,
      action: 'ADMIN_LOGIN_SUCCESS',
      entityType: 'USER',
      entityId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return {
      success: true,
      message: 'Administrator session authenticated',
      data: {
        adminToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
        },
      },
    };
  }

  /** Sets the account's single active session id without touching the rest of its metadata (an MFA replay guard lives there too). */
  private async setActiveSession(userId: string, sessionId: string): Promise<void> {
    await this.db.execute(sql`UPDATE users SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{activeSessionId}', to_jsonb(${sessionId}::text)), updated_at = now() WHERE id = ${userId}`);
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Terminate admin session' })
  async logout(@CurrentUser() user?: IJwtPayload, @Req() req?: Request) {
    if (user?.sub) {
      // ends the session server-side: the presented token (and any other) stops working; a token that is not the current session never gets here
      await this.setActiveSession(user.sub, crypto.randomUUID()).catch(() => undefined);
      await this.auditLogService?.record({
        userId: user.sub,
        action: 'ADMIN_LOGOUT',
        entityType: 'USER',
        entityId: user.sub,
        ipAddress: req?.ip,
        userAgent: req?.headers['user-agent'] as string,
      });
    }

    return {
      success: true,
      message: 'Admin session terminated successfully',
    };
  }

  @Public()
  @Get('template/csv')
  @ApiOperation({ summary: 'Download CSV template for business records import' })
  async downloadCsvTemplate(@Res() res: Response) {
    const headers = [
      'name', 'legalName', 'cin', 'pan', 'gstin', 'status',
      'incorporationDate', 'businessType', 'industry', 'subIndustry',
      'paidUpCapital', 'authorizedCapital', 'employeeCount', 'annualTurnover',
      'website', 'primaryEmail', 'primaryPhone', 'addressLine1', 'city',
      'state', 'pincode', 'country',
    ];

    const sampleRow = [
      'Monarch Technologies Private Limited',
      'Monarch Technologies Pvt Ltd',
      'U72200MH2020PTC123456',
      'ABCDE1234F',
      '27ABCDE1234F1Z5',
      'VERIFIED',
      '2020-01-15',
      'PRIVATE_LIMITED',
      'Information Technology',
      'Software Development',
      '10000000',
      '20000000',
      '120',
      '50000000',
      'https://monarchsoftwares.com',
      'contact@monarchsoftwares.com',
      '+919876543210',
      '101 Cyber Park',
      'Mumbai',
      'Maharashtra',
      '400001',
      'India',
    ];

    const csvContent = `${headers.join(',')}\n${CsvSecurityUtil.formatCsvRow(sampleRow)}\n`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="orion_business_import_template.csv"');
    res.send(csvContent);
  }
}
