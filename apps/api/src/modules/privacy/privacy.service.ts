import { createHash } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { BusinessException } from '../../common/errors/business.exception';
import { AuditLogService } from '../../common/services/audit-log.service';
import { DRIZZLE_DATABASE } from '../../database/database.constants';
import { DrizzleDb } from '../../database/database.provider';
import * as s from '../../database/schema';
import { MailService } from '../../auth/mail/mail.service';
import { PasswordService } from '../../auth/services/password.service';
import { CONSENT_PURPOSES, DELETION_GRACE_MS, optionalRetentionDays, POLICY_VERSION, REQUEST_DEADLINE_MS, RETENTION, RETENTION_RUN } from './privacy.config';

export interface IRequestContext {
  ip: string | null;
  userAgent: string | null;
}

const ROW_CAP = 10000;

interface IRetentionRule {
  name: string;
  table: string;
  where: ReturnType<typeof sql>;
  update?: ReturnType<typeof sql>;
}
/** privacy_requests.note on a deletion that started because the account consent was withdrawn (so giving consent back can cancel exactly that one). */
export const WITHDRAWAL_NOTE = 'CONSENT_WITHDRAWN';
const hashEmail = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** The part of a database handle that a transaction and the database share. */
type EraseHandle = Pick<DrizzleDb, 'delete' | 'update' | 'execute'>;

/** Error text that is safe to log: the PostgreSQL code or the error class, never the message (a driver message can carry the failing SQL and its values). */
export const safeErrorLabel = (e: unknown): string => {
  // drizzle wraps the driver error in a query error whose own message is the failing SQL; the PostgreSQL code is on the wrapped error
  const x = e as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  if (typeof x?.code === 'string') return x.code;
  if (typeof x?.cause?.code === 'string') return x.cause.code;
  return typeof x?.name === 'string' ? x.name : 'Error';
};

/**
 * Removes or anonymises everything personal that belongs to one account, inside the caller's transaction. Shared by the scheduled
 * account erasure and by the post-restore reconciliation (deletion-ledger.ts), so a restored account is erased by exactly the same code.
 * Kept on purpose: the anonymised `users` shell, financial records, unlock rows (they hold the account id only) and audit events without
 * IP, user agent or the old/new values of the account's own entity.
 */
