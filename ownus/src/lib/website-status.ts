/**
 * One place that decides what a website value from an import means, so the stored website, its validation status and the `hasWebsite` flag
 * can never disagree.
 *
 *   https://<host>   structurally valid, any domain extension  -> valid     (passes)
 *   http://<host>    structurally valid                         -> warning   (works, but not secure)
 *   no scheme        "www.example.in"                           -> warning   (the API stores it as https://)
 *   empty            nothing supplied                           -> missing   (warning, a lead opportunity)
 *   anything else    javascript:, ftp:, spaces, credentials,
 *                    a host with no dot, a numeric-only ending  -> invalid
 *
 * No list of domain extensions is used: the last label of the host only has to look like one (letters, or a punycode `xn--` label for
 * international extensions). `.in`, `.com`, `.org`, `.net`, `.co.uk`, `.tech`, `.museum` and `.xn--p1ai` are all treated the same.
 * Whether the site actually answers is NOT checked here (that would be an outbound request); the API separately refuses private and
 * internal addresses when it stores the value.
 */
import type { FieldValidationStatus } from '@/types/admin';

export interface WebsiteAssessment {
  /** The trimmed value as supplied ('' when none). */
  value: string;
  status: FieldValidationStatus;
  /** True when the value is a structurally valid https:// address. */
  secure: boolean;
  /** True whenever a website was supplied at all (valid, warning or invalid), false only when it is missing. */
  hasWebsite: boolean;
  message: string;
}

const MAX_LENGTH = 2048;
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TLD = /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Host shape only: dotted labels, a plausible last label. No extension list. */
function isPlausibleHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !host.includes('.')) return false;
  const labels = host.split('.');
  if (labels.some((l) => !l || l.length > 63 || !LABEL.test(l))) return false;
  return TLD.test(labels[labels.length - 1]);
}

function parseWith(value: string, scheme: 'https:' | 'http:'): boolean {
  try {
    const u = new URL(value);
    return u.protocol === scheme && !u.username && !u.password && isPlausibleHost(u.hostname);
  } catch {
    return false;
  }
}

export function assessWebsite(raw: unknown): WebsiteAssessment {
  const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
  if (!value) return { value: '', status: 'missing', secure: false, hasWebsite: false, message: 'Website missing (lead opportunity).' };

  const invalid = (message: string): WebsiteAssessment => ({ value, status: 'invalid', secure: false, hasWebsite: true, message });
  if (value.length > MAX_LENGTH || /\s/.test(value)) return invalid('Website is not a valid web address.');

  if (/^https:\/\//i.test(value)) {
    return parseWith(value, 'https:')
      ? { value, status: 'valid', secure: true, hasWebsite: true, message: 'Valid HTTPS URL structure.' }
      : invalid('Website is not a valid https:// address.');
  }
  if (/^http:\/\//i.test(value)) {
    return parseWith(value, 'http:')
      ? { value, status: 'warning', secure: false, hasWebsite: true, message: 'Website uses http:// (not secure). Prefer https://.' }
      : invalid('Website is not a valid http:// address.');
  }
  // any other scheme (javascript:, ftp:, data:, mailto: ...) is refused; a bare "name.tld/path" is a warning
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^/]*\.[^/]*:\d+/.test(value.split('/')[0])) return invalid('Website must start with https://.');
  return parseWith(`https://${value.replace(/^\/\//, '')}`, 'https:')
    ? { value, status: 'warning', secure: false, hasWebsite: true, message: 'Website has no https:// prefix; it will be stored as https://.' }
    : invalid('Website is not a valid web address.');
}
