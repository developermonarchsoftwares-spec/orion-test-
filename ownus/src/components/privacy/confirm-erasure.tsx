"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { GRIEVANCE } from "@/lib/compliance";

/**
 * Lands from the link in the erasure-request e-mail: /data-rights/verify?ref=DR-XXXX#token=SECRET. The secret is in the URL fragment, so it
 * is not sent to any server by the click; it is read here, removed from the address bar, and sent only when the person presses the button.
 * A click is required (not an automatic call on load) so a mail scanner that opens links cannot confirm a removal on someone's behalf.
 */
export function ConfirmErasure() {
  const [ref, setRef] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<"ready" | "busy" | "done" | "pending-review" | "error">("ready");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    setRef(params.get("ref"));
    setToken(hash.get("token"));
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  const confirm = async () => {
    if (!ref || !token) return;
    setState("busy");
    try {
      const res: any = await apiClient.request("/privacy-requests/verify", { method: "POST", body: JSON.stringify({ reference: ref, token }) });
      const data = res?.data ?? res;
      setState(data?.completed ? "done" : "pending-review");
    } catch (e: any) {
      setMessage(e?.message || "This confirmation link is not valid or has expired.");
      setState("error");
    }
  };

  if (!ref || !token) {
    return <p role="alert" className="text-sm text-red-600">This link is incomplete. Open the full link from the e-mail we sent you, or <Link href="/data-rights" className="underline">make a new request</Link>.</p>;
  }
  if (state === "done") {
    return <p role="status" className="text-sm rounded-lg border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30 p-4 text-green-900 dark:text-green-200">Done. This e-mail address has been removed from Orion&apos;s company contacts and will not be added again. Reference {ref}.</p>;
  }
  if (state === "pending-review") {
    return <p role="status" className="text-sm rounded-lg border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30 p-4 text-green-900 dark:text-green-200">Thank you. Your address is confirmed and removed from company contacts. It also appears on a person&apos;s profile, which our team will review and remove. Reference {ref}. Questions: {GRIEVANCE.email}.</p>;
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-700 dark:text-gray-300">Confirm that you want this e-mail address removed from Orion and never added again. Reference <strong>{ref}</strong>.</p>
      {state === "error" && <p role="alert" className="text-sm text-red-600">{message}</p>}
      <button type="button" onClick={() => void confirm()} disabled={state === "busy"} className="rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 px-4 py-2 text-sm font-semibold disabled:opacity-60 cursor-pointer">
        {state === "busy" ? "Confirming…" : "Yes, remove my e-mail address"}
      </button>
    </div>
  );
}
