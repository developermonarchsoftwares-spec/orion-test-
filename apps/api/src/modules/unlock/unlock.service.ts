import { Injectable, Logger, HttpStatus, Inject, Optional } from '@nestjs/common';
import { UnlockRepository } from './unlock.repository';
import { CreditService } from '../credit/credit.service';
import { DiscoverService } from '../discover/discover.service';
import { BusinessRepository } from '../business/repositories/business.repository';
import { BusinessException } from '../../common/errors/business.exception';
import { DRIZZLE_DATABASE } from '../../database/database.constants';
import { DrizzleDb } from '../../database/database.provider';
import * as schema from '../../database/schema';
import { presentCompanyContact } from '../../common/privacy/data-classification';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { AuditLogService } from '../../common/services/audit-log.service';
import { IntegrationEventsService } from '../integrations/integration-events.service';

@Injectable()
export class UnlockService {
  private readonly logger = new Logger(UnlockService.name);

  constructor(
    private readonly unlockRepo: UnlockRepository,
    private readonly creditService: CreditService,
    private readonly discoverService: DiscoverService,
    private readonly businessRepo: BusinessRepository,
    @Inject(DRIZZLE_DATABASE)
    private readonly db: DrizzleDb,
    @Optional() private readonly auditLogService?: AuditLogService,
    @Optional() private readonly events?: IntegrationEventsService,
  ) {}

  /**
   * Atomically unlocks a business lead and returns full unmasked contact intelligence
   */
  async unlockBusiness(userId: string, businessId: string) {
    const business = await this.businessRepo.findById(businessId);
    if (!business) {
      throw new BusinessException('Business not found', 'BUSINESS_NOT_FOUND', HttpStatus.NOT_FOUND);
    }

    // Only a PUBLISHED company can be unlocked: a draft / archived one would be charged and then 404 on the profile.
    if (business.status !== 'PUBLISHED') {
      throw new BusinessException('Business not found', 'BUSINESS_NOT_FOUND', HttpStatus.NOT_FOUND);
    }

    // Check if already unlocked
    const existingUnlock = await this.unlockRepo.findUnlock(userId, businessId);
    if (existingUnlock) {
      const profile = await this.discoverService.getBusinessBySlug(businessId, userId);
      const wallet = await this.creditService.getWallet(userId);
      return {
        success: true,
        alreadyUnlocked: true,
        message: 'Lead is already unlocked in your account',
        creditsSpent: 0,
        balance: wallet.balance,
        business: profile,
      };
    }

    const unlockCost = 1;

    try {
      // Deduct credit atomically and create unlock record with race condition guard
      const result = await this.db.transaction(async (tx) => {
        // Serialise concurrent unlocks of the same (customer, business): the second waits here and then sees the first unlock,
        // so it is never charged (previously it deducted first and relied on the unique index to roll the deduction back).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`lead:unlock:${userId}:${businessId}`}))`);
        // The company may have been unpublished since the check above: re-check inside the transaction, before any charge.
        const [live] = await tx.select({ status: schema.businesses.status }).from(schema.businesses).where(eq(schema.businesses.id, businessId));
        if (!live || live.status !== 'PUBLISHED') {
          throw new BusinessException('Business not found', 'BUSINESS_NOT_FOUND', HttpStatus.NOT_FOUND);
        }
        // 1. Re-verify inside locked transaction if a concurrent request already unlocked it
        const alreadyInsideTx = await tx
          .select()
          .from(schema.leadUnlocks)
          .where(
            and(
              eq(schema.leadUnlocks.userId, userId),
              eq(schema.leadUnlocks.businessId, businessId),
            ),
          );

        if (alreadyInsideTx.length > 0) {
          return { isAlreadyUnlocked: true, wallet: null, unlockRecord: alreadyInsideTx[0] };
        }

        // 2. Deduct 1 credit (preferring dailyCredits first, then purchasedCredits)
        const deduction = await this.creditService.deductCredits(
          userId,
          unlockCost,
          `Unlocked lead: ${business.name}`,
          business.id,
          'UNLOCK_LEAD',
          tx,
        );

        // 3. Create unlock record
        const [unlockRecord] = await tx
          .insert(schema.leadUnlocks)
          .values({
            userId,
            businessId,
            creditsSpent: unlockCost,
          })
          .returning();

        return {
          isAlreadyUnlocked: false,
          wallet: deduction.wallet,
          unlockRecord,
        };
      });

      if (result.isAlreadyUnlocked) {
        const profile = await this.discoverService.getBusinessBySlug(businessId, userId);
        const wallet = await this.creditService.getWallet(userId);
        return {
          success: true,
          alreadyUnlocked: true,
          message: 'Lead is already unlocked in your account',
          creditsSpent: 0,
          balance: wallet.balance,
          business: profile,
        };
      }

      this.logger.log(`User ${userId} unlocked business ${businessId} (${business.name}) for ${unlockCost} credit`);
      void this.creditService.notifyIfLow(userId);
      void this.events?.emit(userId, 'lead.unlocked', { businessId, businessName: business.name, creditsSpent: unlockCost, balance: result.wallet?.balance ?? null });

      await this.auditLogService?.record({
        userId,
        action: 'BUSINESS_UNLOCKED',
        entityType: 'BUSINESS',
        entityId: businessId,
        newValues: { businessName: business.name, creditsSpent: unlockCost },
      });

      // Fetch full unmasked profile
      const unmaskedProfile = await this.discoverService.getBusinessBySlug(businessId, userId);

      return {
        success: true,
        alreadyUnlocked: false,
        message: 'Business unlocked successfully',
        creditsSpent: unlockCost,
        balance: result.wallet.balance,
        dailyCredits: result.wallet.dailyCredits,
        purchasedCredits: result.wallet.purchasedCredits,
        business: unmaskedProfile,
      };
    } catch (err: any) {
      // Catch unique violation code 23505 (concurrent insert on leadUnlocks)
      if (err?.code === '23505' || err?.cause?.code === '23505') {
        const profile = await this.discoverService.getBusinessBySlug(businessId, userId);
        const wallet = await this.creditService.getWallet(userId);
        return {
          success: true,
          alreadyUnlocked: true,
          message: 'Lead is already unlocked in your account',
          creditsSpent: 0,
          balance: wallet.balance,
          business: profile,
        };
      }
      throw err;
    }
  }

