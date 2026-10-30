/**
 * Logic for the admin rights-request queue (DPDP Act). Pure helpers plus three thin API calls. The server enforces every rule (see
 * RightsRequestService.decide in apps/api); `checkDecision` repeats them only so a reviewer is told before the round trip.
 * No requester address is ever put in a URL: references identify requests, the address stays in the response body.
 */
export type QueueStatus = 'REQUESTED' | 'VALIDATING' | 'NEEDS_INFO' | 'APPROVED' | 'COMPLETED' | 'REJECTED';
export type DecisionAction = 'REQUEST_INFO' | 'COMPLETE' | 'REJECT';

export interface IQueueRow {
  reference: string;
  type: string;
  status: QueueStatus | string;
  contactEmail: string | null;
  requesterNote: string | null;
  details: string | null;
  verifiedAt: string | null;
  dueAt: string;
  createdAt: string;
  completedAt: string | null;
}

export interface IMatchedPerson {
  id: string;
  fullName: string;
  dataStatus: string;
}

export interface IQueueDetail extends IQueueRow {
  evidence: string;
  publicMessage: string | null;
  decisionReason: string | null;
  resultSummary: Record<string, unknown> | null;
  found: { customerAccount: boolean; companyContacts: number; people: IMatchedPerson[] };
}

export const STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'New',
  VALIDATING: 'Being checked',
  NEEDS_INFO: 'Waiting for requester',
  APPROVED: 'Needs a reviewer',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
};

export const TYPE_LABEL: Record<string, string> = {
  ACCESS: 'Access',
  CORRECTION: 'Correction',
  ERASURE: 'Erasure',
  WITHDRAWAL: 'Withdraw consent',
  GRIEVANCE: 'Grievance',
  NOMINATION: 'Nomination',
};

const DAY = 24 * 60 * 60 * 1000;

export type DueTone = 'overdue' | 'soon' | 'ok';

/** Whole days until the deadline (negative once it has passed). */
export function daysLeft(dueAt: string | Date, now: number = Date.now()): number {
  return Math.ceil((new Date(dueAt).getTime() - now) / DAY);
}

export function dueBadge(dueAt: string | Date, now: number = Date.now()): { label: string; tone: DueTone } {
  const d = daysLeft(dueAt, now);
  if (d < 0) return { label: `${-d} day${d === -1 ? '' : 's'} overdue`, tone: 'overdue' };
  if (d === 0) return { label: 'Due today', tone: 'soon' };
  return { label: `${d} day${d === 1 ? '' : 's'} left`, tone: d <= 5 ? 'soon' : 'ok' };
}

export const isClosed = (status: string): boolean => status === 'COMPLETED' || status === 'REJECTED';

/** How many open requests are past their deadline (for the sidebar badge). */
export const overdueCount = (rows: Pick<IQueueRow, 'dueAt' | 'status'>[], now: number = Date.now()): number => rows.filter((r) => !isClosed(r.status) && daysLeft(r.dueAt, now) < 0).length;

export interface IDecisionInput {
  action: DecisionAction;
  message: string;
  reason: string;
  identityChecked: boolean;
}

/** The first thing wrong with a decision, or null. Mirrors the server so the reviewer hears it before sending. */
export function checkDecision(row: IQueueRow, detail: IQueueDetail | null, d: IDecisionInput): string | null {
  if (isClosed(row.status)) return 'This request is already closed.';
  if (!row.contactEmail) return 'The requester address is no longer held, so no answer can be sent.';
  const message = d.message.trim();
  if (d.action === 'REQUEST_INFO' && message.length < 5) return 'Say what you need from the requester.';
  if (d.action === 'REJECT' && (message.length < 5 || d.reason.trim().length < 5)) return 'A rejection needs a message for the requester and an internal reason.';
  if (d.action === 'COMPLETE') {
    if (row.type === 'ERASURE') {
      if (!row.verifiedAt) return 'The requester has not confirmed the address yet.';
      const left = (detail?.found.people ?? []).filter((p) => p.dataStatus !== 'SUPPRESSED').length;
      if (left > 0) return `${left} matching person record(s) are not suppressed yet. Suppress them in People Review first.`;
    } else if (row.type !== 'GRIEVANCE' && !d.identityChecked) {
      return 'Confirm that you checked who the requester is.';
    }
  }
  return null;
}

/** What a reviewer should know before choosing, in one line. */
export function guidance(row: IQueueRow, detail: IQueueDetail | null): string {
  if (isClosed(row.status)) return 'Closed. The requester address and free text were cleared.';
  if (row.type === 'ERASURE') {
    if (!row.verifiedAt) return 'Waiting for the requester to open the confirmation link in their e-mail. Nothing is removed until they do.';
    const left = (detail?.found.people ?? []).filter((p) => p.dataStatus !== 'SUPPRESSED').length;
    return left > 0
      ? `Address confirmed and removed from company contacts. ${left} person record(s) still show it: suppress them in People Review, then complete this request.`
      : 'Address confirmed and removed. You can complete the request.';
  }
  if (row.type === 'GRIEVANCE') return 'Answer the complaint. If the requester is not satisfied they can go to the Data Protection Board of India.';
  return 'Check who the requester is before you release or change anything, then act and complete the request.';
}

// ------------------------------------------------------------------------------------------------ API
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const unwrap = <T>(body: any): T => (body && typeof body === 'object' && 'data' in body && body.data !== undefined ? body.data : body) as T;

async function parse<T>(res: Response): Promise<T> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* an empty or non-JSON answer is handled below */
  }
  if (!res.ok) {
    const e: any = new Error(body?.message || body?.error?.message || `Request failed (${res.status})`);
    e.status = res.status;
    e.errorCode = body?.errorCode || body?.error?.errorCode || body?.details?.errorCode;
    throw e;
  }
  return unwrap<T>(body);
}

export const queueApi = (base: string, doFetch: Fetch) => ({
  list: async (closed: boolean): Promise<IQueueRow[]> => {
    const rows = await parse<IQueueRow[]>(await doFetch(`${base}/privacy/admin/rights-requests${closed ? '?closed=true' : ''}`));
    return Array.isArray(rows) ? rows : [];
  },
  detail: async (reference: string): Promise<IQueueDetail> => parse<IQueueDetail>(await doFetch(`${base}/privacy/admin/rights-requests/${encodeURIComponent(reference)}`)),
  decide: async (reference: string, d: IDecisionInput): Promise<{ reference: string; status: string }> =>
    parse(
      await doFetch(`${base}/privacy/admin/rights-requests/${encodeURIComponent(reference)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: d.action, message: d.message.trim() || undefined, reason: d.reason.trim() || undefined, identityChecked: d.identityChecked || undefined }),
      }),
    ),
});
