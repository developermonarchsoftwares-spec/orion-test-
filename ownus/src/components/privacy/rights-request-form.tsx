"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { GRIEVANCE, RIGHTS_TYPE_LABEL } from "@/lib/compliance";
import { EMPTY_RIGHTS_FORM, RIGHTS_TYPES, validateRightsForm, type IRightsForm } from "@/lib/rights-request";
import { Turnstile, captchaEnabled, type TurnstileHandle } from "@/components/auth/turnstile";

const field = "w-full rounded-lg border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm";
const err = "mt-1 text-xs text-red-600";

/** Public form for DPDP Act requests (also reachable by people who are not Orion customers). Nothing is pre-ticked. */
export function RightsRequestForm() {
  const [form, setForm] = useState<IRightsForm>(EMPTY_RIGHTS_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof IRightsForm, string>>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ reference: string | null; dueAt: string | null } | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<TurnstileHandle>(null);

  const set = <K extends keyof IRightsForm>(k: K, v: IRightsForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found = validateRightsForm(form);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length) return;
    if (captchaEnabled && !captchaToken) {
      setFailure("Please complete the security check before continuing.");
      return;
    }
    setBusy(true);
    try {
      const res: any = await apiClient.request("/privacy-requests", {
        method: "POST",
        body: JSON.stringify({ ...form, name: form.name.trim(), email: form.email.trim(), details: form.details.trim() || undefined, ...(captchaToken ? { captchaToken } : {}) }),
      });
      const data = res?.data ?? res;
      setReceipt({ reference: data?.reference ?? null, dueAt: data?.dueAt ?? null });
    } catch (e2: any) {
      setFailure(e2?.message || `We could not send your request. Please try again, or write to ${GRIEVANCE.email}.`);
    } finally {
      setBusy(false);
      captchaRef.current?.reset();
    }
  };

  if (receipt) {
    return (
      <div role="status" className="rounded-xl border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30 p-5 text-sm text-green-900 dark:text-green-200">
        <p className="font-semibold mb-1">Your request was received.</p>
        {receipt.reference ? (
          <p>Reference: <strong>{receipt.reference}</strong>. We will respond by {receipt.dueAt ? new Date(receipt.dueAt).toLocaleDateString() : `${GRIEVANCE.respondWithinDays} days from today`}. A confirmation was sent to your e-mail address.</p>
        ) : (
          <p>You already have an open request of this kind. We are working on it and will write to you at that address.</p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <label htmlFor="rr-type" className="block text-sm font-medium mb-1">What do you want to do? *</label>
        <select id="rr-type" className={field} value={form.type} onChange={(e) => set("type", e.target.value as IRightsForm["type"])}>
          <option value="">Choose…</option>
          {RIGHTS_TYPES.map((t) => <option key={t} value={t}>{RIGHTS_TYPE_LABEL[t]}</option>)}
        </select>
        {errors.type && <p className={err}>{errors.type}</p>}
      </div>
      <div>
        <label htmlFor="rr-name" className="block text-sm font-medium mb-1">Your name *</label>
        <input id="rr-name" className={field} value={form.name} maxLength={120} autoComplete="name" onChange={(e) => set("name", e.target.value)} />
        {errors.name && <p className={err}>{errors.name}</p>}
      </div>
      <div>
        <label htmlFor="rr-email" className="block text-sm font-medium mb-1">Your e-mail address *</label>
        <input id="rr-email" type="email" className={field} value={form.email} maxLength={255} autoComplete="email" onChange={(e) => set("email", e.target.value)} />
        <p className="mt-1 text-xs text-gray-500">Use the address the request is about. We reply here, and may ask you to confirm it.</p>
        {errors.email && <p className={err}>{errors.email}</p>}
      </div>
      <fieldset>
        <legend className="block text-sm font-medium mb-1">How are you connected to Orion? *</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="rr-rel" checked={form.relationship === "CUSTOMER"} onChange={() => set("relationship", "CUSTOMER")} /> I have an Orion account</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="rr-rel" checked={form.relationship === "OTHER"} onChange={() => set("relationship", "OTHER")} /> My details may appear in Orion, but I am not a customer</label>
        {errors.relationship && <p className={err}>{errors.relationship}</p>}
      </fieldset>
      <div>
        <label htmlFor="rr-details" className="block text-sm font-medium mb-1">Details</label>
        <textarea id="rr-details" rows={4} maxLength={500} className={field} value={form.details} onChange={(e) => set("details", e.target.value)} />
        <p className="mt-1 text-xs text-gray-500">Required for corrections, grievances and nominations. Please do not include passwords or payment details. {form.details.length}/500</p>
        {errors.details && <p className={err}>{errors.details}</p>}
      </div>
      <div className="flex items-start gap-2">
        <input id="rr-consent" type="checkbox" className="mt-1 h-4 w-4" checked={form.processingConsent} onChange={(e) => set("processingConsent", e.target.checked)} />
        <label htmlFor="rr-consent" className="text-xs text-gray-600 dark:text-gray-400">
          I agree that Orion uses the details above only to verify and handle this request and to reply to me. See the <Link href="/privacy-notice" className="underline" target="_blank">Privacy Notice</Link>. *
        </label>
      </div>
      {errors.processingConsent && <p className={err}>{errors.processingConsent}</p>}
      <Turnstile ref={captchaRef} onToken={setCaptchaToken} onUnavailable={() => setFailure("The security check could not load. Disable content blockers for this site and reload, or write to us directly.")} className="flex" />
      {failure && <p role="alert" className="text-sm text-red-600">{failure}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 px-4 py-2 text-sm font-semibold disabled:opacity-60">
        {busy ? "Sending…" : "Send request"}
      </button>
    </form>
  );
}
