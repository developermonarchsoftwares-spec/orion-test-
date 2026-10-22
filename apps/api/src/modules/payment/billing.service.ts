import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { BusinessException } from '../../common/errors/business.exception';
import { DRIZZLE_DATABASE } from '../../database/database.constants';
import { DrizzleDb } from '../../database/database.provider';
import * as schema from '../../database/schema';
import { CreditRepository } from '../credit/credit.repository';
import { boundedPage } from '../../common/utils/pagination.util';

/** Plan tiers from lowest to highest. A package's slug is its tier; unknown slugs rank with the free tier. */
export const TIER_ORDER = ['free', 'starter', 'growth', 'agency', 'enterprise'] as const;
export type Tier = (typeof TIER_ORDER)[number];

export const tierRank = (tier: string | null | undefined): number => Math.max(0, TIER_ORDER.indexOf((tier ?? 'free') as Tier));

export interface ITopUpConfig {
  pricePerCreditInr: number;
  minCredits: number;
  maxCredits: number;
}

const CYCLE_DAYS: Record<string, number> = { monthly: 30, annual: 365 };

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Who issued the invoice. Comes from configuration only; nothing is invented. A plain function (no `this`) so rendering needs no service instance. */
const sellerFromEnv = (): { name: string; address: string; taxId: string } => ({
  name: process.env.INVOICE_SELLER_NAME || process.env.APP_NAME || 'Orion',
  address: process.env.INVOICE_SELLER_ADDRESS || '',
  taxId: process.env.INVOICE_SELLER_TAX_ID || '',
});

const rupees = (paise: number, currency = 'INR') => `${currency === 'INR' ? '₹' : currency + ' '}${(paise / 100).toFixed(2)}`;

export interface IRecordCreditedInput {
  userId: string;
  orderId?: string | null;
  paymentId: string;
  kind: 'PACKAGE' | 'TOPUP';
  description: string;
  credits: number;
  amountPaise: number;
  currency?: string;
  packageId?: string | null;
  packageSlug?: string | null;
  billingCycle?: string;
  /** Tax rate in basis points, read BEFORE the transaction opens (never query outside the caller's transaction from inside it). */
  taxBps?: number;
}

