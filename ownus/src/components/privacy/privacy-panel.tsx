"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Download, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { setLocalConsent } from "@/lib/consent";

type Purpose = "ACCOUNT_SERVICE" | "ANALYTICS" | "MARKETING" | "PRODUCT_UPDATES" | "SALE_SHARING";
interface IConsent { granted: boolean; updatedAt: string | null }
interface IRequest { id: string; type: "EXPORT" | "DELETE"; status: string; requestedAt: string; executeAfter: string | null; dueAt: string }

const PURPOSES: { id: Purpose; title: string; text: string }[] = [
  { id: "ACCOUNT_SERVICE", title: "Create and run my account", text: "Required to keep your account. If you withdraw it, your account is scheduled for deletion after 7 days; agree again before then to keep it." },
  { id: "ANALYTICS", title: "Product analytics", text: "Anonymous usage statistics that help us improve Orion." },
  { id: "MARKETING", title: "Marketing e-mails", text: "Offers, case studies and news about Orion." },
  { id: "PRODUCT_UPDATES", title: "Product updates", text: "Feature announcements and service notices that are not required to run your account." },
  { id: "SALE_SHARING", title: "Sale or sharing of personal information", text: "Orion does not sell your personal information. If this is ever offered, it stays off unless you turn it on (California residents: this is your \"Do Not Sell or Share\" choice)." },
];

