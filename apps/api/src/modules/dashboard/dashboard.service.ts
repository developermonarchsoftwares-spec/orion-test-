import { Injectable, Logger, Inject } from '@nestjs/common';
import { DRIZZLE_DATABASE } from '../../database/database.constants';
import { DrizzleDb } from '../../database/database.provider';
import * as schema from '../../database/schema';
import { eq, desc, sql, and } from 'drizzle-orm';
import { CreditService } from '../credit/credit.service';

const rowsOf = (res: any): any[] => (res?.rows ?? res) as any[];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Percent change from `previous` to `current`, or null when there is nothing to compare against (never a made-up 0). */
export const percentChange = (current: number, previous: number): number | null =>
  previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;

/** The 5 largest industries as shares of the published catalogue, with everything else folded into one "Other" entry. */
export const industryShares = (rows: Array<{ name: string; n: number }>, top = 5): Array<{ name: string; count: number; share: number }> => {
  const total = rows.reduce((s, r) => s + r.n, 0);
  if (total === 0) return [];
  const sorted = [...rows].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const head = sorted.slice(0, top);
  const rest = sorted.slice(top).reduce((s, r) => s + r.n, 0);
  const all = rest > 0 ? [...head, { name: 'Other', n: rest }] : head;
  return all.map((r) => ({ name: r.name, count: r.n, share: Math.round((r.n / total) * 100) }));
};

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: DrizzleDb,
    private readonly creditService: CreditService,
  ) {}

  /**
   * Everything on the dashboard that is a count over time or a share, read from the database:
   *  - newBusinessesToday: businesses published since the start of today (and yesterday's count, for the trend)
   *  - discoveryTrend: per month of this year, businesses published (the catalogue) and this user's unlocks ("leads converted")
   *  - industryDistribution: the largest industries of the published catalogue
   *  - trends: last 30 days against the 30 days before, for this user's unlocks and saved leads (null when there is nothing to compare)
   */
  private async getMetrics(userId: string) {
    const [published, unlocksByMonth, today, windows, byIndustry] = await Promise.all([
      this.db.execute(sql`
        SELECT EXTRACT(MONTH FROM COALESCE(published_at, created_at))::int AS m, count(*)::int AS n
        FROM businesses
        WHERE status = 'PUBLISHED' AND COALESCE(published_at, created_at) >= date_trunc('year', now())
        GROUP BY 1`),
      this.db.execute(sql`
        SELECT EXTRACT(MONTH FROM unlocked_at)::int AS m, count(*)::int AS n
        FROM lead_unlocks
        WHERE user_id = ${userId} AND unlocked_at >= date_trunc('year', now())
        GROUP BY 1`),
      this.db.execute(sql`
        SELECT
          count(*) FILTER (WHERE COALESCE(published_at, created_at) >= date_trunc('day', now()))::int AS today,
          count(*) FILTER (WHERE COALESCE(published_at, created_at) >= date_trunc('day', now()) - interval '1 day'
                             AND COALESCE(published_at, created_at) <  date_trunc('day', now()))::int AS yesterday,
          EXTRACT(YEAR FROM now())::int AS year,
          EXTRACT(MONTH FROM now())::int AS month
        FROM businesses WHERE status = 'PUBLISHED'`),
      this.db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM lead_unlocks WHERE user_id = ${userId} AND unlocked_at >= now() - interval '30 days') AS unlocks_now,
          (SELECT count(*)::int FROM lead_unlocks WHERE user_id = ${userId} AND unlocked_at >= now() - interval '60 days' AND unlocked_at < now() - interval '30 days') AS unlocks_prev,
          (SELECT count(*)::int FROM saved_leads WHERE user_id = ${userId} AND created_at >= now() - interval '30 days') AS saved_now,
          (SELECT count(*)::int FROM saved_leads WHERE user_id = ${userId} AND created_at >= now() - interval '60 days' AND created_at < now() - interval '30 days') AS saved_prev`),
      this.db.execute(sql`
        SELECT COALESCE(i.name, 'Other') AS name, count(*)::int AS n
        FROM businesses b LEFT JOIN industries i ON i.id = b.industry_id
        WHERE b.status = 'PUBLISHED'
        GROUP BY 1`),
    ]);

    const t = rowsOf(today)[0] ?? {};
    const w = rowsOf(windows)[0] ?? {};
    const month = Number(t.month) || new Date().getUTCMonth() + 1;
    const pub = new Map(rowsOf(published).map((r: any) => [Number(r.m), Number(r.n)]));
    const conv = new Map(rowsOf(unlocksByMonth).map((r: any) => [Number(r.m), Number(r.n)]));

    return {
      year: Number(t.year) || new Date().getUTCFullYear(),
      newBusinessesToday: Number(t.today) || 0,
      discoveryTrend: Array.from({ length: month }, (_, i) => ({ month: MONTH_NAMES[i], discovered: pub.get(i + 1) ?? 0, converted: conv.get(i + 1) ?? 0 })),
      industryDistribution: industryShares(rowsOf(byIndustry).map((r: any) => ({ name: String(r.name), n: Number(r.n) }))),
      trends: {
        newBusinesses: percentChange(Number(t.today) || 0, Number(t.yesterday) || 0),
        unlockedLeads: percentChange(Number(w.unlocks_now) || 0, Number(w.unlocks_prev) || 0),
        savedLeads: percentChange(Number(w.saved_now) || 0, Number(w.saved_prev) || 0),
      },
    };
  }

  /**
   * Generates comprehensive customer dashboard analytics and activity feeds
   */
  async getDashboardSummary(userId: string) {
    const [wallet, unlockCountRow, savedLeadsCountRow, savedSearchesCountRow] = await Promise.all([
      this.creditService.getWallet(userId),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.leadUnlocks)
        .where(eq(schema.leadUnlocks.userId, userId)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.savedLeads)
        .where(eq(schema.savedLeads.userId, userId)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.savedSearches)
        .where(eq(schema.savedSearches.userId, userId)),
    ]);

    // Recent unlocks
    const recentUnlocks = await this.db
      .select({
        id: schema.leadUnlocks.id,
        businessId: schema.leadUnlocks.businessId,
        creditsSpent: schema.leadUnlocks.creditsSpent,
        unlockedAt: schema.leadUnlocks.unlockedAt,
      })
      .from(schema.leadUnlocks)
      .where(eq(schema.leadUnlocks.userId, userId))
      .orderBy(desc(schema.leadUnlocks.unlockedAt))
      .limit(5);

    let enrichedUnlocks: any[] = [];
    if (recentUnlocks.length > 0) {
      const bIds = recentUnlocks.map((u) => u.businessId);
      const [businesses, locations, scores] = await Promise.all([
        this.db.query.businesses.findMany({
          where: sql`${schema.businesses.id} IN ${bIds}`,
          with: { industry: true },
        }),
        this.db.select().from(schema.businessLocations).where(sql`${schema.businessLocations.businessId} IN ${bIds}`),
        this.db.select().from(schema.businessScores).where(sql`${schema.businessScores.businessId} IN ${bIds}`),
      ]);

      const bMap = new Map(businesses.map((b) => [b.id, b]));
      const lMap = new Map(locations.map((l) => [l.businessId, l]));
      const sMap = new Map(scores.map((s) => [s.businessId, s.orionScore]));

      enrichedUnlocks = recentUnlocks.map((u) => {
        const b = bMap.get(u.businessId);
        const loc = lMap.get(u.businessId);
        return {
          id: u.id,
          businessId: u.businessId,
          name: b?.name || 'Company',
          slug: b?.slug,
          industry: b?.industry?.name,
          city: loc?.city || 'India',
          orionScore: sMap.get(u.businessId) ?? null, // a business without a score has none; never an invented default
          unlockedAt: u.unlockedAt,
        };
      });
    }

    // Recent saved leads
    const recentSavedLeads = await this.db
      .select()
      .from(schema.savedLeads)
      .where(eq(schema.savedLeads.userId, userId))
      .orderBy(desc(schema.savedLeads.createdAt))
      .limit(5);

    // Recent searches
    const recentSearches = await this.db
      .select()
      .from(schema.savedSearches)
      .where(eq(schema.savedSearches.userId, userId))
      .orderBy(desc(schema.savedSearches.createdAt))
      .limit(5);

    // Top recommended businesses (HIGH opportunity tier)
    const recommendations = await this.db.query.businesses.findMany({
      where: and(
        eq(schema.businesses.status, 'PUBLISHED'),
        eq(schema.businesses.opportunityTier, 'HIGH'),
      ),
      limit: 4,
      with: { industry: true, category: true },
    });

    const metrics = await this.getMetrics(userId);

    return {
      wallet: {
        balance: wallet.balance,
        lifetimePurchased: wallet.lifetimePurchased,
        lifetimeUsed: wallet.lifetimeUsed,
      },
      stats: {
        unlockedLeadsCount: unlockCountRow[0]?.count || 0,
        savedLeadsCount: savedLeadsCountRow[0]?.count || 0,
        savedSearchesCount: savedSearchesCountRow[0]?.count || 0,
        newBusinessesCount: metrics.newBusinessesToday,
      },
      trends: metrics.trends,
      year: metrics.year,
      discoveryTrend: metrics.discoveryTrend,
      industryDistribution: metrics.industryDistribution,
      recentUnlocks: enrichedUnlocks,
      recentSavedLeads: recentSavedLeads.map((sl) => ({
        id: sl.id,
        businessId: sl.businessId,
        pipelineStage: sl.pipelineStage,
        tags: sl.tags,
        createdAt: sl.createdAt,
      })),
      recentSearches: recentSearches.map((s) => ({
        id: s.id,
        name: s.name,
        filters: s.filters,
        alertEnabled: s.alertEnabled,
        createdAt: s.createdAt,
      })),
      recommendations: recommendations.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        legalName: r.legalName,
        industryName: r.industry?.name,
        opportunityTier: r.opportunityTier,
        isVerified: r.isVerified,
      })),
    };
  }
}
