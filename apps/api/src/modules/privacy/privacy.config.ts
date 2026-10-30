/** Bump POLICY_VERSION whenever the privacy policy or terms change materially; every consent record stores the version it was given under. */
export const POLICY_VERSION = '2026-10-07';

// ACCOUNT_SERVICE is the DPDP Act consent to process account data to provide the service, given at sign-up (DPDP review: see DPDP_PROGRESS.md).
export const CONSENT_PURPOSES = ['ACCOUNT_SERVICE', 'ANALYTICS', 'MARKETING', 'PRODUCT_UPDATES', 'SALE_SHARING'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * A new account must carry the person's explicit ACCOUNT_SERVICE consent. Always on in production; elsewhere it can be switched off
 * (REQUIRE_SIGNUP_CONSENT=false) so local development and the suites that register accounts directly keep working. Same shape as
 * registrationOtpRequired.
 */
export function signupConsentRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.NODE_ENV || '').trim() === 'production') return true;
  return !/^(0|false|no|off)$/i.test((env.REQUIRE_SIGNUP_CONSENT || '').trim());
}

/** The purposes a sign-up form can send. ACCOUNT_SERVICE is required; the others are optional and recorded as given (a refusal is recorded too). */
export const SIGNUP_CONSENT_PURPOSES = ['ACCOUNT_SERVICE', 'PRODUCT_UPDATES', 'MARKETING'] as const;

export type SignupConsentPurpose = (typeof SIGNUP_CONSENT_PURPOSES)[number];

/**
 * Reads the consent choices sent with a sign-up. Only a real boolean true counts as consent to the account purpose (a string such as "true"
 * does not). Optional purposes are kept when they are real booleans, so an explicit refusal is recorded too.
 */
export function parseSignupConsents(raw: unknown): { accountService: boolean; rows: Array<{ purpose: SignupConsentPurpose; granted: boolean }> } {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const accountService = o.ACCOUNT_SERVICE === true;
  const rows: Array<{ purpose: SignupConsentPurpose; granted: boolean }> = [];
  if (accountService) rows.push({ purpose: 'ACCOUNT_SERVICE', granted: true });
  for (const purpose of ['PRODUCT_UPDATES', 'MARKETING'] as const) if (typeof o[purpose] === 'boolean') rows.push({ purpose, granted: o[purpose] as boolean });
  return { accountService, rows };
}

/** Where a requester is told to write. Same published address as the web app's grievance contact; override with PRIVACY_CONTACT_EMAIL. */
export const privacyContactEmail = (env: NodeJS.ProcessEnv = process.env): string => (env.PRIVACY_CONTACT_EMAIL || '').trim() || 'privacy@monarchsoftwares.com';

/** DPDP Act (India) Data Principal requests taken by the public form. Stored in data_subject_requests, whose `type` is varchar(12). */
export const RIGHTS_REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'ERASURE', 'WITHDRAWAL', 'GRIEVANCE', 'NOMINATION'] as const;
export type RightsRequestType = (typeof RIGHTS_REQUEST_TYPES)[number];

const DAY = 24 * 60 * 60 * 1000;

/** Cooling-off period before an account erasure runs, during which the user can cancel it. */
export const DELETION_GRACE_MS = 7 * DAY;
/** Statutory response deadline for a data-subject request (GDPR Art. 12(3) one month; CCPA 45 days). */
export const REQUEST_DEADLINE_MS = 30 * DAY;

/** How long each kind of operational data is kept. Mirrors the retention table in the privacy policy and docs/DATA_RETENTION_POLICY.md. */
export const RETENTION = {
  auditLogIpDays: 180, // IP address and user agent are blanked from audit logs after this
  consentIpDays: 365 * 3,
  queueJobDays: 30,
  integrationDeliveryDays: 30,
  adminOtpHours: 24,
  completedPrivacyRequestDays: 365 * 3,
} as const;

/**
 * Limits for one retention run. Every rule works in batches of `batchSize` rows and stops after `maxBatches` batches, so a large backlog is
 * cleared over several runs instead of holding one long lock. The next hourly run continues where this one stopped.
 */
export const RETENTION_RUN = { batchSize: 1000, maxBatches: 20 } as const;

/**
 * Retention periods that are POLICY DECISIONS, not defaults. A rule is switched on only when its environment variable holds a whole number of
 * days (1 to 3650). Unset means "not enforced": nothing is deleted until the business owner or counsel has approved a period
 * (see docs/DATA_RETENTION_POLICY.md, section "Decisions pending approval").
 */
export function optionalRetentionDays(name: 'RETENTION_IMPORT_RAW_PAYLOAD_DAYS', env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env[name] ?? '').trim();
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 3650 ? n : null;
}
