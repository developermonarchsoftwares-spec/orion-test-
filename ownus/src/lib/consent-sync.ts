import { apiClient } from "@/lib/api-client";
import type { ConsentPurposeId } from "@/lib/compliance";

/**
 * Writes consent choices to the server-side ledger (PUT /privacy/consents appends one row per purpose with the policy version, time and
 * network details). Used right after sign-up, when the account and its session exist. A choice that cannot be sent is kept in this browser
 * and sent on the next page load that has a session, so a network blip does not silently lose a recorded choice.
 */
const PENDING_KEY = "orion_pending_consents";
type Choice = { purpose: ConsentPurposeId; granted: boolean };

const put = (c: Choice) => apiClient.request("/privacy/consents", { method: "PUT", body: JSON.stringify({ purpose: c.purpose, granted: c.granted }) });

const readPending = (): Choice[] => {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as Choice[]) : [];
  } catch {
    return [];
  }
};
const writePending = (list: Choice[]) => {
  try {
    if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage unavailable: nothing more can be done in the browser */
  }
};

/** Sends every choice in order; those that fail are queued. Never throws. */
export async function recordConsents(choices: Partial<Record<ConsentPurposeId, boolean>>): Promise<void> {
  const list: Choice[] = (Object.entries(choices) as [ConsentPurposeId, boolean][]).map(([purpose, granted]) => ({ purpose, granted }));
  const failed: Choice[] = [];
  for (const c of list) {
    try {
      await put(c);
    } catch {
      failed.push(c);
    }
  }
  if (failed.length) writePending([...readPending(), ...failed]);
}

/** Retries queued choices once a session exists. Safe to call on every page load. */
export async function flushPendingConsents(): Promise<void> {
  if (!apiClient.getAccessToken()) return;
  const pending = readPending();
  if (!pending.length) return;
  const still: Choice[] = [];
  for (const c of pending) {
    try {
      await put(c);
    } catch {
      still.push(c);
    }
  }
  writePending(still);
}
