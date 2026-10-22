"use client";

import { useState, useEffect } from "react";
import { cn, formatNumber, formatRelativeDate } from "@/lib/utils";
import { CreditCard, Download, Check, HelpCircle, Loader2, Sparkles, Clock, ShieldCheck, Zap, ArrowRight, CheckCircle2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import { loadCheckoutScript, openCheckout, runPurchase } from "@/lib/razorpay-checkout";

export default function CreditsPage() {
  const { wallet, user, refreshProfile } = useAuth();
  const [activeTab, setActiveTab] = useState("transactions");
  const [historyTab, setHistoryTab] = useState("payments");
  const [isAnnual, setIsAnnual] = useState(false);
  const [packages, setPackages] = useState<any[]>([]);
  const [pricingConfig, setPricingConfig] = useState<any>({
    dailyFreeCredits: 5,
    annualDiscountPercentage: 20,
    defaultCurrency: "INR",
    currencySymbol: "₹",
  });
  const [transactions, setTransactions] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [purchasingPkgId, setPurchasingPkgId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadCreditData() {
      try {
        const [pkgs, config, txData, payData, invData] = await Promise.all([
          apiClient.credit.getPackages(),
          apiClient.credit.getConfig(),
          apiClient.credit.getTransactions(1, 25),
          apiClient.payments.getHistory(),
          // a failed invoice list must not take the rest of the page down with it
          apiClient.payments.listInvoices().catch(() => []),
        ]);
        if (pkgs && pkgs.length > 0) setPackages(pkgs);
        if (config) setPricingConfig(config);
        if (txData?.items) setTransactions(txData.items);
        if (payData) setPayments(payData);
        if (Array.isArray(invData)) setInvoices(invData);
      } catch (err) {
        console.warn("Credit API fallback active:", err);
      } finally {
        setIsLoading(false);
      }
    }
    loadCreditData();
  }, []);

  const handlePurchase = async (pkg: any) => {
    if (pkg.billingType === "CUSTOM" || pkg.priceInr === null) {
      toast.info("Connecting to Orion Enterprise sales advisory team...");
      window.location.href = "mailto:sales@orion.ai?subject=Enterprise%20Plan%20Inquiry%20-%20Orion%20Lead%20Intelligence";
      return;
    }

    if (pkg.priceInr === 0) {
      toast.info("The Free Plan includes 5 daily credits allocated automatically every day.");
      return;
    }

    const billingCycle = isAnnual ? "annual" : "monthly";
    setPurchasingPkgId(pkg.id);

    // The whole sequence (order, checkout window, server verification, refresh) lives in runPurchase so its rules are tested: the server sets the
    // price, a cancelled or failed payment verifies nothing, and the wallet and history reload only after the server confirmed the payment.
    const result = await runPurchase({
      createOrder: () => apiClient.payments.createOrder({ packageId: pkg.id, billingCycle, currency: pricingConfig.defaultCurrency || "INR" }),
      loadScript: () => loadCheckoutScript(),
      open: (order) =>
        openCheckout(order, {
          name: "Orion",
          description: `${pkg.name} - ${pkg.credits} credits`,
          prefill: { name: user?.displayName || undefined, email: user?.email || undefined },
          themeColor: "#18181b",
          onPaymentFailed: (message) => toast.error(message),
        }),
      verify: (payment) =>
        apiClient.payments.verify({
          razorpayOrderId: payment.razorpay_order_id,
          razorpayPaymentId: payment.razorpay_payment_id,
          razorpaySignature: payment.razorpay_signature,
          packageId: pkg.id,
          billingCycle,
        }),
      refresh: async () => {
        await refreshProfile();
        const [txData, payData, invData] = await Promise.all([apiClient.credit.getTransactions(1, 25), apiClient.payments.getHistory(), apiClient.payments.listInvoices().catch(() => [])]);
        if (txData?.items) setTransactions(txData.items);
        if (payData) setPayments(payData);
        if (Array.isArray(invData)) setInvoices(invData);
      },
    });
    setPurchasingPkgId(null);

    if (result.status === "success") toast.success(result.message || `Payment verified. ${pkg.credits} credits added to your account.`);
    else if (result.status === "cancelled") toast.info("Payment cancelled. You have not been charged and no credits were added.");
    else toast.error(result.message);
  };

  const currentBalance = wallet?.balance ?? 5;
  const dailyCredits = wallet?.dailyCredits ?? 5;
  const purchasedCredits = wallet?.purchasedCredits ?? 0;
  const lifetimePurchased = wallet?.lifetimePurchased ?? 0;
  const lifetimeUsed = wallet?.lifetimeUsed ?? 0;

  const displayPackages = packages.length > 0 ? packages : [
    {
      id: "free",
      slug: "free",
      name: "Free Plan",
      description: "Explore verified business records with daily replenished credits.",
      priceInr: 0,
      priceAnnualInr: 0,
      periodText: "free forever",
      credits: 5,
      billingType: "DAILY_FREE",
      popular: false,
      ctaText: "Get Started Free",
      features: [
        "5 Daily verified leads",
        "Search & discovery engine",
        "Basic contact details",
        "Daily reset at 11:59 PM",
        "Community support",
      ],
    },
    {
      id: "starter",
      slug: "starter",
      name: "Starter Pack",
      description: "For individual founders and sales reps building targeted lead lists.",
      priceInr: 299,
      priceAnnualInr: 239,
      periodText: "/pack",
      credits: 100,
      billingType: "ONE_TIME",
      popular: false,
      ctaText: "Buy Starter",
      features: [
        "100 Lifetime lead credits",
        "Credits never expire",
        "Direct phone & email unlocks",
        "CSV & spreadsheet export",
        "Single user license",
        "Standard email support",
      ],
    },
    {
      id: "growth",
      slug: "growth",
      name: "Growth Pack",
      description: "Ideal for growing sales teams scaling outbound client acquisition.",
      priceInr: 499,
      priceAnnualInr: 399,
      periodText: "/pack",
      credits: 350,
      billingType: "ONE_TIME",
      popular: true,
      badgeText: "Most Popular",
      ctaText: "Buy Growth",
      features: [
        "350 Lifetime lead credits",
        "Credits never expire",
        "Decision maker contacts",
        "Full filter & export capabilities",
        "Single user license",
        "Priority email support",
      ],
    },
    {
      id: "agency",
      slug: "agency",
      name: "Agency Pack",
      description: "High-volume lead intelligence for outreach agencies and teams.",
      priceInr: 999,
      priceAnnualInr: 799,
      periodText: "/pack",
      credits: 1500,
      billingType: "ONE_TIME",
      popular: false,
      badgeText: "Best Value",
      ctaText: "Buy Agency",
      features: [
        "1,500 Lifetime lead credits",
        "Credits never expire",
        "Full executive & CXO contacts",
        "Bulk export engine",
        "Single user license",
        "Priority VIP support",
      ],
    },
    {
      id: "enterprise",
      slug: "enterprise",
      name: "Enterprise Plan",
      description: "High-volume intelligence, dedicated infrastructure and workspace.",
      priceInr: null,
      priceAnnualInr: null,
      periodText: "tailored",
      credits: 0,
      billingType: "CUSTOM",
      popular: false,
      badgeText: "Enterprise",
      ctaText: "Contact Sales",
      features: [
        "Custom high-volume credits",
        "Unlimited team users & RBAC",
        "Team workspace collaboration",
        "Bulk export engine",
        "Dedicated API access",
        "24x7 Priority account manager",
      ],
    },
  ];

  return (
    <div className="max-w-6xl mx-auto space-y-8 pt-6 pb-16 text-zinc-900 dark:text-zinc-100">
      
      {/* Top Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-semibold bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700">
            <Zap className="w-3 h-3 fill-current" />
            Credit System & INR Billing
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          Wallet & Intelligence Credits
        </h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          Each credit unlocks full unmasked decision-maker contacts, direct phones, verified emails, and corporate registry intelligence.
        </p>
      </div>

      {/* Hero Cards: Balance & Rule Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        
        {/* Total Available Balance Card */}
        <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 shadow-xs flex flex-col justify-between relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-zinc-500/5 rounded-full blur-2xl pointer-events-none" />
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Total Available</span>
              <span className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
                <Zap className="w-4 h-4 text-zinc-900 dark:text-zinc-100 fill-current" />
              </span>
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-4xl font-black font-mono tracking-tight text-zinc-900 dark:text-zinc-100">
                {formatNumber(currentBalance)}
              </span>
              <span className="text-xs text-zinc-500 font-medium">Credits</span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between text-xs text-zinc-500">
            <span>Lifetime used:</span>
            <span className="font-semibold text-zinc-900 dark:text-zinc-100 font-mono">{formatNumber(lifetimeUsed)} leads</span>
          </div>
        </div>

        {/* Daily Free Credits Card */}
        <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                Daily Free Credits
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700">
                5 / Day
              </span>
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-4xl font-black font-mono tracking-tight text-zinc-900 dark:text-zinc-100">
                {formatNumber(dailyCredits)}
              </span>
              <span className="text-xs text-zinc-500 font-medium">remaining today</span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800/80 text-[11px] text-zinc-500 leading-normal">
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">Deducted First.</span> Resets every day at 11:59 PM. Expired daily credits do not roll over.
          </div>
        </div>

        {/* Purchased Credits Card */}
        <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 uppercase tracking-wider flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" />
                Purchased Credits
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700">
                Never Expire
              </span>
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-4xl font-black font-mono tracking-tight text-zinc-900 dark:text-zinc-100">
                {formatNumber(purchasedCredits)}
              </span>
              <span className="text-xs text-zinc-500 font-medium">active lifetime</span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800/80 text-[11px] text-zinc-500 leading-normal">
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">Lifetime Validity.</span> Consumed only after today&apos;s daily credits reach 0.
          </div>
        </div>

      </div>

      {/* Consumption Policy Banner */}
      <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 shrink-0">
            <HelpCircle className="w-4 h-4" />
          </div>
          <p className="text-zinc-600 dark:text-zinc-400 leading-relaxed">
            <strong className="text-zinc-900 dark:text-zinc-200 font-semibold">Zero Cost on Re-unlock:</strong> Previously unlocked leads never deduct credits again. Unlocking leads always uses your 5 daily credits before dipping into purchased packs.
          </p>
        </div>
      </div>

      {/* Pricing Packages Section */}
      <div className="space-y-6 pt-2">
        
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-zinc-900 dark:text-zinc-100" />
              Choose Your Intelligence Plan
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Configurable INR plans. Top up anytime with instant activation.
            </p>
          </div>

          {/* Annual Billing Switch */}
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <div className="relative flex rounded-full bg-zinc-100 dark:bg-zinc-900 p-1 border border-zinc-200 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setIsAnnual(false)}
                className={cn(
                  "relative px-3 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer",
                  !isAnnual
                    ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 shadow-xs"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
                )}
              >
                Standard
              </button>
              <button
                type="button"
                onClick={() => setIsAnnual(true)}
                className={cn(
                  "relative px-3 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5",
                  isAnnual
                    ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 shadow-xs"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
                )}
              >
                <span>Annual Billing</span>
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded-full bg-emerald-600 text-white">
                  Save {pricingConfig.annualDiscountPercentage}%
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* 5 Package Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {displayPackages.map((pkg) => {
            const isFree = pkg.priceInr === 0;
            const isCustom = pkg.billingType === "CUSTOM" || pkg.priceInr === null;
            const isPopular = pkg.popular;
            const isPurchasing = purchasingPkgId === pkg.id;

            // Formatted concise badge to prevent truncation and card overflow
            let badge = pkg.badgeText;
            if (isAnnual && pkg.priceInr && pkg.priceInr > 0) {
              badge = isPopular ? "Most Popular • 20% Off" : pkg.slug === "agency" ? "Best Value • 20% Off" : "Save 20%";
            } else if (pkg.badgeText && pkg.badgeText.toLowerCase().includes("annual")) {
              badge = isPopular ? "Most Popular" : pkg.slug === "agency" ? "Best Value" : null;
            }
            if (!badge && isPopular) badge = "Most Popular";

            const price = isAnnual && pkg.priceAnnualInr ? pkg.priceAnnualInr : pkg.priceInr;

            return (
              <div
                key={pkg.id}
                className={cn(
                  "rounded-2xl p-5 flex flex-col justify-between transition-all relative overflow-hidden h-full",
                  isPopular
                    ? "bg-zinc-900 text-white dark:bg-neutral-900 shadow-lg ring-2 ring-zinc-900 dark:ring-white"
                    : "bg-white dark:bg-neutral-900 ring-1 ring-zinc-200 dark:ring-neutral-800 hover:ring-zinc-300 dark:hover:ring-neutral-700 shadow-sm"
                )}
              >
                <div className="flex flex-col flex-1">
                  {/* Badge Row with Fixed Height for Consistent Baseline */}
                  <div className="h-6 mb-2 flex items-center justify-between">
                    {badge ? (
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider truncate max-w-full",
                          isPopular
                            ? "bg-white text-zinc-900 dark:bg-white dark:text-zinc-900 shadow-xs"
                            : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 border border-zinc-200/60 dark:border-zinc-700"
                        )}
                      >
                        {badge}
                      </span>
                    ) : (
                      <div className="h-5" />
                    )}
                  </div>

                  {/* Plan Name */}
                  <h3 className={cn("text-base font-bold tracking-tight leading-snug", isPopular ? "text-white" : "text-gray-900 dark:text-white")}>
                    {pkg.name}
                  </h3>

                  {/* Description - Fixed Height for Uniform Horizontal Alignment */}
                  <p className={cn(
                    "text-xs leading-relaxed min-h-[38px] line-clamp-2 mt-2 mb-4",
                    isPopular ? "text-zinc-300" : "text-gray-500 dark:text-gray-400"
                  )}>
                    {pkg.description}
                  </p>

                  {/* Pricing Display - Standardized Height */}
                  <div className="flex items-baseline gap-x-1.5 mb-5 pb-4 border-b border-zinc-100 dark:border-zinc-800/80">
                    <span className={cn("text-3xl font-extrabold tracking-tight font-mono", isPopular ? "text-white" : "text-gray-900 dark:text-white")}>
                      {isCustom ? "Custom" : isFree ? "₹0" : `₹${price?.toLocaleString()}`}
                    </span>
                    <span className={cn("text-xs font-semibold", isPopular ? "text-zinc-400" : "text-gray-500 dark:text-gray-400")}>
                      {pkg.periodText || (isFree ? "free forever" : isCustom ? "tailored" : "/pack")}
                    </span>
                  </div>

                  {/* Features List */}
                  <ul role="list" className="space-y-2.5 text-xs text-gray-600 dark:text-gray-400 mb-6 flex-1">
                    {(pkg.features || []).map((feature: string, i: number) => (
                      <li key={i} className="flex gap-x-2 items-start leading-snug">
                        <Check className={cn(
                          "h-3.5 w-3.5 shrink-0 mt-0.5",
                          isPopular ? "text-white" : "text-zinc-900 dark:text-zinc-100"
                        )} />
                        <span className={isPopular ? "text-zinc-200" : ""}>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Purchase / Action Button */}
                <button
                  onClick={() => handlePurchase(pkg)}
                  disabled={isPurchasing || (isFree && dailyCredits > 0)}
                  className={cn(
                    "mt-auto block w-full rounded-lg px-3 py-2.5 text-center text-xs font-semibold transition-all cursor-pointer",
                    isPopular
                      ? "bg-white text-zinc-900 hover:bg-zinc-100 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100 shadow-sm font-bold"
                      : isFree
                      ? "border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 text-zinc-500 dark:text-zinc-400 cursor-default"
                      : "border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white hover:bg-zinc-50 dark:hover:bg-zinc-800 shadow-xs"
                  )}
                >
                  {isPurchasing ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Processing...
                    </span>
                  ) : isFree ? (
                    "Get Started Free"
                  ) : isCustom ? (
                    "Contact Sales"
                  ) : (
                    pkg.ctaText || `Buy ${pkg.name.replace(" Pack", "")}`
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tabs: Transaction History & Razorpay Ledger */}
      <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden shadow-xs">
        <div className="flex border-b border-zinc-200 dark:border-zinc-800">
          <button
            onClick={() => setActiveTab("transactions")}
            className={cn(
              "px-6 py-3.5 text-xs font-semibold transition-colors border-b-2 cursor-pointer",
              activeTab === "transactions" 
                ? "border-zinc-900 dark:border-white text-zinc-900 dark:text-white" 
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
            )}
          >
            Credit Transaction Ledger
          </button>
          <button
            onClick={() => setActiveTab("billing")}
            className={cn(
              "px-6 py-3.5 text-xs font-semibold transition-colors border-b-2 cursor-pointer",
              activeTab === "billing" 
                ? "border-zinc-900 dark:border-white text-zinc-900 dark:text-white" 
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
            )}
          >
            Razorpay Payments & Invoices
          </button>
        </div>

        <div className="p-0">
          {activeTab === "transactions" && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs whitespace-nowrap">
                <thead className="bg-zinc-50 dark:bg-zinc-900 text-zinc-500 uppercase text-[11px] font-semibold border-b border-zinc-200 dark:border-zinc-800">
                  <tr>
                    <th className="px-6 py-3.5">Date</th>
                    <th className="px-6 py-3.5">Type</th>
                    <th className="px-6 py-3.5">Balance Pool</th>
                    <th className="px-6 py-3.5">Description</th>
                    <th className="px-6 py-3.5 text-right">Credits</th>
                    <th className="px-6 py-3.5 text-right">Total Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {transactions.length > 0 ? (
                    transactions.map((tx: any) => {
                      const isPositive = tx.amount > 0;
                      const balanceType = tx.balanceType || (tx.type.includes("DAILY") ? "DAILY" : "PURCHASED");

                      return (
                        <tr key={tx.id} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50">
                          <td className="px-6 py-3.5 text-zinc-500 font-mono">
                            {tx.createdAt ? formatRelativeDate(tx.createdAt) : tx.date || "Recent"}
                          </td>
                          <td className="px-6 py-3.5">
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-medium border bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border-zinc-200 dark:border-zinc-700">
                              {tx.type}
                            </span>
                          </td>
                          <td className="px-6 py-3.5">
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border-zinc-200 dark:border-zinc-700">
                              {balanceType}
                            </span>
                          </td>
                          <td className="px-6 py-3.5 text-zinc-900 dark:text-zinc-100 font-medium">{tx.description}</td>
                          <td className={cn("px-6 py-3.5 text-right font-mono font-semibold", isPositive ? "text-zinc-900 dark:text-zinc-100 font-bold" : "text-zinc-500")}>
                            {isPositive ? `+${tx.amount}` : tx.amount}
                          </td>
                          <td className="px-6 py-3.5 text-right text-zinc-900 dark:text-zinc-100 font-mono font-medium">
                            {tx.balanceAfter !== undefined ? tx.balanceAfter.toLocaleString() : tx.balance?.toLocaleString()}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-zinc-500">
                        No transactions recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "billing" && (
            <div className="p-6">
              <div className="flex gap-2 mb-6">
                <button
                  onClick={() => setHistoryTab("payments")}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border cursor-pointer",
                    historyTab === "payments" 
                      ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 border-zinc-900 dark:border-white font-semibold" 
                      : "bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50"
                  )}
                >
                  Payment History
                </button>
                <button
                  onClick={() => setHistoryTab("invoices")}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border cursor-pointer",
                    historyTab === "invoices" 
                      ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 border-zinc-900 dark:border-white font-semibold" 
                      : "bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50"
                  )}
                >
                  Invoices
                </button>
              </div>

              {historyTab === "payments" ? (
                <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs whitespace-nowrap">
                    <thead className="bg-zinc-50 dark:bg-zinc-900 text-zinc-500 uppercase text-[11px] font-semibold border-b border-zinc-200 dark:border-zinc-800">
                      <tr>
                        <th className="px-6 py-3.5">Date</th>
                        <th className="px-6 py-3.5">Method</th>
                        <th className="px-6 py-3.5">Description</th>
                        <th className="px-6 py-3.5">Credits</th>
                        <th className="px-6 py-3.5">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {payments.length > 0 ? (
                        payments.map((p: any) => (
                          <tr key={p.id}>
                            <td className="px-6 py-3.5 text-zinc-500 font-mono">
                              {p.date ? formatRelativeDate(p.date) : "Recent"}
                            </td>
                            <td className="px-6 py-3.5 text-zinc-900 dark:text-zinc-100 flex items-center gap-2 font-medium">
                              <CreditCard className="w-3.5 h-3.5 text-zinc-400" />
                              Razorpay UPI / Card
                            </td>
                            <td className="px-6 py-3.5 font-medium">{p.description}</td>
                            <td className="px-6 py-3.5 font-mono font-semibold text-zinc-900 dark:text-zinc-100">+{p.credits}</td>
                            <td className="px-6 py-3.5">
                              <span className="px-2 py-0.5 rounded-md text-[11px] font-medium border bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border-zinc-200 dark:border-zinc-700">
                                Captured
                              </span>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-zinc-500">
                            No payment history recorded yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs whitespace-nowrap">
                    <thead className="bg-zinc-50 dark:bg-zinc-900 text-zinc-500 uppercase text-[11px] font-semibold border-b border-zinc-200 dark:border-zinc-800">
                      <tr>
                        <th className="px-6 py-3.5">Invoice #</th>
                        <th className="px-6 py-3.5">Date</th>
                        <th className="px-6 py-3.5">Package</th>
                        <th className="px-6 py-3.5">Status</th>
                        <th className="px-6 py-3.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {invoices.length > 0 ? (
                        invoices.map((inv: any) => (
                          <tr key={inv.id}>
                            <td className="px-6 py-3.5 font-mono font-medium text-zinc-900 dark:text-zinc-100">
                              {inv.invoiceNumber}
                            </td>
                            <td className="px-6 py-3.5 text-zinc-500 font-mono">
                              {inv.issuedAt ? formatRelativeDate(inv.issuedAt) : "Recent"}
                            </td>
                            <td className="px-6 py-3.5 font-medium">{inv.description}</td>
                            <td className="px-6 py-3.5">
                              <span className="px-2 py-0.5 rounded-md text-[11px] font-medium border bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border-zinc-200 dark:border-zinc-700">
                                {inv.status === "REFUNDED" ? "Refunded" : "Paid"}
                              </span>
                            </td>
                            <td className="px-6 py-3.5 text-right">
                              <button
                                onClick={async () => {
                                  try {
                                    // the real invoice, built by the server from the recorded payment
                                    await apiClient.payments.downloadInvoicePdf(inv.id, inv.invoiceNumber);
                                    toast.success(`Downloaded invoice ${inv.invoiceNumber} (PDF)`);
                                  } catch (err: any) {
                                    toast.error(err?.message || "Failed to download invoice");
                                  }
                                }}
                                className="text-zinc-900 dark:text-zinc-100 hover:underline inline-flex items-center gap-1 text-xs font-semibold cursor-pointer"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Download PDF</span>
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-zinc-500">
                            No invoices generated yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
