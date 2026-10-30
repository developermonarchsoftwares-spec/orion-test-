'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { adminFetch } from '@/lib/admin-fetch';
import { cn } from '@/lib/utils';
import {
  STATUS_LABEL,
  TYPE_LABEL,
  checkDecision,
  dueBadge,
  guidance,
  isClosed,
  queueApi,
  type DecisionAction,
  type IDecisionInput,
  type IQueueDetail,
  type IQueueRow,
} from '@/lib/rights-queue';

/**
 * Privacy requests (DPDP Act): the queue behind the public /data-rights form. A reviewer opens a request, sees where the requester's
 * address appears in Orion (counts, and the names of matching people), then asks for information, completes or rejects it. The requester
 * is told by e-mail before anything changes. People are suppressed in People Review, not here. Every rule is enforced by the API; the
 * checks in this screen only save a round trip.
 */
const TONE = {
  overdue: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300',
  soon: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  ok: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
} as const;

const EMPTY: IDecisionInput = { action: 'COMPLETE', message: '', reason: '', identityChecked: false };
const api = queueApi(apiClient.getBaseUrl(), adminFetch);

export function RightsQueueView() {
  const [showClosed, setShowClosed] = useState(false);
  const [rows, setRows] = useState<IQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<IQueueDetail | null>(null);
  const [form, setForm] = useState<IDecisionInput>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.list(showClosed));
    } catch (e: any) {
      toast.error(e?.message || 'Could not load the requests');
    } finally {
      setLoading(false);
    }
  }, [showClosed]);
  useEffect(() => { void load(); }, [load]);

  const open = useCallback(async (reference: string) => {
    setSelected(reference);
    setDetail(null);
    setForm(EMPTY);
    setProblem(null);
    try {
      setDetail(await api.detail(reference));
    } catch (e: any) {
      setProblem(e?.message || 'Could not load this request');
    }
  }, []);

  const row = useMemo(() => rows.find((r) => r.reference === selected) ?? null, [rows, selected]);
  const view: IQueueRow | null = detail ?? row;

  const submit = async () => {
    if (!view) return;
    const early = checkDecision(view, detail, form);
    if (early) {
      setProblem(early);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.decide(view.reference, form);
      toast.success(form.action === 'REQUEST_INFO' ? 'Question sent to the requester' : form.action === 'COMPLETE' ? 'Request completed' : 'Request rejected');
      await load();
      if (form.action === 'REQUEST_INFO') await open(view.reference);
      else { setSelected(null); setDetail(null); }
    } catch (e: any) {
      setProblem(e?.message || 'Could not save the decision');
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof IDecisionInput>(k: K, v: IDecisionInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const closed = view ? isClosed(view.status) : false;
  const field = 'w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm';

  return (
    <div className="p-6 space-y-5" data-testid="rights-queue">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2"><ShieldCheck className="w-5 h-5" /> Privacy requests</h2>
          <p className="text-xs text-zinc-500">Requests from the public data-rights form (DPDP Act). Soonest deadline first.</p>
        </div>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Request list" className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden text-xs">
            {([false, true] as const).map((c) => (
              <button
                key={String(c)}
                role="tab"
                aria-selected={showClosed === c}
                onClick={() => { setShowClosed(c); setSelected(null); setDetail(null); }}
                className={cn('px-3 py-1.5 cursor-pointer', showClosed === c ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300')}
              >
                {c ? 'Closed' : 'Open'}
              </button>
            ))}
          </div>
          <button onClick={() => void load()} className="p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 cursor-pointer" aria-label="Refresh"><RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} /></button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
        <div className="xl:col-span-3 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-xs">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-left text-zinc-500">
              <tr><th className="p-3">Reference</th><th className="p-3">Request</th><th className="p-3">Status</th><th className="p-3">Deadline</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const due = showClosed ? null : dueBadge(r.dueAt);
                return (
                  <tr
                    key={r.reference}
                    tabIndex={0}
                    onClick={() => void open(r.reference)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void open(r.reference); }}
                    aria-selected={selected === r.reference}
                    className={cn('border-t border-zinc-200 dark:border-zinc-800 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900', selected === r.reference && 'bg-zinc-100 dark:bg-zinc-900')}
                  >
                    <td className="p-3 font-mono">{r.reference}</td>
                    <td className="p-3">{TYPE_LABEL[r.type] ?? r.type}</td>
                    <td className="p-3">{STATUS_LABEL[r.status] ?? r.status}</td>
                    <td className="p-3">{due ? <span className={cn('px-2 py-0.5 rounded-full', TONE[due.tone])}>{due.label}</span> : r.completedAt ? new Date(r.completedAt).toLocaleDateString() : ''}</td>
                  </tr>
                );
              })}
              {!rows.length && !loading && <tr><td colSpan={4} className="p-6 text-center text-zinc-500">{showClosed ? 'No finished requests yet.' : 'No open requests.'}</td></tr>}
              {loading && !rows.length && <tr><td colSpan={4} className="p-6 text-center text-zinc-500"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading…</td></tr>}
            </tbody>
          </table>
        </div>

        <aside className="xl:col-span-2 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-4 text-sm" aria-live="polite">
          {!view && <p className="text-zinc-500 text-xs">Choose a request to see it.</p>}
          {view && (
            <>
              <div>
                <p className="font-mono text-xs text-zinc-500">{view.reference}</p>
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{TYPE_LABEL[view.type] ?? view.type} request</h3>
                <p className="text-xs text-zinc-500">{STATUS_LABEL[view.status] ?? view.status}{view.verifiedAt ? ' · address confirmed by the requester' : ''}</p>
              </div>
              <dl className="text-xs space-y-1">
                <div><dt className="inline text-zinc-500">Requester: </dt><dd className="inline">{view.requesterNote ?? 'cleared'}</dd></div>
                <div><dt className="inline text-zinc-500">Address: </dt><dd className="inline">{view.contactEmail ?? 'cleared'}</dd></div>
                {view.details && <div><dt className="text-zinc-500">What they wrote</dt><dd className="mt-0.5 whitespace-pre-wrap rounded bg-zinc-50 dark:bg-zinc-900 p-2">{view.details}</dd></div>}
              </dl>
              {detail && (
                <section className="text-xs rounded-lg bg-zinc-50 dark:bg-zinc-900 p-3 space-y-1" aria-label="Where this address appears">
                  <p className="font-semibold text-zinc-800 dark:text-zinc-200">Where this address appears</p>
                  <p>Customer account: <strong>{detail.found.customerAccount ? 'yes' : 'no'}</strong>{detail.found.customerAccount ? ' (an account is deleted by the customer in Settings, not here)' : ''}</p>
                  <p>Company contacts: <strong>{detail.found.companyContacts}</strong></p>
                  <p>People: <strong>{detail.found.people.length}</strong></p>
                  {detail.found.people.length > 0 && (
                    <ul className="list-disc pl-5">
                      {detail.found.people.map((p) => <li key={p.id}>{p.fullName} <span className="text-zinc-500">({p.dataStatus === 'SUPPRESSED' ? 'suppressed' : 'still visible'})</span></li>)}
                    </ul>
                  )}
                  {detail.found.people.some((p) => p.dataStatus !== 'SUPPRESSED') && <p className="text-amber-700 dark:text-amber-300">Suppress these people in People Review before completing an erasure.</p>}
                </section>
              )}
              <p className="text-xs text-zinc-600 dark:text-zinc-400">{guidance(view, detail)}</p>

              {!closed && (
                <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3" aria-label="Decision">
                  <div>
                    <label htmlFor="rq-action" className="block text-xs font-medium mb-1">Decision</label>
                    <select id="rq-action" className={field} value={form.action} onChange={(e) => set('action', e.target.value as DecisionAction)}>
                      <option value="COMPLETE">Complete the request</option>
                      <option value="REQUEST_INFO">Ask the requester for information</option>
                      <option value="REJECT">Reject the request</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="rq-message" className="block text-xs font-medium mb-1">Message to the requester {form.action === 'COMPLETE' ? '(optional)' : '*'}</label>
                    <textarea id="rq-message" rows={3} maxLength={300} className={field} value={form.message} onChange={(e) => set('message', e.target.value)} />
                    <p className="text-[11px] text-zinc-500 mt-0.5">Sent by e-mail before anything changes. {form.message.length}/300</p>
                  </div>
                  {form.action === 'REJECT' && (
                    <div>
                      <label htmlFor="rq-reason" className="block text-xs font-medium mb-1">Internal reason *</label>
                      <textarea id="rq-reason" rows={2} maxLength={500} className={field} value={form.reason} onChange={(e) => set('reason', e.target.value)} />
                      <p className="text-[11px] text-zinc-500 mt-0.5">Never sent to the requester.</p>
                    </div>
                  )}
                  {form.action === 'COMPLETE' && view.type !== 'ERASURE' && view.type !== 'GRIEVANCE' && (
                    <label className="flex items-start gap-2 text-xs">
                      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.identityChecked} onChange={(e) => set('identityChecked', e.target.checked)} />
                      <span>I checked who the requester is before releasing or changing any data.</span>
                    </label>
                  )}
                  {problem && <p role="alert" className="text-xs text-red-600 flex items-start gap-1"><XCircle className="w-4 h-4 shrink-0" />{problem}</p>}
                  <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg text-xs font-semibold bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 disabled:opacity-50 cursor-pointer flex items-center gap-2">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Send decision
                  </button>
                </form>
              )}
              {closed && problem && <p role="alert" className="text-xs text-red-600">{problem}</p>}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
