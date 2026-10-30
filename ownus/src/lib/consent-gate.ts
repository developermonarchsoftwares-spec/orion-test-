/**
 * When must a signed-in person be asked for the account consent? Pure so it can be tested. The answer comes from GET /privacy/consents:
 * the account consent must currently be granted. That covers three cases with one rule:
 *  - NEW: a Google / Microsoft sign-up (the account is created in the provider redirect, where no checkbox can be shown) and any account
 *    created before consent was recorded: no ledger row yet;
 *  - WITHDRAWN: the person withdrew it (the account is scheduled for closure; agreeing again cancels that);
 *  - otherwise OK.
 * The settings page stays reachable in every case so a person who does not agree can still download or delete their data.
 */
export type GateState = 'ok' | 'new' | 'withdrawn';

export interface IConsentsResponse {
  consents?: Record<string, { granted?: boolean; updatedAt?: string | null }>;
}

export function gateStateFor(res: IConsentsResponse | null | undefined): GateState {
  const c = res?.consents?.ACCOUNT_SERVICE;
  if (c?.granted === true) return 'ok';
  return c?.updatedAt ? 'withdrawn' : 'new';
}

/** Paths that stay usable while the gate is showing. */
export const GATE_EXEMPT_PREFIXES = ['/settings'] as const;
export const gateExempt = (pathname: string | null | undefined): boolean => !!pathname && GATE_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