export function PrivacyPanel() {
  const { user } = useAuth();
  const [consents, setConsents] = useState<Record<string, IConsent>>({});
  const [requests, setRequests] = useState<IRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showDelete, setShowDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([apiClient.request("/privacy/consents"), apiClient.request("/privacy/requests")]);
      setConsents(c?.consents ?? {});
      setRequests(Array.isArray(r) ? r : []);
    } catch (e: any) {
      toast.error(e?.message || "Could not load privacy settings");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (purpose: Purpose, granted: boolean) => {
    if (purpose === "ACCOUNT_SERVICE" && !granted && !window.confirm("Withdrawing this consent will schedule your account for deletion in 7 days. You can agree again before then to keep it. Continue?")) return;
    setBusy(purpose);
    try {
      const c = await apiClient.request("/privacy/consents", { method: "PUT", body: JSON.stringify({ purpose, granted }) });
      setConsents(c?.consents ?? {});
      if (purpose === "ANALYTICS") setLocalConsent({ analytics: granted });
      if (purpose === "ACCOUNT_SERVICE") void load(); // a closure may have been scheduled or cancelled: show the request
      toast.success(granted ? "Preference saved" : purpose === "ACCOUNT_SERVICE" ? "Consent withdrawn. Your account is scheduled for deletion." : "Consent withdrawn");
    } catch (e: any) {
      toast.error(e?.message || "Could not save");
    } finally { setBusy(null); }
  };

  const download = async () => {
    setBusy("export");
    try {
      const data = await apiClient.request("/privacy/export", { method: "POST" });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `orion-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("Your data export has been downloaded");
      void load();
    } catch (e: any) {
      toast.error(e?.message || "Export failed");
    } finally { setBusy(null); }
  };

  const requestDelete = async () => {
    setBusy("delete");
    try {
      await apiClient.request("/privacy/delete", { method: "POST", body: JSON.stringify({ confirmEmail, password: password || undefined }) });
      toast.success("Deletion scheduled. You can cancel it for the next 7 days.");
      setShowDelete(false); setPassword(""); setConfirmEmail("");
      void load();
    } catch (e: any) {
      toast.error(e?.message || "Could not schedule deletion");
    } finally { setBusy(null); }
  };

  const cancelDelete = async () => {
    setBusy("cancel");
    try {
      await apiClient.request("/privacy/delete", { method: "DELETE" });
      toast.success("Account deletion cancelled");
      void load();
    } catch (e: any) {
      toast.error(e?.message || "Could not cancel");
    } finally { setBusy(null); }
  };

  const pending = requests.find((r) => r.type === "DELETE" && r.status === "PENDING");
  const btn = "px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2 cursor-pointer disabled:opacity-50";

  return (
    <div className="p-6 md:p-8 space-y-8 text-xs">
      <div>
        <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100 mb-1">Privacy & Data</h2>
        <p className="text-zinc-500">
          Control how your data is used, download a copy, or delete your account. See our{" "}
          <Link href="/privacy" className="underline">Privacy Policy</Link> and <Link href="/terms" className="underline">Terms of Service</Link>.
        </p>
      </div>

      <section className="space-y-3 max-w-2xl">
        <h3 className="font-semibold text-zinc-800 dark:text-zinc-200">Consent</h3>
        {PURPOSES.map((p) => (
          <label key={p.id} className="flex items-start justify-between gap-4 p-3 border border-zinc-200 dark:border-zinc-800 rounded-lg">
            <span>
              <span className="block font-semibold text-zinc-900 dark:text-zinc-100">{p.title}</span>
              <span className="block text-zinc-500 mt-0.5">{p.text}</span>
              {consents[p.id]?.updatedAt && <span className="block text-[11px] text-zinc-400 mt-1">Last changed {new Date(consents[p.id].updatedAt!).toLocaleDateString()}</span>}
            </span>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 cursor-pointer"
              checked={!!consents[p.id]?.granted}
              disabled={busy === p.id}
              onChange={(e) => void toggle(p.id, e.target.checked)}
              aria-label={p.title}
            />
          </label>
        ))}
      </section>

      <section className="space-y-3 max-w-2xl">
        <h3 className="font-semibold text-zinc-800 dark:text-zinc-200">Download your data</h3>
        <p className="text-zinc-500">A machine-readable JSON file with your profile, saved searches and leads, credits, billing records, integrations, consents and activity. Passwords and secret keys are never included.</p>
        <button onClick={download} disabled={busy === "export"} className={`${btn} bg-zinc-900 text-white dark:bg-white dark:text-zinc-900`}>
          {busy === "export" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download my data
        </button>
      </section>

      <section className="space-y-3 max-w-2xl border-t border-zinc-200 dark:border-zinc-800 pt-6">
        <h3 className="font-semibold text-red-600">Delete account</h3>
        <p className="text-zinc-500">
          Your profile, saved searches and leads, API keys and integrations are permanently erased 7 days after you confirm. Billing and invoice records are kept without your identity because tax law requires it. This cannot be undone once the 7 days have passed.
        </p>
        {pending ? (
          <div className="p-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 space-y-2">
            <p className="text-red-700 dark:text-red-300">Deletion scheduled for <strong>{pending.executeAfter ? new Date(pending.executeAfter).toLocaleString() : "soon"}</strong>.</p>
            <button onClick={cancelDelete} disabled={busy === "cancel"} className={`${btn} border border-zinc-300 dark:border-zinc-700`}>Cancel deletion</button>
          </div>
        ) : showDelete ? (
          <div className="space-y-2">
            <input value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} placeholder={`Type ${user?.email ?? "your e-mail"} to confirm`} className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 rounded-lg" />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (if your account has one)" className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 rounded-lg" />
            <div className="flex gap-2">
              <button onClick={requestDelete} disabled={busy === "delete" || !confirmEmail} className={`${btn} bg-red-600 text-white`}>
                {busy === "delete" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Schedule deletion
              </button>
              <button onClick={() => setShowDelete(false)} className={`${btn} border border-zinc-300 dark:border-zinc-700`}>Keep my account</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowDelete(true)} className={`${btn} border border-red-300 text-red-600`}><Trash2 className="w-3.5 h-3.5" /> Delete my account</button>
        )}
      </section>

      {requests.length > 0 && (
        <section className="space-y-2 max-w-2xl">
          <h3 className="font-semibold text-zinc-800 dark:text-zinc-200">Your requests</h3>
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-lg">
            {requests.map((r) => (
              <li key={r.id} className="flex justify-between px-3 py-2">
                <span>{r.type === "EXPORT" ? "Data export" : "Account deletion"}</span>
                <span className="text-zinc-500">{r.status} · {new Date(r.requestedAt).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
