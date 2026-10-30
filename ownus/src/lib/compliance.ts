/**
 * Single source for the DPDP Act (India) copy and contact details shown on the Privacy Notice, the footer, the consent checkboxes and the
 * data-rights form. Everything marked LEGAL REVIEW is a working draft written from what the code does; counsel must confirm it before launch.
 * Flip LEGAL_REVIEW_PENDING to false only after sign-off: it controls the visible "draft" banner on the notice.
 */
export const LEGAL_REVIEW_PENDING = true;

const clean = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);

export const FIDUCIARY = {
  name: 'Monarch Softwares',
  product: 'Orion',
  // LEGAL REVIEW: registered entity name and address of the Data Fiduciary
  address: clean(process.env.NEXT_PUBLIC_FIDUCIARY_ADDRESS, '[Registered address: to be supplied]'),
} as const;

/** Grievance Officer / person who answers Data Principals. Set the grievance and fiduciary variables listed below at deploy time; the defaults are placeholders. */
export const GRIEVANCE = {
  officerName: clean(process.env.NEXT_PUBLIC_GRIEVANCE_OFFICER_NAME, '[Grievance Officer: to be appointed]'),
  email: clean(process.env.NEXT_PUBLIC_GRIEVANCE_EMAIL, 'privacy@monarchsoftwares.com'),
  address: clean(process.env.NEXT_PUBLIC_GRIEVANCE_ADDRESS, FIDUCIARY.address),
  acknowledgeWithinDays: 3,
  // LEGAL REVIEW: the DPDP Rules fix the redressal period; 30 days is used for access/correction/erasure requests, 90 days is the outer limit assumed for grievances
  respondWithinDays: 30,
} as const;

export type ConsentPurposeId = 'ACCOUNT_SERVICE' | 'PRODUCT_UPDATES' | 'MARKETING' | 'ANALYTICS';

export interface IPurpose {
  id: ConsentPurposeId;
  /** Required purposes are needed to provide the service; they are still an explicit, unticked, separate choice. */
  required: boolean;
  title: string;
  /** What is processed and why, in plain words. LEGAL REVIEW. */
  text: string;
}

export const PURPOSES: readonly IPurpose[] = [
  {
    id: 'ACCOUNT_SERVICE',
    required: true,
    title: 'Create and run my account',
    text: 'I consent to Orion processing my name, e-mail address, organisation, password (stored only as a hash), sign-in records and, if I add it, my phone number, to create my account, keep it secure, provide the service and handle credits and billing.',
  },
  {
    id: 'PRODUCT_UPDATES',
    required: false,
    title: 'Product updates (optional)',
    text: 'Send me e-mails about new features and changes to Orion that are not required to run my account.',
  },
  {
    id: 'MARKETING',
    required: false,
    title: 'Marketing e-mails (optional)',
    text: 'Send me offers, case studies and news about Orion and related Monarch Softwares products.',
  },
  {
    id: 'ANALYTICS',
    required: false,
    title: 'Usage analytics (optional)',
    text: 'Allow anonymous usage statistics to improve Orion.',
  },
] as const;

export interface IThirdParty {
  name: string;
  role: string;
  data: string;
  where: string;
}

/** Services that receive personal data, read from the code (see DPDP_PROGRESS.md section 1). LEGAL REVIEW: processor agreements and transfer locations. */
export const THIRD_PARTIES: readonly IThirdParty[] = [
  { name: 'Razorpay', role: 'Payment processing', data: 'Order and payment details, your e-mail and name on the receipt. Card or UPI details are entered with Razorpay and never reach Orion.', where: 'India' },
  { name: 'Cloudflare (Turnstile)', role: 'Bot protection on sign-in and sign-up', data: 'A browser challenge result and your IP address.', where: 'Global network [LEGAL REVIEW]' },
  { name: 'Resend', role: 'E-mail delivery', data: 'Your e-mail address and the content of messages we send you (verification codes, receipts, notices).', where: '[LEGAL REVIEW: confirm region]' },
  { name: 'Google / Microsoft', role: 'Optional single sign-on', data: 'Your name, e-mail address and profile picture, only if you choose to sign in with them.', where: 'Global [LEGAL REVIEW]' },
  { name: 'Cloudflare R2 (object storage)', role: 'File storage for uploads and exports', data: 'Files you upload or export, such as spreadsheets and profile pictures.', where: '[LEGAL REVIEW: confirm bucket region]' },
  { name: 'Error tracking (Sentry-compatible, only if configured)', role: 'Finding and fixing faults', data: 'Technical error reports from our servers. Personal values are scrubbed before sending.', where: '[LEGAL REVIEW: provider and region, if switched on]' },
  { name: 'Vercel and our database host', role: 'Hosting of the website, the API and the database', data: 'All account and usage data described in this notice.', where: '[LEGAL REVIEW: production database host and region not yet fixed]' },
] as const;

export interface IRetention {
  data: string;
  period: string;
}

/** Mirrors apps/api/src/modules/privacy/privacy.config.ts (RETENTION) and docs/DATA_RETENTION_POLICY.md. LEGAL REVIEW for every period. */
export const RETENTION_TABLE: readonly IRetention[] = [
  { data: 'Account details', period: 'Until you delete your account. Deletion runs after a 7-day cooling-off period you can cancel.' },
  { data: 'IP address and device details in security logs', period: '180 days, then removed.' },
  { data: 'Consent records (what you agreed to and when)', period: 'Kept for 3 years as proof, with the IP address removed after 3 years.' },
  { data: 'Invoices and payment records', period: 'As long as the law requires us to keep accounting records [LEGAL REVIEW: period to be confirmed].' },
  { data: 'Completed privacy requests', period: '3 years.' },
  { data: 'Uploaded files and import data', period: '[LEGAL REVIEW: retention period not yet decided]' },
] as const;

export const RIGHTS = [
  { id: 'ACCESS', title: 'Access', text: 'Get a summary of the personal data we hold about you and who we share it with. Signed-in customers can also download it in Settings → Privacy.' },
  { id: 'CORRECTION', title: 'Correction and updating', text: 'Ask us to correct inaccurate or incomplete data, or to complete or update it.' },
  { id: 'ERASURE', title: 'Erasure', text: 'Ask us to erase your personal data when it is no longer needed for the purpose it was collected for, unless the law requires us to keep it.' },
  { id: 'WITHDRAWAL', title: 'Withdraw consent', text: 'Withdraw any consent you gave, as easily as you gave it, in Settings → Privacy or the “Privacy choices” link in the footer. Withdrawal does not affect what we did before.' },
  { id: 'GRIEVANCE', title: 'Grievance redressal', text: 'Complain to our Grievance Officer. If you are not satisfied you may approach the Data Protection Board of India.' },
  { id: 'NOMINATION', title: 'Nominate someone', text: 'Name another person to exercise your rights if you die or become unable to.' },
] as const;

export const RIGHTS_TYPE_LABEL: Record<string, string> = {
  ACCESS: 'Access my data',
  CORRECTION: 'Correct my data',
  ERASURE: 'Erase my data',
  WITHDRAWAL: 'Withdraw my consent',
  GRIEVANCE: 'Make a complaint (grievance)',
  NOMINATION: 'Nominate a person to act for me',
};
