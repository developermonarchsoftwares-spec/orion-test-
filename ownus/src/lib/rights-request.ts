/** Client-side checks for the data-rights form. The API validates again; these only save the person a round trip. Mirrors CreateRightsRequestDto. */
export const RIGHTS_TYPES = ['ACCESS', 'CORRECTION', 'ERASURE', 'WITHDRAWAL', 'GRIEVANCE', 'NOMINATION'] as const;
export type RightsType = (typeof RIGHTS_TYPES)[number];
export type Relationship = 'CUSTOMER' | 'OTHER';

export interface IRightsForm {
  type: RightsType | '';
  name: string;
  email: string;
  relationship: Relationship | '';
  details: string;
  processingConsent: boolean;
}

export const EMPTY_RIGHTS_FORM: IRightsForm = { type: '', name: '', email: '', relationship: '', details: '', processingConsent: false };

/** Types that need a written description (the API refuses them empty). */
const NEEDS_DETAILS: ReadonlySet<string> = new Set(['CORRECTION', 'GRIEVANCE', 'NOMINATION']);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRightsForm(f: IRightsForm): Partial<Record<keyof IRightsForm, string>> {
  const e: Partial<Record<keyof IRightsForm, string>> = {};
  if (!f.type) e.type = 'Choose what you want to do.';
  if (f.name.trim().length < 2) e.name = 'Enter your name.';
  if (!EMAIL.test(f.email.trim()) || f.email.length > 255) e.email = 'Enter a valid e-mail address.';
  if (!f.relationship) e.relationship = 'Tell us how you are connected to Orion.';
  if (f.details.length > 500) e.details = 'Use 500 characters or fewer.';
  else if (f.type && NEEDS_DETAILS.has(f.type) && f.details.trim().length < 10) e.details = 'Describe your request in a few words (at least 10 characters).';
  if (!f.processingConsent) e.processingConsent = 'We need your agreement to use these details to handle your request.';
  return e;
}
