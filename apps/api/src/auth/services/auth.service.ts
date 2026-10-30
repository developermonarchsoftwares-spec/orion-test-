import { Injectable, Logger, HttpStatus, Optional } from '@nestjs/common';
import { PasswordService } from './password.service';
import { AuthTokenService, ITokenPair } from './auth-token.service';
import { UserRepository } from '../../modules/user/user.repository';
import { RegisterDto, LoginDto, ResetPasswordDto } from '../dto/auth.dto';
import { MailService } from '../mail/mail.service';
import { TrafficLimitsService } from '../../modules/traffic/traffic-limits.service';
import { BusinessException } from '../../common/errors/business.exception';
import { UserRole, UserStatus } from '@orion/shared';
import { CryptoUtil } from '../../common/utils/crypto.util';
import { DRIZZLE_DATABASE } from '../../database/database.constants';
import { DrizzleDb } from '../../database/database.provider';
import { Inject } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as schema from '../../database/schema';
import { findTotpStep, generateTotpSecret, otpauthUrl } from './totp.util';
import { openSecret, sealSecret } from './secret-box.util';
import { AuditLogService } from '../../common/services/audit-log.service';
import { auditValues } from '../../common/services/audit-values';
import { EmailOtpService } from './email-otp.service';
import { registrationOtpRequired } from '../email-otp.util';
import { parseSignupConsents, POLICY_VERSION, signupConsentRequired } from '../../modules/privacy/privacy.config';

export interface IMfaChallenge {
  mfaRequired: true;
  /** Short-lived (5 min) purpose-bound token to present to POST /auth/mfa/login with a TOTP or recovery code. */
  mfaToken: string;
}

/** E-mail verification is opt-in (REQUIRE_EMAIL_VERIFICATION=true) so existing frictionless onboarding is unchanged. */
export function emailVerificationRequired(): boolean {
  return /^(1|true|yes)$/i.test((process.env.REQUIRE_EMAIL_VERIFICATION || '').trim());
}

const GENERIC_RESET_MESSAGE = 'If an account exists with this email, password reset instructions have been sent.';
const GENERIC_VERIFY_MESSAGE = 'If this account exists and is not yet verified, a verification e-mail has been sent.';

