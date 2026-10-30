"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { apiClient } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { PURPOSES } from "@/lib/compliance";
import { gateExempt, gateStateFor, type GateState } from "@/lib/consent-gate";
import { recordConsents } from "@/lib/consent-sync";
import { ConsentCheckboxes, type ConsentChoices } from "@/components/privacy/consent-checkboxes";

/**
 * Asks a signed-in person for the account consent when there is none on record (Google / Microsoft sign-ups, older accounts) or it was
 * withdrawn. Nothing is pre-ticked. Settings stays reachable so a person who does not agree can still export or delete their data.
 * If the consent state cannot be loaded the gate stays out of the way (a failed lookup must not lock everyone out); the API still records
 * every choice, so nothing is assumed.
 */
export function ConsentGate() {
  const { user } = useAuth();
  const pathname = usePathname();
  const [state, setState] = useState<GateState>("ok");
  const [choices, setChoices] = useState<ConsentChoices>({});
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try {
      setState(gateStateFor(await apiClient.request("/privacy/consents")));
    } catch {
      setState("ok");
    }
  }, []);

  useEffect(() => {
    if (user?.id) void check();
  }, [user?.id, check]);

  if (!user || state === "ok" || gateExempt(pathname)) return null;

  const agree = async () => {
    setBusy(true);
    const saved = await recordConsents({ ACCOUNT_SERVICE: true, PRODUCT_UPDATES: choices.PRODUCT_UPDATES === true, MARKETING: choices.MARKETING === true });
    setBusy(false);
    if (!saved) {
      toast.error("We could not save your choice. Please try again.");
      return;
    }
    setState("ok");
    toast.success(state === "withdrawn" ? "Thank you. Your account stays open." : "Thank you. Your choices were saved.");
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="consent-gate-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 id="consent-gate-title" className="text-base font-bold text-zinc-900 dark:text-zinc-100 mb-2">
          {state === "withdrawn" ? "Your account is scheduled for closure" : "Before you continue"}
        </h2>
        <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-4">
          {state === "withdrawn"
            ? "You withdrew your consent for Orion to process your account data, so your account will be erased after a short waiting period. Agree again to keep it."
            : "India's data protection law asks us to get your clear agreement before we process your personal data. Please read our Privacy Notice and choose below."}{" "}
          <Link href="/privacy-notice" target="_blank" className="underline">Privacy Notice</Link>
        </p>
        <ConsentCheckboxes purposes={PURPOSES.filter((p) => p.id !== "ANALYTICS")} value={choices} onChange={setChoices} idPrefix="gate" />
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || choices.ACCOUNT_SERVICE !== true}
            onClick={() => void agree()}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 disabled:opacity-50 cursor-pointer"
          >
            {busy ? "Saving…" : state === "withdrawn" ? "Agree and keep my account" : "Agree and continue"}
          </button>
          <Link href="/settings" className="px-4 py-2 rounded-lg text-xs font-medium border border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200">
            I do not agree: download or delete my data
          </Link>
        </div>
        <p className="mt-3 text-[11px] text-zinc-500">In Settings, open &ldquo;Privacy &amp; Data&rdquo; to download your data or delete your account.</p>
      </div>
    </div>
  );
}