/**
 * Billing records around a credited payment: persisted checkout orders, one invoice per payment, the user's plan/tier,
 * billing history, and top-up pricing. Everything that must be atomic with the credit takes the caller's transaction.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: DrizzleDb,
    private readonly creditRepo: CreditRepository,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // Checkout orders
  // ---------------------------------------------------------------------------------------------------------------

  async recordOrder(input: {
    orderId: string;
    userId: string;
    kind: 'PACKAGE' | 'TOPUP';
    packageId?: string | null;
    credits: number;
    amountPaise: number;
    currency: string;
    billingCycle: string;
  }) {
    await this.db.insert(schema.paymentOrders).values({
      orderId: input.orderId,
      userId: input.userId,
      kind: input.kind,
      packageId: input.packageId ?? null,
      credits: input.credits,
      amountPaise: input.amountPaise,
      currency: input.currency,
      billingCycle: input.billingCycle,
    });
  }

  async findOrder(orderId: string) {
    const [row] = await this.db.select().from(schema.paymentOrders).where(eq(schema.paymentOrders.orderId, orderId)).limit(1);
    return row ?? null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Pricing config
  // ---------------------------------------------------------------------------------------------------------------

  /** Tax rate in basis points from the TAX_PERCENTAGE pricing setting (default 0: no tax shown). */
  async getTaxBps(): Promise<number> {
    const s = await this.creditRepo.getPricingSetting('TAX_PERCENTAGE');
    const pct = Number((s?.value as any)?.percentage ?? 0);
    return Number.isFinite(pct) && pct > 0 && pct < 100 ? Math.round(pct * 100) : 0;
  }

  async getTopUpConfig(): Promise<ITopUpConfig> {
    const s = await this.creditRepo.getPricingSetting('TOPUP_PRICING');
    const v = (s?.value as any) ?? {};
    const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : d);
    return {
      pricePerCreditInr: num(v.pricePerCreditInr, 1),
      minCredits: Math.floor(num(v.minCredits, 50)),
      maxCredits: Math.floor(num(v.maxCredits, 5000)),
    };
  }

  /** Server-side price for a top-up. The client only ever chooses a quantity. */
  async quoteTopUp(credits: number) {
    const cfg = await this.getTopUpConfig();
    if (!Number.isInteger(credits) || credits < cfg.minCredits || credits > cfg.maxCredits) {
      throw new BusinessException(`Top-up must be a whole number between ${cfg.minCredits} and ${cfg.maxCredits} credits`, 'INVALID_TOPUP_AMOUNT', HttpStatus.BAD_REQUEST, {
        min: cfg.minCredits,
        max: cfg.maxCredits,
      });
    }
    const amountPaise = Math.round(credits * cfg.pricePerCreditInr * 100);
    return { credits, amountPaise, amountInr: amountPaise / 100, pricePerCreditInr: cfg.pricePerCreditInr, currency: 'INR', min: cfg.minCredits, max: cfg.maxCredits };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Invoice + subscription, written in the same transaction as the credit
  // ---------------------------------------------------------------------------------------------------------------

  async recordCredited(tx: any, input: IRecordCreditedInput) {
    const currency = input.currency || 'INR';
    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
    const taxBps = input.taxBps ?? 0;
    // Prices are tax-inclusive; tax is carved out of the amount actually paid.
    const subtotal = taxBps ? Math.round((input.amountPaise * 10000) / (10000 + taxBps)) : input.amountPaise;
    const taxPaise = input.amountPaise - subtotal;

    const seq: any = await tx.execute(sql`SELECT nextval('invoice_number_seq')::int AS n`);
    const n = Number((seq.rows ?? seq)[0].n);
    const invoiceNumber = `INV-${new Date().getUTCFullYear()}-${String(n).padStart(6, '0')}`;

    const [invoice] = await tx
      .insert(schema.invoices)
      .values({
        invoiceNumber,
        userId: input.userId,
        orderId: input.orderId ?? null,
        paymentId: input.paymentId,
        kind: input.kind,
        description: input.description.slice(0, 255),
        credits: input.credits,
        currency,
        subtotalPaise: subtotal,
        taxBps,
        taxPaise,
        totalPaise: input.amountPaise,
        billingName: user ? `${user.firstName} ${user.lastName}`.trim() : null,
        billingEmail: user?.email ?? null,
      })
      .returning();

    if (input.orderId) {
      await tx
        .update(schema.paymentOrders)
        .set({ status: 'PAID', paymentId: input.paymentId, paidAt: new Date() })
        .where(eq(schema.paymentOrders.orderId, input.orderId));
    }

    if (input.kind === 'PACKAGE' && input.packageSlug) {
      await this.applyPlan(tx, input.userId, input.packageSlug, input.packageId ?? null, input.billingCycle || 'monthly', input.paymentId);
    }
    return invoice;
  }

  /**
   * A plan purchase grants its tier for one billing cycle. Buying a lower tier while a higher one is still active never
   * downgrades the customer; buying the same or a higher tier replaces the plan and restarts the period.
   */
  private async applyPlan(tx: any, userId: string, tier: string, packageId: string | null, cycle: string, paymentId: string) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (CYCLE_DAYS[cycle] ?? 30) * 86_400_000);
    const [current] = await tx.select().from(schema.userSubscriptions).where(eq(schema.userSubscriptions.userId, userId)).for('update');
    if (current && current.status === 'ACTIVE' && current.expiresAt > now && tierRank(current.tier) > tierRank(tier)) return;
    const values = { packageId, tier, billingCycle: cycle, status: 'ACTIVE', paymentId, startedAt: now, expiresAt, updatedAt: now };
    if (current) await tx.update(schema.userSubscriptions).set(values).where(eq(schema.userSubscriptions.id, current.id));
    else await tx.insert(schema.userSubscriptions).values({ userId, ...values });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Subscription / tier
  // ---------------------------------------------------------------------------------------------------------------

  async getSubscription(userId: string) {
    const [row] = await this.db.select().from(schema.userSubscriptions).where(eq(schema.userSubscriptions.userId, userId)).limit(1);
    const now = new Date();
    const active = !!row && row.status === 'ACTIVE' && row.expiresAt > now;
    const status = !row ? 'NONE' : row.status === 'CANCELLED' ? 'CANCELLED' : active ? 'ACTIVE' : 'EXPIRED';
    const tier: string = active ? row!.tier : 'free';
    return {
      tier,
      tierRank: tierRank(tier),
      status,
      billingCycle: row?.billingCycle ?? null,
      startedAt: row?.startedAt ?? null,
      expiresAt: row?.expiresAt ?? null,
      daysRemaining: active ? Math.max(0, Math.ceil((row!.expiresAt.getTime() - now.getTime()) / 86_400_000)) : 0,
      autoRenew: false,
    };
  }

  async hasTier(userId: string, minTier: string): Promise<boolean> {
    return tierRank((await this.getSubscription(userId)).tier) >= tierRank(minTier);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Invoices and history
  // ---------------------------------------------------------------------------------------------------------------

  async listInvoices(userId: string, limit = 50) {
    return this.db.select().from(schema.invoices).where(eq(schema.invoices.userId, userId)).orderBy(desc(schema.invoices.issuedAt)).limit(Math.min(Math.max(limit, 1), 200));
  }

  async getInvoice(userId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BusinessException('Invoice not found', 'INVOICE_NOT_FOUND', HttpStatus.NOT_FOUND);
    const [row] = await this.db.select().from(schema.invoices).where(and(eq(schema.invoices.id, id), eq(schema.invoices.userId, userId))).limit(1);
    if (!row) throw new BusinessException('Invoice not found', 'INVOICE_NOT_FOUND', HttpStatus.NOT_FOUND);
    return row;
  }

  /** Who issued the invoice. Comes from configuration only; nothing is invented. Shared by the HTML invoice and the PDF the website builds. */
  sellerDetails(): { name: string; address: string; taxId: string } {
    return sellerFromEnv();
  }

  /** Printable invoice (browser "Save as PDF"). Seller details come from configuration; nothing is invented. */
  renderInvoiceHtml(inv: typeof schema.invoices.$inferSelect): string {
    const seller = sellerFromEnv();
    const refunded = inv.status === 'REFUNDED';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(inv.invoiceNumber)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#111}h1{font-size:22px;margin:0}
table{width:100%;border-collapse:collapse;margin-top:16px}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}td.n,th.n{text-align:right}
.muted{color:#666}.tag{display:inline-block;padding:2px 8px;border-radius:4px;background:#eee}.red{background:#fde2e2}</style></head><body>
<h1>${esc(seller.name)}</h1><div class="muted">${esc(seller.address)}${seller.taxId ? `<br>Tax ID: ${esc(seller.taxId)}` : ''}</div>
<h2>Invoice ${esc(inv.invoiceNumber)} <span class="tag ${refunded ? 'red' : ''}">${esc(inv.status)}</span></h2>
<p>Date: ${esc(inv.issuedAt.toISOString().slice(0, 10))}<br>Billed to: ${esc(inv.billingName)} &lt;${esc(inv.billingEmail)}&gt;<br>Payment ref: ${esc(inv.paymentId)}</p>
<table><thead><tr><th>Description</th><th class="n">Credits</th><th class="n">Amount</th></tr></thead><tbody>
<tr><td>${esc(inv.description)}</td><td class="n">${inv.credits}</td><td class="n">${rupees(inv.subtotalPaise, inv.currency)}</td></tr>
${inv.taxBps ? `<tr><td>Tax (${(inv.taxBps / 100).toFixed(2)}%, included in price)</td><td></td><td class="n">${rupees(inv.taxPaise, inv.currency)}</td></tr>` : ''}
<tr><th>Total paid</th><th></th><th class="n">${rupees(inv.totalPaise, inv.currency)}</th></tr></tbody></table>
${refunded ? `<p class="muted">Refunded on ${esc(inv.refundedAt?.toISOString().slice(0, 10))}.</p>` : ''}
<p class="muted">Computer-generated invoice.</p></body></html>`;
  }

  /** One ledger of money-related events: purchases, top-ups, refunds, adjustments, with the invoice number when there is one. */
  async history(userId: string, page = 1, limit = 20) {
    const { page: safePage, limit: take, offset } = boundedPage(page, limit); // a huge page would overflow the offset (a database error)
    const types = ['PACKAGE_PURCHASE', 'PURCHASE', 'REFUND', 'ADMIN_ADJUSTMENT', 'BONUS'] as const;
    const where = and(eq(schema.creditTransactions.userId, userId), inArray(schema.creditTransactions.type, types as any));
    const rows = await this.db.select().from(schema.creditTransactions).where(where).orderBy(desc(schema.creditTransactions.createdAt)).limit(take).offset(offset);
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(schema.creditTransactions).where(where);
    const refs = rows.map((r) => r.referenceId).filter((x): x is string => !!x);
    const invs = refs.length ? await this.db.select().from(schema.invoices).where(and(eq(schema.invoices.userId, userId), inArray(schema.invoices.paymentId, refs))) : [];
    const byPayment = new Map(invs.map((i) => [i.paymentId, i]));
    return {
      page: safePage,
      limit: take,
      total: Number(n),
      items: rows.map((r) => {
        const inv = r.referenceId ? byPayment.get(r.referenceId) : undefined;
        return {
          id: r.id,
          type: r.type,
          description: r.description,
          credits: r.amount,
          balanceAfter: r.balanceAfter,
          paymentId: r.type === 'ADMIN_ADJUSTMENT' ? null : r.referenceId,
          invoice: inv ? { id: inv.id, number: inv.invoiceNumber, totalPaise: inv.totalPaise, currency: inv.currency, status: inv.status } : null,
          date: r.createdAt,
        };
      }),
    };
  }
}