export interface IAuthResult {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    displayName?: string | null;
    role: UserRole;
    status: UserStatus;
    organizationName?: string | null;
    isEmailVerified: boolean;
  };
  tokens: ITokenPair;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly userRepo: UserRepository,
    private readonly passwordService: PasswordService,
    private readonly tokenService: AuthTokenService,
    private readonly mail: MailService,
    @Inject(DRIZZLE_DATABASE)
    private readonly db: DrizzleDb,
    private readonly emailOtp: EmailOtpService,
    @Optional() private readonly traffic?: TrafficLimitsService,
    @Optional() private readonly audit?: AuditLogService,
  ) {}

  /**
   * Security audit entry for an authentication event (Phase 13). Holds the account id when known; for an unknown account only a short digest of the
   * submitted e-mail (to correlate repeated attempts without storing the address), a failure CATEGORY and the client address. Never a password,
   * code or token. Best effort: a failed audit write never changes the login result.
   */
  private async auditAuth(
    action: string,
    userId: string | null,
    context: { userAgent?: string; ipAddress?: string } | undefined,
    outcome: 'SUCCESS' | 'FAILURE' | 'DENIED',
    failureCategory?: string,
    extra: Record<string, unknown> = {},
    email?: string,
  ): Promise<void> {
    await this.audit?.record({
      userId,
      action,
      entityType: 'AUTH',
      entityId: userId,
      outcome,
      failureCategory,
      newValues: { ...extra, ...(!userId && email ? { emailDigest: CryptoUtil.sha256(email.trim().toLowerCase()).slice(0, 16) } : {}) },
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
  }

  /**
   * Registers a new customer user and initializes their default credit wallet
   */
  async register(
    dto: RegisterDto,
    context?: { userAgent?: string; ipAddress?: string },
  ): Promise<IAuthResult> {
    // New accounts need proof that the address is the user's: the one-time proof from POST /auth/verify-otp. Checked first so nothing else
    // (password hashing, lookups) is spent on a request that cannot succeed. Always on in production (see registrationOtpRequired).
    const otpRequired = registrationOtpRequired();
    if (otpRequired && !dto.verificationToken) {
      await this.auditAuth('REGISTER_DENIED', null, context, 'DENIED', 'EMAIL_OTP_REQUIRED', {}, dto.email);
      throw new BusinessException(
        'Please verify your email address with the code we send you before creating an account.',
        'EMAIL_OTP_REQUIRED',
        HttpStatus.FORBIDDEN,
      );
    }
    // DPDP Act: no account without the person's own, explicit consent to process their account data (always on in production)
    const consent = parseSignupConsents(dto.consents);
    if (signupConsentRequired() && !consent.accountService) {
      await this.auditAuth('REGISTER_DENIED', null, context, 'DENIED', 'CONSENT_REQUIRED', {}, dto.email);
      throw new BusinessException('Please give your consent to create and run your account, or we cannot register you.', 'CONSENT_REQUIRED', HttpStatus.BAD_REQUEST);
    }
    const existing = await this.userRepo.findByEmail(dto.email);
    if (existing) {
      throw new BusinessException(
        'An account with this email already exists',
        'EMAIL_ALREADY_EXISTS',
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await this.passwordService.hash(dto.password);

    // Create user and wallet in transaction
    const newUser = await this.db.transaction(async (tx) => {
      // Spent in the same transaction as the account: if anything below fails the proof is not used up, and it can never create two accounts.
      if (otpRequired) await this.emailOtp.consumeProof(tx as any, dto.email, dto.verificationToken, 'REGISTER');
      const [user] = await tx
        .insert(schema.users)
        .values({
          email: dto.email.toLowerCase().trim(),
          passwordHash,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          displayName: dto.displayName?.trim() || `${dto.firstName.trim()} ${dto.lastName.trim()}`.trim(),
          organizationName: dto.organizationName?.trim(),
          phoneNumber: dto.phoneNumber?.trim(),
          role: 'USER',
          status: 'ACTIVE',
          // verified by the code when OTP is required; otherwise auto-verified unless REQUIRE_EMAIL_VERIFICATION is on
          isEmailVerified: otpRequired || !emailVerificationRequired(),
          emailVerifiedAt: otpRequired || !emailVerificationRequired() ? new Date() : null,
        })
        .returning();

      // The consent choices are written with the account: either both exist or neither does
      if (consent.rows.length) {
        await tx.insert(schema.consentRecords).values(
          consent.rows.map((r) => ({ userId: user.id, purpose: r.purpose, granted: r.granted, policyVersion: POLICY_VERSION, source: 'signup', ipAddress: context?.ipAddress ?? null, userAgent: context?.userAgent ?? null })),
        );
      }

      const todayStr = new Date().toISOString().slice(0, 10);

      // Initialize Credit Wallet with 5 Daily Free Credits
      const [wallet] = await tx
        .insert(schema.userWallets)
        .values({
          userId: user.id,
          dailyCredits: 5,
          purchasedCredits: 0,
          balance: 5,
          lastDailyCreditDate: todayStr,
          lifetimePurchased: 0,
          lifetimeUsed: 0,
        })
        .returning();

      // Record daily allocation transaction
      await tx.insert(schema.creditTransactions).values({
        walletId: wallet.id,
        userId: user.id,
        amount: 5,
        balanceAfter: 5,
        balanceType: 'DAILY',
        dailyBalanceAfter: 5,
        purchasedBalanceAfter: 0,
        type: 'DAILY_ALLOCATION',
        description: 'Welcome daily free credits on registration',
      });

      // Record audit log
      await tx.insert(schema.auditLogs).values({
        userId: user.id,
        action: 'USER_REGISTERED',
        entityType: 'user',
        entityId: user.id,
        // no e-mail address: the account id is the reference (Phase 13 data minimisation)
        newValues: auditValues({ role: user.role, method: 'PASSWORD', outcome: 'SUCCESS' }),
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
      });

      return user;
    });

    if (!otpRequired && emailVerificationRequired()) {
      await this.sendVerificationEmail(newUser.id, newUser.email, newUser.firstName);
    }

    const tokens = await this.issueSession(newUser, context);

    this.logger.log(`User registered successfully: ${newUser.email} (${newUser.id})`);

    return { user: this.toAuthUser(newUser), tokens };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------------------------------------------

  private toAuthUser(u: any): IAuthResult['user'] {
    return {
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      displayName: u.displayName || `${u.firstName} ${u.lastName}`.trim(),
      role: u.role as UserRole,
      status: u.status as UserStatus,
      organizationName: u.organizationName,
      isEmailVerified: u.isEmailVerified,
    };
  }

  /** Unguessable session id (CSPRNG). It is also bound into the signed access token, so it is never a bearer secret on its own. */
  private newSessionId(): string {
    return `sess_${randomBytes(16).toString('hex')}`;
  }

  private dummyHash?: Promise<string>;

  /**
   * A bcrypt comparison that always fails, run when there is no usable password hash (unknown e-mail, social-only account), so
   * those paths cost about the same as a wrong password and the response time does not reveal whether the account exists.
   */
  private async burnPasswordCompare(plain: string): Promise<void> {
    this.dummyHash ??= this.passwordService.hash(randomBytes(16).toString('hex'));
    await this.passwordService.compare(plain, await this.dummyHash);
  }

  /** Rotating `activeSessionId` makes every outstanding access token fail the JwtStrategy session check at once. */
  private async rotateActiveSession(user: { id: string; metadata: unknown }, extraMeta: Record<string, unknown> = {}) {
    const meta = (user.metadata as Record<string, any>) || {};
    const sessionId = this.newSessionId();
    await this.userRepo.updateById(user.id, { metadata: { ...meta, activeSessionId: sessionId, ...extraMeta } });
    return sessionId;
  }

  /** Starts a fresh single-device session: supersedes older logins, mints and stores the token pair. */
  private async issueSession(user: any, context?: { userAgent?: string; ipAddress?: string }): Promise<ITokenPair> {
    await this.userRepo.revokeAllUserRefreshTokens(user.id, 'SUPERSEDED');
    // Re-read so metadata written by an MFA step (replay guard) is not overwritten with a stale copy.
    const fresh = (await this.userRepo.findById(user.id)) ?? user;
    const sessionId = await this.rotateActiveSession(fresh);
    await this.userRepo.updateById(user.id, { lastLoginAt: new Date() });

    const tokens = await this.tokenService.generateTokenPair({
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      status: user.status as UserStatus,
      organizationId: user.organizationId,
      sessionId,
    });
    await this.userRepo.createRefreshToken({
      userId: user.id,
      tokenHash: CryptoUtil.sha256(tokens.refreshToken),
      userAgent: context?.userAgent,
      ipAddress: context?.ipAddress,
      expiresAt: new Date(Date.now() + this.tokenService.refreshTtlMs()),
    });
    return tokens;
  }

  /**
   * Logs in with password. Enforces the single-device policy; when the account has MFA enabled, returns a challenge
   * instead of tokens, to be completed with {@link completeMfaLogin}.
   */
  async login(
    dto: LoginDto,
    context?: { userAgent?: string; ipAddress?: string },
  ): Promise<IAuthResult | IMfaChallenge> {
    // a locked account is refused before anything is looked up: the answer is the same whether or not the e-mail is registered
    try {
      this.traffic?.assertLoginAllowed(dto.email);
    } catch (err) {
      await this.auditAuth('LOGIN_BLOCKED', null, context, 'DENIED', 'ACCOUNT_LOCKED', {}, dto.email);
      throw err;
    }
    const user = await this.userRepo.findByEmail(dto.email);
    // An unknown e-mail and a social-only account (no password hash) get the same cost and the same answer as a wrong password:
    // the response must not reveal that an account exists, or how it was created. Social-login users can set a password through
    // "forgot password".
    if (!user || !user.passwordHash) {
      await this.burnPasswordCompare(dto.password);
      await this.traffic?.recordLoginFailure(dto.email, context?.ipAddress);
      await this.auditAuth('LOGIN_FAILED', null, context, 'FAILURE', 'UNKNOWN_ACCOUNT', {}, dto.email);
      throw new BusinessException('Invalid email or password', 'INVALID_CREDENTIALS', HttpStatus.UNAUTHORIZED);
    }

    const isValid = await this.passwordService.compare(dto.password, user.passwordHash);
    if (!isValid) {
      await this.traffic?.recordLoginFailure(dto.email, context?.ipAddress);
      await this.auditAuth('LOGIN_FAILED', user.id, context, 'FAILURE', 'BAD_PASSWORD');
      throw new BusinessException('Invalid email or password', 'INVALID_CREDENTIALS', HttpStatus.UNAUTHORIZED);
    }

    // The account state is shown only to someone who proved they know the password.
    if (user.status === 'SUSPENDED' || user.status === 'INACTIVE') {
      await this.auditAuth('LOGIN_FAILED', user.id, context, 'DENIED', 'ACCOUNT_INACTIVE');
      throw new BusinessException(
        'Your account has been deactivated. Please contact support.',
        'ACCOUNT_INACTIVE',
        HttpStatus.FORBIDDEN,
      );
    }
    this.traffic?.recordLoginSuccess(dto.email);

    // Checked after the password so an unverified state is never revealed to someone who does not know the password.
    if (emailVerificationRequired() && !user.isEmailVerified) {
      await this.auditAuth('LOGIN_FAILED', user.id, context, 'DENIED', 'EMAIL_NOT_VERIFIED');
      throw new BusinessException(
        'Please verify your e-mail address before signing in.',
        'EMAIL_NOT_VERIFIED',
        HttpStatus.FORBIDDEN,
      );
    }

    if (user.twoFactorEnabled && user.twoFactorSecret) {
      const mfaToken = await this.tokenService.generatePurposeToken('mfa-login', user.id, user.email, '5m');
      await this.auditAuth('LOGIN_MFA_CHALLENGED', user.id, context, 'SUCCESS', undefined, { step: 'PASSWORD_OK' });
      return { mfaRequired: true, mfaToken };
    }

    const tokens = await this.issueSession(user, context);
    await this.auditAuth('LOGIN_SUCCESS', user.id, context, 'SUCCESS', undefined, { method: 'PASSWORD' });
    return { user: this.toAuthUser(user), tokens };
  }

  /** Second step of an MFA login: a TOTP code, or a one-time recovery code when the device is lost. */
  async completeMfaLogin(
    dto: { mfaToken: string; code?: string; recoveryCode?: string },
    context?: { userAgent?: string; ipAddress?: string },
  ): Promise<IAuthResult> {
    let payload: { sub: string };
    try {
      payload = await this.tokenService.verifyPurposeToken('mfa-login', dto.mfaToken);
    } catch {
      throw new BusinessException('MFA session expired. Please sign in again.', 'INVALID_MFA_TOKEN', HttpStatus.UNAUTHORIZED);
    }
    const user = await this.userRepo.findById(payload.sub);
    if (!user || user.status !== 'ACTIVE' || !user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new BusinessException('MFA session expired. Please sign in again.', 'INVALID_MFA_TOKEN', HttpStatus.UNAUTHORIZED);
    }
    // Guessing second-factor codes counts against the same account lockout as guessing passwords, so a locked account cannot be
    // pressed further through this step (recordLoginFailure below already feeds that lockout).
    try {
      this.traffic?.assertLoginAllowed(user.email);
    } catch (err) {
      await this.auditAuth('LOGIN_BLOCKED', user.id, context, 'DENIED', 'ACCOUNT_LOCKED', { step: 'MFA' });
      throw err;
    }

    const ok = dto.recoveryCode
      ? await this.userRepo.consumeRecoveryCode(user.id, this.hashRecoveryCode(dto.recoveryCode))
      : await this.checkTotp(user, dto.code);
    if (!ok) {
      await this.traffic?.recordLoginFailure(user.email, context?.ipAddress);
      await this.auditAuth('MFA_FAILED', user.id, context, 'FAILURE', dto.recoveryCode ? 'BAD_RECOVERY_CODE' : 'BAD_TOTP_CODE');
      throw new BusinessException('Invalid verification code', 'INVALID_MFA_CODE', HttpStatus.UNAUTHORIZED);
    }
    if (dto.recoveryCode) {
      const left = await this.userRepo.countUnusedRecoveryCodes(user.id);
      void this.mail.send({
        to: user.email,
        subject: 'A recovery code was used to sign in',
        text: `A one-time recovery code was just used to sign in to your account. You have ${left} recovery code(s) left. If this was not you, reset your password immediately and regenerate your recovery codes.`,
      });
    }

    const tokens = await this.issueSession(user, context);
    await this.auditAuth('LOGIN_SUCCESS', user.id, context, 'SUCCESS', undefined, { method: dto.recoveryCode ? 'MFA_RECOVERY_CODE' : 'MFA_TOTP' });
    return { user: this.toAuthUser(user), tokens };
  }

  /** Verifies a TOTP code against the stored seed and refuses a replay of an already-accepted step. */
  private async checkTotp(user: any, code?: string): Promise<boolean> {
    if (!code || !user.twoFactorSecret) return false;
    let secret: string;
    try {
      secret = openSecret(user.twoFactorSecret);
    } catch {
      this.logger.error(`MFA secret for ${user.id} could not be decrypted (key changed?)`);
      return false;
    }
    const step = findTotpStep(secret, code);
    if (step === null) return false;
    // Atomic: only one request can claim a given step, so the same code cannot be accepted twice, even concurrently.
    if (!(await this.userRepo.claimTotpStep(user.id, step))) return false;
    const meta = (user.metadata as Record<string, any>) || {};
    user.metadata = { ...meta, mfaLastStep: step };
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Refresh-token lifecycle
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Rotates the refresh token. Each token is single-use: presenting a revoked token (a replay) revokes the whole
   * family, and an expired or unknown token is refused. Rotation is atomic, so two concurrent uses of the same
   * token cannot both succeed.
   */
  async refreshTokens(
    rawRefreshToken: string,
    context?: { userAgent?: string; ipAddress?: string },
  ): Promise<ITokenPair> {
    let payload;
    try {
      payload = await this.tokenService.verifyRefreshToken(rawRefreshToken);
    } catch {
      throw new BusinessException('Invalid or expired refresh token', 'INVALID_TOKEN', HttpStatus.UNAUTHORIZED);
    }

    const tokenHash = CryptoUtil.sha256(rawRefreshToken);
    const storedToken = await this.userRepo.findRefreshToken(tokenHash);

    if (!storedToken) {
      throw new BusinessException('Refresh token not recognized', 'INVALID_TOKEN', HttpStatus.UNAUTHORIZED);
    }

    if (storedToken.isRevoked) {
      // Replay of a rotated/revoked token: treat as theft and end the whole session family.
      await this.userRepo.revokeRefreshTokenFamily(storedToken.familyId, 'REUSE_DETECTED');
      this.logger.warn(`Revoked family ${storedToken.familyId} due to reuse attempt of token ${storedToken.id}`);
      // a replayed rotated token is the clearest sign that a refresh token was copied (Phase 13)
      await this.auditAuth('TOKEN_REUSE_DETECTED', storedToken.userId, context, 'DENIED', 'REFRESH_TOKEN_REPLAY', { sessionFamilyRevoked: true });
      throw new BusinessException('Suspicious token activity detected. Please login again.', 'TOKEN_REVOKED', HttpStatus.UNAUTHORIZED);
    }

    if (storedToken.expiresAt.getTime() <= Date.now()) {
      await this.userRepo.revokeRefreshToken(storedToken.id, 'EXPIRED');
      throw new BusinessException('Invalid or expired refresh token', 'INVALID_TOKEN', HttpStatus.UNAUTHORIZED);
    }

    const user = await this.userRepo.findById(payload.sub);
    if (!user || user.status !== 'ACTIVE') {
      throw new BusinessException('User account is not active', 'USER_NOT_FOUND', HttpStatus.UNAUTHORIZED);
    }

    // Atomic single-use: only the caller that flips is_revoked wins; a concurrent duplicate is a replay.
    const rotated = await this.userRepo.revokeRefreshToken(storedToken.id, 'ROTATED');
    if (!rotated) {
      await this.userRepo.revokeRefreshTokenFamily(storedToken.familyId, 'REUSE_DETECTED');
      await this.auditAuth('TOKEN_REUSE_DETECTED', storedToken.userId, context, 'DENIED', 'CONCURRENT_REFRESH_REPLAY', { sessionFamilyRevoked: true });
      throw new BusinessException('Suspicious token activity detected. Please login again.', 'TOKEN_REVOKED', HttpStatus.UNAUTHORIZED);
    }

    const userMeta = (user.metadata as Record<string, any>) || {};
    const tokens = await this.tokenService.generateTokenPair({
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      status: user.status as UserStatus,
      organizationId: user.organizationId,
      sessionId: userMeta.activeSessionId,
    });

    await this.userRepo.createRefreshToken({
      userId: user.id,
      tokenHash: CryptoUtil.sha256(tokens.refreshToken),
      familyId: storedToken.familyId,
      userAgent: context?.userAgent,
      ipAddress: context?.ipAddress,
      expiresAt: new Date(Date.now() + this.tokenService.refreshTtlMs()),
    });

    return tokens;
  }

  /** Housekeeping for the scheduler: drops expired tokens and revoked ones past a short reuse-detection window. */
  async purgeStaleTokens(): Promise<number> {
    const removed = await this.userRepo.purgeRefreshTokens(24 * 60 * 60 * 1000);
    await this.userRepo.purgeActionTokens();
    return removed;
  }

  /**
   * Logs out. With a refresh token, ends just that session (only if it belongs to the caller); without one,
   * every session of the user.
   */
  async logout(rawRefreshToken?: string, userId?: string): Promise<void> {
    if (rawRefreshToken) {
      const stored = await this.userRepo.findRefreshToken(CryptoUtil.sha256(rawRefreshToken));
      if (stored && (!userId || stored.userId === userId)) {
        await this.userRepo.revokeRefreshTokenFamily(stored.familyId, 'LOGOUT');
      }
    } else if (userId) {
      await this.userRepo.revokeAllUserRefreshTokens(userId, 'LOGOUT');
    }
    // The account has a single active session (single-device login), so ending it must also end the access token that is
    // still inside its lifetime: rotating the session id makes the JwtStrategy session check reject it on the next request.
    // (Without this a copied access token kept working for up to its 15-minute lifetime after the user signed out.)
    if (userId) {
      const user = await this.userRepo.findById(userId);
      if (user) await this.rotateActiveSession(user);
      await this.auditAuth('LOGOUT', userId, undefined, 'SUCCESS');
    }
  }

  /** Active sessions (one per refresh-token family) for the "where you're signed in" screen. */
  async listSessions(userId: string) {
    const rows = await this.userRepo.listActiveSessions(userId);
    const seen = new Set<string>();
    return rows
      .filter((r) => (seen.has(r.familyId) ? false : (seen.add(r.familyId), true)))
      .map((r) => ({
        id: r.familyId,
        userAgent: r.userAgent,
        ipAddress: r.ipAddress,
        lastRefreshedAt: r.createdAt,
        expiresAt: r.expiresAt,
      }));
  }

  /**
   * Ends one session. Its refresh token stops working immediately; an access token already issued for it lives out
   * its short (15 min) lifetime. Use {@link revokeAllSessions} for immediate, hard sign-out everywhere.
   */
  async revokeSession(userId: string, sessionId: string): Promise<{ success: boolean }> {
    const n = await this.userRepo.revokeUserSession(userId, sessionId);
    if (!n) throw new BusinessException('Session not found', 'SESSION_NOT_FOUND', HttpStatus.NOT_FOUND);
    return { success: true };
  }

  /** Signs the user out of every device now: all refresh tokens revoked and all access tokens invalidated. */
  async revokeAllSessions(userId: string): Promise<{ success: boolean }> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new BusinessException('User not found', 'USER_NOT_FOUND', HttpStatus.NOT_FOUND);
    await this.userRepo.revokeAllUserRefreshTokens(userId, 'REVOKE_ALL');
    await this.rotateActiveSession(user);
    return { success: true };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Forgot / reset password, e-mail verification
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Starts a password reset. Always answers identically whether or not the account exists. For a real, active
   * account a single-use token (15 min) is e-mailed; it is never returned in the response. Social-login accounts
   * without a password can use this to set one.
   */
  async forgotPassword(email: string): Promise<{ success: boolean; message: string }> {
    const user = await this.userRepo.findByEmail(email);
    if (user && user.status === 'ACTIVE') {
      const { token, hash } = this.tokenService.generateOpaqueToken();
      await this.userRepo.createActionToken(user.id, 'password-reset', hash, new Date(Date.now() + 15 * 60 * 1000));
      const link = `${this.mail.webUrl()}/reset-password?token=${encodeURIComponent(token)}`;
      void this.mail.send({
        to: user.email,
        subject: 'Reset your password',
        text: `Hi ${user.firstName},\n\nUse this link within 15 minutes to choose a new password:\n${link}\n\nIf you did not ask for this, you can ignore this e-mail; your password has not changed.`,
      });
      this.logger.log(`Password reset requested for user: ${user.id}`);
      await this.auditAuth('PASSWORD_RESET_REQUESTED', user.id, undefined, 'SUCCESS');
    }
    return { success: true, message: GENERIC_RESET_MESSAGE };
  }

  /** Completes a reset: single-use token, new password, every session ended, owner notified. */
  async resetPassword(dto: ResetPasswordDto): Promise<{ success: boolean; message: string }> {
    const row = await this.userRepo.consumeActionToken('password-reset', CryptoUtil.sha256(dto.token));
    if (!row) {
      await this.auditAuth('PASSWORD_RESET_FAILED', null, undefined, 'FAILURE', 'INVALID_OR_EXPIRED_TOKEN');
      throw new BusinessException('Invalid or expired reset token', 'INVALID_RESET_TOKEN', HttpStatus.BAD_REQUEST);
    }
    const user = await this.userRepo.findById(row.userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new BusinessException('Invalid or expired reset token', 'INVALID_RESET_TOKEN', HttpStatus.BAD_REQUEST);
    }

    const passwordHash = await this.passwordService.hash(dto.newPassword);
    // Receiving the e-mail proves control of the mailbox, so the address counts as verified.
    await this.userRepo.updateById(user.id, {
      passwordHash,
      isEmailVerified: true,
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
    });
    await this.userRepo.revokeAllUserRefreshTokens(user.id, 'PASSWORD_RESET');
    await this.rotateActiveSession(user, { passwordChangedAt: Date.now() });

    void this.mail.send({
      to: user.email,
      subject: 'Your password was changed',
      text: 'Your password was just changed and all devices were signed out. If this was not you, contact support immediately.',
    });
    await this.auditAuth('PASSWORD_RESET_COMPLETED', user.id, undefined, 'SUCCESS', undefined, { sessionsRevoked: true });
    return { success: true, message: 'Password has been reset successfully. Please log in.' };
  }

  private async sendVerificationEmail(userId: string, email: string, firstName: string) {
    const { token, hash } = this.tokenService.generateOpaqueToken();
    await this.userRepo.createActionToken(userId, 'email-verify', hash, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const link = `${this.mail.webUrl()}/verify-email?token=${encodeURIComponent(token)}`;
    void this.mail.send({
      to: email,
      subject: 'Verify your e-mail address',
      text: `Hi ${firstName},\n\nConfirm your e-mail address within 24 hours:\n${link}`,
    });
  }

  /** Re-sends the verification e-mail. Same answer for unknown, verified and unverified accounts. */
  async resendVerification(email: string): Promise<{ success: boolean; message: string }> {
    const user = await this.userRepo.findByEmail(email);
    if (user && user.status === 'ACTIVE' && !user.isEmailVerified) {
      await this.sendVerificationEmail(user.id, user.email, user.firstName);
    }
    return { success: true, message: GENERIC_VERIFY_MESSAGE };
  }

  async verifyEmail(token: string): Promise<{ success: boolean; message: string }> {
    const row = await this.userRepo.consumeActionToken('email-verify', CryptoUtil.sha256(token));
    if (!row) {
      throw new BusinessException('Invalid or expired verification token', 'INVALID_VERIFY_TOKEN', HttpStatus.BAD_REQUEST);
    }
    await this.userRepo.updateById(row.userId, { isEmailVerified: true, emailVerifiedAt: new Date() });
    return { success: true, message: 'Email verified successfully.' };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Multi-factor authentication (TOTP) and account recovery codes
  // ---------------------------------------------------------------------------------------------------------------

  private hashRecoveryCode(code: string): string {
    return CryptoUtil.sha256(`orion:recovery:${String(code).replace(/[\s-]/g, '').toUpperCase()}`);
  }

  private newRecoveryCodes(count = 10): { plain: string[]; hashes: string[] } {
    const plain = Array.from({ length: count }, () => {
      const raw = CryptoUtil.randomString(5).slice(0, 10).toUpperCase();
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    return { plain, hashes: plain.map((c) => this.hashRecoveryCode(c)) };
  }

  private async requireUser(userId: string) {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new BusinessException('User not found', 'USER_NOT_FOUND', HttpStatus.NOT_FOUND);
    return user;
  }

  async mfaStatus(userId: string) {
    const user = await this.requireUser(userId);
    return {
      enabled: user.twoFactorEnabled,
      recoveryCodesRemaining: user.twoFactorEnabled ? await this.userRepo.countUnusedRecoveryCodes(userId) : 0,
    };
  }

  /** Step 1: generate a TOTP seed (stored sealed, not yet active) and the otpauth URL for the authenticator app. */
  async beginMfaSetup(userId: string) {
    const user = await this.requireUser(userId);
    if (user.twoFactorEnabled) {
      throw new BusinessException('MFA is already enabled', 'MFA_ALREADY_ENABLED', HttpStatus.CONFLICT);
    }
    const secret = generateTotpSecret();
    await this.userRepo.updateById(userId, { twoFactorSecret: sealSecret(secret) });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email, process.env.MFA_ISSUER || 'Orion') };
  }

  /** Step 2: confirm with a code from the app. Activates MFA and returns the one-time recovery codes (shown once). */
  async enableMfa(userId: string, code: string) {
    const user = await this.requireUser(userId);
    if (user.twoFactorEnabled) {
      throw new BusinessException('MFA is already enabled', 'MFA_ALREADY_ENABLED', HttpStatus.CONFLICT);
    }
    if (!user.twoFactorSecret) {
      throw new BusinessException('Start MFA setup first', 'MFA_SETUP_REQUIRED', HttpStatus.BAD_REQUEST);
    }
    if (!(await this.checkTotp(user, code))) {
      throw new BusinessException('Invalid verification code', 'INVALID_MFA_CODE', HttpStatus.UNAUTHORIZED);
    }
    const codes = this.newRecoveryCodes();
    await this.userRepo.updateById(userId, { twoFactorEnabled: true });
    await this.userRepo.replaceRecoveryCodes(userId, codes.hashes);
    void this.mail.send({ to: user.email, subject: 'Two-factor authentication enabled', text: 'Two-factor authentication was turned on for your account.' });
    return { enabled: true, recoveryCodes: codes.plain };
  }

  /** Turning MFA off needs the password (when the account has one) and a current code or a recovery code. */
  async disableMfa(userId: string, dto: { password?: string; code?: string; recoveryCode?: string }) {
    const user = await this.requireUser(userId);
    if (!user.twoFactorEnabled) return { enabled: false };
    await this.assertReauth(user, dto);
    await this.userRepo.updateById(userId, { twoFactorEnabled: false, twoFactorSecret: null });
    await this.userRepo.replaceRecoveryCodes(userId, []);
    void this.mail.send({ to: user.email, subject: 'Two-factor authentication disabled', text: 'Two-factor authentication was turned off for your account. If this was not you, reset your password now.' });
    return { enabled: false };
  }

  /** Issues a fresh set of recovery codes, invalidating the old ones. Requires a current TOTP code. */
  async regenerateRecoveryCodes(userId: string, code: string) {
    const user = await this.requireUser(userId);
    if (!user.twoFactorEnabled) {
      throw new BusinessException('MFA is not enabled', 'MFA_NOT_ENABLED', HttpStatus.BAD_REQUEST);
    }
    if (!(await this.checkTotp(user, code))) {
      throw new BusinessException('Invalid verification code', 'INVALID_MFA_CODE', HttpStatus.UNAUTHORIZED);
    }
    const codes = this.newRecoveryCodes();
    await this.userRepo.replaceRecoveryCodes(userId, codes.hashes);
    return { recoveryCodes: codes.plain };
  }

  private async assertReauth(user: any, dto: { password?: string; code?: string; recoveryCode?: string }) {
    if (user.passwordHash) {
      if (!dto.password || !(await this.passwordService.compare(dto.password, user.passwordHash))) {
        throw new BusinessException('Password is incorrect', 'INVALID_PASSWORD', HttpStatus.UNAUTHORIZED);
      }
    }
    const ok = dto.recoveryCode
      ? await this.userRepo.consumeRecoveryCode(user.id, this.hashRecoveryCode(dto.recoveryCode))
      : await this.checkTotp(user, dto.code);
    if (!ok) throw new BusinessException('Invalid verification code', 'INVALID_MFA_CODE', HttpStatus.UNAUTHORIZED);
  }
}
