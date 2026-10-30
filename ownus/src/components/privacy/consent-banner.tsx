"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { getLocalConsent, setLocalConsent } from "@/lib/consent";

/** Cookie / privacy choices. "Reject" is as prominent as "Accept"; nothing optional runs before a choice is made. */
export function ConsentBanner() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(!getLocalConsent().decided);
    // the footer "Privacy choices" link reopens the banner, so a choice can be changed as easily as it was made
    const reopen = () => setOpen(true);
    window.addEventListener("orion:open-consent", reopen);
    return () => window.removeEventListener("orion:open-consent", reopen);
  }, []);
  if (!open) return null;

  const choose = (analytics: boolean) => {
    setLocalConsent({ analytics, marketing: false });
    setOpen(false);
    // Signed-in users: also record the choice in the server-side consent ledger.
    if (apiClient.getAccessToken()) {
      apiClient.request("/privacy/consents", { method: "PUT", body: JSON.stringify({ purpose: "ANALYTICS", granted: analytics }) }).catch(() => undefined);
    }
  };

  const btn = "px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer border border-zinc-300 dark:border-zinc-700";
  return (
    <div role="dialog" aria-label="Privacy choices" className="fixed bottom-4 left-4 right-4 sm:left-auto sm:max-w-md z-50 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-lg text-xs text-zinc-700 dark:text-zinc-300">
      <p className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Your privacy choices</p>
      <p className="mb-3">
        We use essential storage to keep you signed in. With your permission we also use anonymous analytics to improve Orion. Read our{" "}
        <Link href="/privacy-notice" className="underline">Privacy Notice</Link>. Nothing optional runs until you choose, and you can change this any time with "Privacy choices" in the footer or in Settings &rarr; Privacy.
      </p>
      <div className="flex gap-2">
        <button className={`${btn} bg-white dark:bg-zinc-900`} onClick={() => choose(false)}>Essential only</button>
        <button className={`${btn} bg-zinc-900 text-white dark:bg-white dark:text-zinc-900`} onClick={() => choose(true)}>Accept analytics</button>
      </div>
    </div>
  );
}
