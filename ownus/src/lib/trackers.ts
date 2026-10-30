import type { ILocalConsent } from '@/lib/consent';

/**
 * Registry of NON-ESSENTIAL third-party scripts (analytics, marketing pixels, session replay and the like). A script listed here is loaded
 * only while the visitor's consent covers its purpose, and is not injected before a choice is made. Orion ships with none: the product
 * currently loads no analytics or advertising code. To add one, list it here; do not add a <script> tag anywhere else.
 *
 * Essential scripts are NOT listed and are not gated: Cloudflare Turnstile (bot protection on sign-in and sign-up) and Razorpay checkout
 * (only on the payment step). Both are disclosed in the Privacy Notice. See DPDP_PROGRESS.md for the legal question this raises.
 */
export type TrackerPurpose = 'analytics' | 'marketing';

export interface ITracker {
  id: string;
  purpose: TrackerPurpose;
  src: string;
  attrs?: Record<string, string>;
}

export const TRACKERS: readonly ITracker[] = [];

const covered = (consent: Pick<ILocalConsent, 'analytics' | 'marketing'>, purpose: TrackerPurpose) => (purpose === 'analytics' ? consent.analytics : consent.marketing);

/** What to do for the current consent: inject the allowed trackers not yet present, and name the loaded ones whose purpose was withdrawn. */
export function planTrackers(consent: Pick<ILocalConsent, 'analytics' | 'marketing' | 'decided'>, loaded: ReadonlySet<string>, list: readonly ITracker[] = TRACKERS) {
  const load: ITracker[] = [];
  const withdrawn: ITracker[] = [];
  for (const t of list) {
    const allowed = consent.decided && covered(consent, t.purpose);
    if (allowed && !loaded.has(t.id)) load.push(t);
    if (!allowed && loaded.has(t.id)) withdrawn.push(t);
  }
  return { load, withdrawn };
}