export async function eraseAccountData(tx: EraseHandle, userId: string): Promise<void> {
  await tx.delete(s.savedSearches).where(eq(s.savedSearches.userId, userId));
  await tx.delete(s.savedLeads).where(eq(s.savedLeads.userId, userId));
  await tx.delete(s.apiKeys).where(eq(s.apiKeys.userId, userId));
  await tx.delete(s.refreshTokens).where(eq(s.refreshTokens.userId, userId));
  await tx.delete(s.authActionTokens).where(eq(s.authActionTokens.userId, userId));
  await tx.delete(s.userRecoveryCodes).where(eq(s.userRecoveryCodes.userId, userId));
  await tx.delete(s.integrations).where(eq(s.integrations.userId, userId)); // cascades its deliveries
  await tx.delete(s.exportSchedules).where(eq(s.exportSchedules.userId, userId));
  await tx.delete(s.exportJobs).where(eq(s.exportJobs.userId, userId));
  await tx.delete(s.userRateOverrides).where(eq(s.userRateOverrides.userId, userId));
  await tx.update(s.userSubscriptions).set({ status: 'CANCELLED', updatedAt: new Date() }).where(eq(s.userSubscriptions.userId, userId));
  await tx.update(s.consentRecords).set({ ipAddress: null, userAgent: null }).where(eq(s.consentRecords.userId, userId));
  await tx.update(s.auditLogs).set({ ipAddress: null, userAgent: null }).where(eq(s.auditLogs.userId, userId));
  // events about the account itself (profile changes, verification, MFA) can carry its old and new field values
  await tx.update(s.auditLogs).set({ oldValues: null, newValues: null }).where(and(eq(s.auditLogs.entityType, 'user'), eq(s.auditLogs.entityId, userId)));
  await tx
    .update(s.users)
    .set({
      email: `deleted-${userId}@deleted.invalid`,
      firstName: 'Deleted',
      lastName: 'User',
      displayName: null,
      passwordHash: null,
      googleId: null,
      microsoftId: null,
      providerId: null,
      avatarUrl: null,
      profilePicture: null,
      phoneNumber: null,
      organizationName: null,
      twoFactorEnabled: false,
      twoFactorSecret: null,
      metadata: {},
      status: 'INACTIVE',
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(s.users.id, userId));
}

@Injectable()
export class PrivacyService {
  private readonly logger = new Logger(PrivacyService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: DrizzleDb,
    private readonly passwords: PasswordService,
    @Optional() private readonly audit?: AuditLogService,
    @Optional() private readonly mail?: MailService,
  ) {}

  // ---------------- consent ----------------

  /** Current choice per purpose (the latest ledger row). Default is "not granted": nothing optional is on until the user opts in. */
  async getConsents(userId: string) {
    const rows = await this.db
      .select()
      .from(s.consentRecords)
      .where(eq(s.consentRecords.userId, userId))
      .orderBy(desc(s.consentRecords.createdAt))
      .limit(500);
    const current: Record<string, { granted: boolean; updatedAt: string | null; policyVersion: string | null }> = {};
    for (const p of CONSENT_PURPOSES) current[p] = { granted: false, updatedAt: null, policyVersion: null };
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.purpose) || !current[r.purpose]) continue;
      seen.add(r.purpose);
      current[r.purpose] = { granted: r.granted, updatedAt: r.createdAt.toISOString(), policyVersion: r.policyVersion };
    }
    return { policyVersion: POLICY_VERSION, consents: current };
  }

  async setConsent(userId: string, purpose: string, granted: boolean, ctx: IRequestContext, source = 'settings') {
    // Withdrawing the account consent (DPDP Act) ends the lawful basis for holding the account, so it schedules the account for closure
    // in the same transaction as the ledger row. Giving the consent back cancels a closure that withdrawal started (never one the person
    // asked for themselves). The usual 7-day cooling-off applies.
    let closure: { executeAfter: Date; created: boolean; email: string } | null = null;
    await this.db.transaction(async (tx) => {
      await tx.insert(s.consentRecords).values({
        userId,
        purpose,
        granted,
        policyVersion: POLICY_VERSION,
        source,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (purpose !== 'ACCOUNT_SERVICE') return;
      if (granted) {
        await tx
          .update(s.privacyRequests)
          .set({ status: 'CANCELLED', completedAt: new Date() })
          .where(and(eq(s.privacyRequests.userId, userId), eq(s.privacyRequests.type, 'DELETE'), eq(s.privacyRequests.status, 'PENDING'), eq(s.privacyRequests.note, WITHDRAWAL_NOTE)));
        return;
      }
      const [user] = await tx.select().from(s.users).where(eq(s.users.id, userId)).limit(1);
      if (!user || user.deletedAt) return;
      const [open] = await tx
        .select()
        .from(s.privacyRequests)
        .where(and(eq(s.privacyRequests.userId, userId), eq(s.privacyRequests.type, 'DELETE'), eq(s.privacyRequests.status, 'PENDING')))
        .limit(1);
      if (open) {
        closure = { executeAfter: open.executeAfter!, created: false, email: user.email }; // a deletion is already scheduled: keep it
        return;
      }
      const now = Date.now();
      const [req] = await tx
        .insert(s.privacyRequests)
        .values({
          userId,
          emailHash: hashEmail(user.email),
          type: 'DELETE',
          status: 'PENDING',
          note: WITHDRAWAL_NOTE,
          executeAfter: new Date(now + DELETION_GRACE_MS),
          dueAt: new Date(now + REQUEST_DEADLINE_MS),
        })
        .returning();
      closure = { executeAfter: req.executeAfter!, created: true, email: user.email };
    });

    const scheduled = closure as { executeAfter: Date; created: boolean; email: string } | null;
    if (scheduled?.created) {
      await this.audit?.record({ userId, action: 'PRIVACY_CONSENT_WITHDRAWN_CLOSURE', entityType: 'user', entityId: userId, ipAddress: ctx.ip, userAgent: ctx.userAgent });
      await this.mail
        ?.send({
          to: scheduled.email,
          subject: 'Your Orion account will be closed',
          text: `You withdrew your consent for Orion to process your account data, so your account will be erased on ${scheduled.executeAfter.toUTCString()}. If you did this by mistake, sign in and agree again before then to keep your account.`,
        })
        .catch((e: Error) => this.logger.warn(`Withdrawal e-mail failed: ${e.message}`));
    }
    return { ...(await this.getConsents(userId)), accountClosure: scheduled ? { executeAfter: scheduled.executeAfter.toISOString() } : null };
  }

  // ---------------- access / portability (GDPR Art. 15, 20; CCPA right to know) ----------------

  /** Everything we hold about the user as machine-readable JSON. Secrets (password hash, 2FA secret, API key hashes, sealed integration credentials) are never included. */
  async exportData(userId: string, ctx: IRequestContext) {
    const [user] = await this.db.select().from(s.users).where(eq(s.users.id, userId)).limit(1);
    if (!user || user.deletedAt) throw new BusinessException('Account not found', 'NOT_FOUND', 404);

    const byUser = (table: any) => this.db.select().from(table).where(eq(table.userId, userId)).limit(ROW_CAP);
    const [keys, searches, leads, leadUnlocks, personUnlocks, wallets, credits, orders, invoices, refunds, subs, jobs, schedules, integ, consents, requests, audits] = await Promise.all([
      this.db
        .select({ id: s.apiKeys.id, name: s.apiKeys.name, keyPrefix: s.apiKeys.keyPrefix, scopes: s.apiKeys.scopes, createdAt: s.apiKeys.createdAt, lastUsedAt: s.apiKeys.lastUsedAt, expiresAt: s.apiKeys.expiresAt })
        .from(s.apiKeys)
        .where(eq(s.apiKeys.userId, userId)),
      byUser(s.savedSearches),
      byUser(s.savedLeads),
      byUser(s.leadUnlocks),
      byUser(s.personUnlocks),
      byUser(s.userWallets),
      byUser(s.creditTransactions),
      byUser(s.paymentOrders),
      byUser(s.invoices),
      byUser(s.refunds),
      byUser(s.userSubscriptions),
      // metadata only: the stored file bytes (up to 5,000 rows of other people's contact data per file) are not part of the data-access document
      this.db
        .select({ id: s.exportJobs.id, dataset: s.exportJobs.dataset, format: s.exportJobs.format, source: s.exportJobs.source, status: s.exportJobs.status, rowCount: s.exportJobs.rowCount, truncated: s.exportJobs.truncated, fileName: s.exportJobs.fileName, sizeBytes: s.exportJobs.sizeBytes, downloadCount: s.exportJobs.downloadCount, createdAt: s.exportJobs.createdAt, expiresAt: s.exportJobs.expiresAt })
        .from(s.exportJobs)
        .where(eq(s.exportJobs.userId, userId))
        .limit(ROW_CAP),
      byUser(s.exportSchedules),
      this.db
        .select({ id: s.integrations.id, type: s.integrations.type, name: s.integrations.name, status: s.integrations.status, targetUrl: s.integrations.targetUrl, events: s.integrations.events, createdAt: s.integrations.createdAt })
        .from(s.integrations)
        .where(eq(s.integrations.userId, userId)),
      byUser(s.consentRecords),
      byUser(s.privacyRequests),
      this.db
        .select({ action: s.auditLogs.action, entityType: s.auditLogs.entityType, ipAddress: s.auditLogs.ipAddress, userAgent: s.auditLogs.userAgent, createdAt: s.auditLogs.createdAt })
        .from(s.auditLogs)
        .where(eq(s.auditLogs.userId, userId))
        .orderBy(desc(s.auditLogs.createdAt))
        .limit(ROW_CAP),
    ]);

    const { passwordHash: _ph, twoFactorSecret: _tf, ...profile } = user;
    const now = new Date();
    await this.db.insert(s.privacyRequests).values({
      userId,
      emailHash: hashEmail(user.email),
      type: 'EXPORT',
      status: 'COMPLETED',
      completedAt: now,
      dueAt: new Date(now.getTime() + REQUEST_DEADLINE_MS),
    });
    await this.audit?.record({ userId, action: 'PRIVACY_EXPORT', entityType: 'user', entityId: userId, ipAddress: ctx.ip, userAgent: ctx.userAgent });

    return {
      format: 'orion-data-export/1',
      generatedAt: now.toISOString(),
      policyVersion: POLICY_VERSION,
      notice: 'Secrets (password hash, two-factor secret, API key hashes, sealed integration credentials) are intentionally excluded.',
      profile,
      apiKeys: keys,
      savedSearches: searches,
      savedLeads: leads,
      unlockedBusinesses: leadUnlocks,
      unlockedPeople: personUnlocks,
      creditWallet: wallets,
      creditTransactions: credits,
      paymentOrders: orders,
      invoices,
      refunds,
      subscriptions: subs,
      exportJobs: jobs,
      exportSchedules: schedules,
      integrations: integ,
      consents,
      privacyRequests: requests,
      activityLog: audits,
    };
  }

  // ---------------- erasure (GDPR Art. 17; CCPA right to delete) ----------------

  async listRequests(userId: string) {
    return this.db.select().from(s.privacyRequests).where(eq(s.privacyRequests.userId, userId)).orderBy(desc(s.privacyRequests.requestedAt)).limit(50);
  }

  /** Schedules the erasure after a cooling-off period. The user can cancel until then. */
  async requestDeletion(userId: string, confirmEmail: string, password: string | undefined, ctx: IRequestContext) {
    const [user] = await this.db.select().from(s.users).where(eq(s.users.id, userId)).limit(1);
    if (!user || user.deletedAt) throw new BusinessException('Account not found', 'NOT_FOUND', 404);
    if (user.email.toLowerCase() !== confirmEmail.trim().toLowerCase()) {
      throw new BusinessException('The e-mail does not match this account', 'VALIDATION_ERROR', 400);
    }
    if (user.passwordHash) {
      if (!password || !(await this.passwords.compare(password, user.passwordHash))) {
        throw new BusinessException('Password is incorrect', 'UNAUTHORIZED', 401);
      }
    }
    const [existing] = await this.db
      .select()
      .from(s.privacyRequests)
      .where(and(eq(s.privacyRequests.userId, userId), eq(s.privacyRequests.type, 'DELETE'), eq(s.privacyRequests.status, 'PENDING')))
      .limit(1);
    if (existing) return existing;

    const now = Date.now();
    const [req] = await this.db
      .insert(s.privacyRequests)
      .values({
        userId,
        emailHash: hashEmail(user.email),
        type: 'DELETE',
        status: 'PENDING',
        executeAfter: new Date(now + DELETION_GRACE_MS),
        dueAt: new Date(now + REQUEST_DEADLINE_MS),
      })
      .returning();
    await this.audit?.record({ userId, action: 'PRIVACY_DELETE_REQUESTED', entityType: 'user', entityId: userId, ipAddress: ctx.ip, userAgent: ctx.userAgent });
    await this.mail
      ?.send({
        to: user.email,
        subject: 'Your Orion account will be deleted',
        text: `We received your request to delete your Orion account. It will be erased on ${req.executeAfter!.toUTCString()}. If this was not you, or you changed your mind, sign in and cancel the request under Settings > Privacy before then.`,
      })
      .catch((e: Error) => this.logger.warn(`Deletion e-mail failed: ${e.message}`));
    return req;
  }

  async cancelDeletion(userId: string, ctx: IRequestContext) {
    const res = await this.db
      .update(s.privacyRequests)
      .set({ status: 'CANCELLED', completedAt: new Date() })
      .where(and(eq(s.privacyRequests.userId, userId), eq(s.privacyRequests.type, 'DELETE'), eq(s.privacyRequests.status, 'PENDING')))
      .returning({ id: s.privacyRequests.id });
    if (res.length) await this.audit?.record({ userId, action: 'PRIVACY_DELETE_CANCELLED', entityType: 'user', entityId: userId, ipAddress: ctx.ip, userAgent: ctx.userAgent });
    return { cancelled: res.length };
  }

  /**
   * Erases the account. Personal data is deleted or anonymised; financial records (orders, invoices, refunds, credit ledger) are kept
   * because tax and accounting law requires it; the user row stays as an anonymised shell so those records keep their reference.
   * Consent records are kept (proof of consent) with IP and user agent removed.
   */
  async executeDeletion(requestId: string): Promise<boolean> {
    const [req] = await this.db.select().from(s.privacyRequests).where(eq(s.privacyRequests.id, requestId)).limit(1);
    if (!req || req.type !== 'DELETE' || req.status !== 'PENDING' || !req.userId) return false;
    const userId = req.userId;
    let done = false;

    await this.db.transaction(async (tx) => {
      // Claim the request first so a concurrent run does nothing.
      const claimed = await tx
        .update(s.privacyRequests)
        .set({ status: 'COMPLETED', completedAt: new Date() })
        .where(and(eq(s.privacyRequests.id, requestId), eq(s.privacyRequests.status, 'PENDING')))
        .returning({ id: s.privacyRequests.id });
      if (!claimed.length) return;

      await eraseAccountData(tx, userId);
      done = true;
    });
    if (done) {
      await this.audit?.record({ userId, action: 'PRIVACY_DELETE_EXECUTED', entityType: 'user', entityId: userId });
      this.logger.log(`Erased account ${userId} (request ${requestId})`);
    }
    return done;
  }

  /** Runs every deletion whose cooling-off period has ended. */
  async runDueDeletions(): Promise<number> {
    const due = await this.db
      .select({ id: s.privacyRequests.id })
      .from(s.privacyRequests)
      .where(and(eq(s.privacyRequests.type, 'DELETE'), eq(s.privacyRequests.status, 'PENDING'), isNotNull(s.privacyRequests.executeAfter), lte(s.privacyRequests.executeAfter, new Date())))
      .limit(50);
    let n = 0;
    for (const d of due) {
      try {
        if (await this.executeDeletion(d.id)) n++;
      } catch (e) {
        this.logger.error(`Deletion ${d.id} failed: ${safeErrorLabel(e)}`);
        // recorded so the monitoring rules can alert on repeated privacy-processing failures (error code only, never the message)
        await this.audit?.record({ action: 'PRIVACY_DELETE_FAILED', entityType: 'privacy_request', entityId: d.id, outcome: 'FAILURE', newValues: { code: safeErrorLabel(e) } } as any);
      }
    }
    return n;
  }

  // ---------------- retention ----------------

  /**
   * One rule per kind of operational data. `where` selects the rows past retention; `update` (when present) blanks the identifying columns
   * of a selected row, otherwise the row is deleted. Rows are processed in batches by primary key, so a rule never holds a long lock and a
   * retry after a partial run simply continues. Financial records, consent rows themselves, audit events and the anonymised user shells
   * are not touched by any rule (see docs/DATA_RETENTION_POLICY.md, "Kept on purpose").
   */
  private retentionRules(now: Date): IRetentionRule[] {
    const ago = (days: number) => new Date(now.getTime() - days * 86400000);
    const rules: IRetentionRule[] = [
      { name: 'auditLogIps', table: 'audit_logs', update: sql`ip_address = NULL, user_agent = NULL`, where: sql`created_at < ${ago(RETENTION.auditLogIpDays)} AND (ip_address IS NOT NULL OR user_agent IS NOT NULL)` },
      { name: 'consentIps', table: 'consent_records', update: sql`ip_address = NULL, user_agent = NULL`, where: sql`created_at < ${ago(RETENTION.consentIpDays)} AND (ip_address IS NOT NULL OR user_agent IS NOT NULL)` },
      { name: 'adminOtps', table: 'admin_otps', where: sql`expires_at < ${new Date(now.getTime() - RETENTION.adminOtpHours * 3600000)}` },
      { name: 'integrationDeliveries', table: 'integration_deliveries', where: sql`created_at < ${ago(RETENTION.integrationDeliveryDays)} AND status IN ('SUCCEEDED','DEAD')` },
      { name: 'queueJobs', table: 'queue_jobs', where: sql`created_at < ${ago(RETENTION.queueJobDays)} AND status IN ('COMPLETED','FAILED')` },
      { name: 'privacyRequests', table: 'privacy_requests', where: sql`status IN ('COMPLETED','CANCELLED','REJECTED') AND completed_at < ${ago(RETENTION.completedPrivacyRequestDays)}` },
    ];
    // Off until a period is approved. Only rows that no longer drive anything: published rows, or rows of a batch that ended without publishing.
    const rawDays = optionalRetentionDays('RETENTION_IMPORT_RAW_PAYLOAD_DAYS');
    if (rawDays) {
      rules.push({
        name: 'importRawPayloads',
        table: 'import_records',
        update: sql`raw_payload = '{}'::jsonb, normalized_payload = NULL`,
        where: sql`created_at < ${ago(rawDays)} AND (raw_payload <> '{}'::jsonb OR normalized_payload IS NOT NULL)
          AND (is_published = true OR batch_id IN (SELECT id FROM import_batches WHERE status IN ('FAILED','CANCELLED')))`,
      });
    }
    return rules;
  }

  /**
   * Applies the retention schedule. `dryRun` only counts what is eligible and changes nothing. Each rule is independent: a failing rule is
   * reported (error code only, never a message) and the others still run. A rule that fills every batch is listed in `capped`: the rest is
   * picked up by the next run. Counts are aggregates; no row content is read into the log or the audit entry.
   */
  async runRetention(options: { dryRun?: boolean; trigger?: 'SCHEDULED' | 'MANUAL'; now?: Date } = {}) {
    const dryRun = options.dryRun ?? false;
    const trigger = options.trigger ?? 'SCHEDULED';
    const now = options.now ?? new Date();
    const counts: Record<string, number> = {};
    const capped: string[] = [];
    const failed: Record<string, string> = {};
    if (trigger === 'MANUAL') await this.audit?.record({ action: 'RETENTION_JOB_STARTED', entityType: 'retention', newValues: { dryRun } });

    for (const rule of this.retentionRules(now)) {
      counts[rule.name] = 0;
      try {
        if (dryRun) {
          const res: any = await this.db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(rule.table)} WHERE ${rule.where}`);
          counts[rule.name] = Number((res.rows ?? res)[0]?.n ?? 0);
          continue;
        }
        for (let batch = 0; batch < RETENTION_RUN.maxBatches; batch++) {
          const pick = sql`SELECT id FROM ${sql.raw(rule.table)} WHERE ${rule.where} ORDER BY id LIMIT ${RETENTION_RUN.batchSize}`;
          const res: any = rule.update
            ? await this.db.execute(sql`UPDATE ${sql.raw(rule.table)} SET ${rule.update} WHERE id IN (${pick})`)
            : await this.db.execute(sql`DELETE FROM ${sql.raw(rule.table)} WHERE id IN (${pick})`);
          const changed = res.rowCount ?? 0;
          counts[rule.name] += changed;
          if (changed < RETENTION_RUN.batchSize) break;
          if (batch === RETENTION_RUN.maxBatches - 1) capped.push(rule.name);
        }
      } catch (e) {
        failed[rule.name] = safeErrorLabel(e);
        this.logger.error(`Retention rule ${rule.name} failed: ${failed[rule.name]}`);
      }
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (Object.keys(failed).length) {
      await this.audit?.record({ action: 'RETENTION_JOB_FAILED', entityType: 'retention', outcome: 'FAILURE', newValues: { dryRun, trigger, failed, counts } } as any);
    } else if (trigger === 'MANUAL' || total > 0) {
      await this.audit?.record({ action: 'RETENTION_JOB_COMPLETED', entityType: 'retention', newValues: { dryRun, trigger, counts, capped } });
    }
    return { dryRun, counts, capped, failed };
  }

  /** Deletes or blanks operational data past its retention period. Returns counts per category. Scheduler entry point. */
  async enforceRetention(): Promise<Record<string, number>> {
    const dryRun = process.env.RETENTION_DRY_RUN === 'true'; // operator switch: report what would be removed, remove nothing
    return (await this.runRetention({ dryRun })).counts;
  }

  // ---------------- administration ----------------

  /** Open requests, soonest deadline first, so an administrator can see anything nearing the 30-day limit. */
  async adminOpenRequests() {
    return this.db.select().from(s.privacyRequests).where(eq(s.privacyRequests.status, 'PENDING')).orderBy(s.privacyRequests.dueAt).limit(200);
  }
}