  /**
   * Retrieves paginated unlock history for user
   */
  async getUnlockHistory(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;

    const [totalRows, rows] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.leadUnlocks)
        .where(eq(schema.leadUnlocks.userId, userId)),
      this.db
        .select()
        .from(schema.leadUnlocks)
        .where(eq(schema.leadUnlocks.userId, userId))
        .orderBy(desc(schema.leadUnlocks.unlockedAt))
        .limit(limit)
        .offset(offset),
    ]);

    const total = totalRows[0]?.count || 0;
    const totalPages = Math.ceil(total / limit) || 1;

    if (rows.length === 0) {
      return {
        items: [],
        pagination: { page, limit, totalItems: total, totalPages },
      };
    }

    const businessIds = rows.map((r) => r.businessId);

    const [businesses, locations, scores, contacts] = await Promise.all([
      this.db.query.businesses.findMany({
        where: inArray(schema.businesses.id, businessIds),
        with: { industry: true, category: true },
      }),
      this.db
        .select()
        .from(schema.businessLocations)
        .where(inArray(schema.businessLocations.businessId, businessIds)),
      this.db
        .select()
        .from(schema.businessScores)
        .where(inArray(schema.businessScores.businessId, businessIds)),
      this.db
        .select()
        .from(schema.businessContacts)
        .where(inArray(schema.businessContacts.businessId, businessIds)),
    ]);

    const businessMap = new Map(businesses.map((b) => [b.id, b]));
    const locMap = new Map(locations.map((l) => [l.businessId, l]));
    const scoreMap = new Map(scores.map((s) => [s.businessId, s.orionScore]));
    const contactsMap = new Map<string, any[]>();
    contacts.forEach((c) => {
      const list = contactsMap.get(c.businessId) || [];
      list.push(c);
      contactsMap.set(c.businessId, list);
    });

    const items = rows.map((r) => {
      const b = businessMap.get(r.businessId);
      const loc = locMap.get(r.businessId);
      const leadContacts = contactsMap.get(r.businessId) || [];

      return {
        id: r.id,
        businessId: r.businessId,
        business: b
          ? {
              id: b.id,
              slug: b.slug,
              name: b.name,
              legalName: b.legalName,
              industryName: b.industry?.name,
              categoryName: b.category?.name,
              city: loc?.city || 'India',
              state: loc?.state || '',
              orionScore: scoreMap.get(b.id) ?? 75,
              opportunityTier: b.opportunityTier,
              isVerified: b.isVerified,
            }
          : null,
        // the caller unlocked this company; the shared disclosure policy still decides what is shown (Phase 10)
        contacts: leadContacts.map((c) => {
          const p = presentCompanyContact(c, { unlocked: true });
          return { fullName: p.fullName, title: p.title, email: p.email, phone: p.phone, linkedinUrl: p.linkedinUrl, emailKind: p.emailKind, phoneKind: p.phoneKind };
        }),
        creditsSpent: r.creditsSpent,
        unlockedAt: r.unlockedAt,
      };
    });

    return {
      items,
      pagination: {
        page,
        limit,
        totalItems: total,
        totalPages,
      },
    };
  }

  /**
   * Check if user has already unlocked a specific business
   */
  /** Ids of every business this user has unlocked: what the web app needs to mark cards as unlocked without paging through the history. */
  async getUnlockedBusinessIds(userId: string): Promise<{ unlockedIds: string[] }> {
    const rows = await this.db
      .select({ businessId: schema.leadUnlocks.businessId })
      .from(schema.leadUnlocks)
      .where(eq(schema.leadUnlocks.userId, userId));
    return { unlockedIds: rows.map((r) => String(r.businessId)) };
  }

  async checkStatus(userId: string, businessId: string) {
    const existing = await this.unlockRepo.findUnlock(userId, businessId);
    return {
      isUnlocked: !!existing,
      unlockedAt: existing?.unlockedAt || null,
    };
  }
}
