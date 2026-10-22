"use client";

import { useState } from "react";
import { Check, Sparkles } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function PricingSection() {
  const [isAnnual, setIsAnnual] = useState(false);

  const tiers = [
    {
      name: "Free Plan",
      id: "tier-free",
      href: "/register",
      priceMonthly: "₹0",
      priceAnnual: "₹0",
      periodText: "free forever",
      description: "Explore verified business records with daily replenished credits.",
      features: [
        "5 Daily verified leads",
        "Search & discovery engine",
        "Basic contact details",
        "Daily reset at 11:59 PM",
        "Community support",
      ],
      ctaText: "Get Started Free",
      mostPopular: false,
    },
    {
      name: "Starter Pack",
      id: "tier-starter",
      href: "/register",
      priceMonthly: "₹299",
      priceAnnual: "₹239",
      periodText: "/pack",
      description: "For individual founders and sales reps building targeted lead lists.",
      features: [
        "100 Lifetime lead credits",
        "Credits never expire",
        "Direct phone & email unlocks",
        "CSV & spreadsheet export",
        "Single user license",
        "Standard email support",
      ],
      ctaText: "Buy Starter",
      mostPopular: false,
    },
    {
      name: "Growth Pack",
      id: "tier-growth",
      href: "/register",
      priceMonthly: "₹499",
      priceAnnual: "₹399",
      periodText: "/pack",
      description: "Ideal for growing sales teams scaling outbound client acquisition.",
      features: [
        "350 Lifetime lead credits",
        "Credits never expire",
        "Decision maker contacts",
        "Full filter & export capabilities",
        "Single user license",
        "Priority email support",
      ],
      ctaText: "Buy Growth",
      mostPopular: true,
      badgeText: "Most Popular",
    },
    {
      name: "Agency Pack",
      id: "tier-agency",
      href: "/register",
      priceMonthly: "₹999",
      priceAnnual: "₹799",
      periodText: "/pack",
      description: "High-volume lead intelligence for outreach agencies and teams.",
      features: [
        "1,500 Lifetime lead credits",
        "Credits never expire",
        "Full executive & CXO contacts",
        "Bulk export engine",
        "Single user license",
        "Priority VIP support",
      ],
      ctaText: "Buy Agency",
      mostPopular: false,
      badgeText: "Best Value",
    },
    {
      name: "Enterprise Plan",
      id: "tier-enterprise",
      href: "/register",
      priceMonthly: "Custom",
      priceAnnual: "Custom",
      periodText: "tailored",
      description: "High-volume intelligence, dedicated infrastructure and workspace.",
      features: [
        "Custom high-volume credits",
        "Unlimited team users & RBAC",
        "Team workspace collaboration",
        "Bulk export engine",
        "Dedicated API access",
        "24x7 Priority account manager",
      ],
      ctaText: "Contact Sales",
      mostPopular: false,
      badgeText: "Enterprise",
    },
  ];

  return (
    <section id="pricing" className="py-20 sm:py-24 bg-gray-50 dark:bg-black">
      <div className="mx-auto max-w-7xl px-4">
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200 mb-4">
            <Sparkles className="w-3.5 h-3.5 text-zinc-900 dark:text-zinc-100" />
            Transparent INR Pricing
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl">
            Predictable pricing for every stage of growth
          </h2>
          <p className="mt-4 text-base text-gray-600 dark:text-gray-300">
            Start free with 5 daily leads. Top up with lifetime packs that never expire.
          </p>
        </div>

        {/* Billing Cycle Toggle */}
        <div className="mt-8 flex justify-center">
          <div className="relative flex rounded-full bg-white dark:bg-neutral-900 p-1 ring-1 ring-gray-200 dark:ring-neutral-800">
            <button
              onClick={() => setIsAnnual(false)}
              className={cn(
                "relative w-32 rounded-full px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none cursor-pointer",
                !isAnnual ? "bg-black text-white dark:bg-white dark:text-black shadow-sm" : "text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white"
              )}
            >
              One-Time / Monthly
            </button>
            <button
              onClick={() => setIsAnnual(true)}
              className={cn(
                "relative w-32 rounded-full px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none cursor-pointer",
                isAnnual ? "bg-black text-white dark:bg-white dark:text-black shadow-sm" : "text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white"
              )}
            >
              Annual Billing <span className="absolute -top-3 -right-2 bg-zinc-900 text-white dark:bg-white dark:text-zinc-950 text-[10px] px-2 py-0.5 rounded-full font-bold shadow-sm border border-zinc-700 dark:border-zinc-300">Save 20%</span>
            </button>
          </div>
        </div>

        {/* Pricing Cards Grid */}
        <div className="mx-auto mt-12 grid max-w-7xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-5">
          {tiers.map((tier) => (
            <div
              key={tier.id}
              className={cn(
                "flex flex-col justify-between rounded-xl bg-white dark:bg-neutral-900 p-6 shadow-sm ring-1 transition-all",
                tier.mostPopular
                  ? "ring-2 ring-zinc-900 dark:ring-white shadow-md relative"
                  : "ring-gray-200 dark:ring-neutral-800 hover:ring-gray-300 dark:hover:ring-neutral-700"
              )}
            >
              <div>
                <div className="flex items-center justify-between gap-x-2">
                  <h3
                    id={tier.id}
                    className="text-base font-bold text-gray-900 dark:text-white"
                  >
                    {tier.name}
                  </h3>
                  {tier.badgeText && (
                    <span className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                      tier.mostPopular
                        ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
                        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    )}>
                      {tier.badgeText}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400 min-h-[40px]">
                  {tier.description}
                </p>
                <div className="mt-4 flex items-baseline gap-x-1">
                  <span className="text-3xl font-bold tracking-tight font-mono text-gray-900 dark:text-white">
                    {isAnnual ? tier.priceAnnual : tier.priceMonthly}
                  </span>
                  <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                    {tier.periodText}
                  </span>
                </div>
                <ul
                  role="list"
                  className="mt-6 space-y-2.5 text-xs text-gray-600 dark:text-gray-400"
                >
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex gap-x-2 items-start">
                      <Check
                        className="h-4 w-4 shrink-0 text-zinc-900 dark:text-zinc-100 mt-0.5"
                        aria-hidden="true"
                      />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <Link
                href={tier.href}
                aria-describedby={tier.id}
                className={cn(
                  "mt-6 block rounded-lg px-3 py-2 text-center text-xs font-semibold transition-all",
                  tier.mostPopular
                    ? "bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200 shadow-sm"
                    : "border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white hover:bg-zinc-50 dark:hover:bg-zinc-800"
                )}
              >
                {tier.ctaText}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
