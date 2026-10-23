/**
 * Normalisation and validation of the values the scraper extracts: websites, phone numbers, e-mail addresses, business names, addresses.
 * Pure functions, no network. Port of business_scraper/normalize.py.
 */
import { domainToASCII } from 'node:url';

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'nic', 'res', 'ltd', 'plc', 'or', 'ne', 'go']);
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
export const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'rediffmail.com', 'aol.com', 'icloud.com', 'proton.me', 'protonmail.com', 'zoho.com', 'msn.com',
]);
const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'domain.com', 'yourdomain.com', 'email.com', 'test.com', 'sentry.io', 'wixpress.com',
  'w3.org', 'schema.org', 'sentry-next.wixpress.com', 'godaddy.com', 'yoursite.com', 'company.com', 'mysite.com', 'website.com',
  'abc.com', 'xyz.com',
]);
const PLACEHOLDER_LOCALS = new Set(['name', 'your', 'yourname', 'youremail', 'email', 'user', 'username', 'test', 'example', 'someone', 'xxx']);
const ASSET_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.css', '.js', '.woff', '.woff2', '.pdf'];
export const SOCIAL_HOSTS = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'youtu.be', 'wa.me', 'whatsapp.com',
  'pinterest.com', 'google.com', 'goo.gl', 'maps.app.goo.gl', 't.me', 'tiktok.com',
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', ndash: '–', mdash: '—', hellip: '…',
  middot: '·', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', bull: '•', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

/** Decodes HTML entities (named subset + numeric), like Python's html.unescape for the cases web pages actually contain. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function registrableDomain(host: string): string {
  let h = (host || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (h.startsWith('www.')) h = h.slice(4);
  const parts = h.split('.');
  if (parts.length >= 3 && SECOND_LEVEL.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.length >= 2 ? parts.slice(-2).join('.') : h;
}

/**
 * [canonicalUrl, host] for a valid public web address on any TLD, else null. Lower-cases the host, adds https when the scheme is
 * missing, drops credentials, fragments, default ports, tracking parameters and the trailing slash. Rejects IP literals, localhost
 * and single-label hosts.
 */
export function normalizeUrl(url: string | null | undefined, keepPath = true): [string, string] | null {
  if (url == null || !String(url).trim()) return null;
  let raw = String(url).trim();
  if (/^(mailto|tel|javascript|data|file|ftp):/i.test(raw)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw.replace(/^\/+/, '');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  if ((scheme !== 'http' && scheme !== 'https') || u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
  const hostAscii = host ? domainToASCII(host) : '';
  if (!hostAscii || !HOST_RE.test(hostAscii)) return null;
  const portS = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
  const query = [...u.searchParams.entries()]
    .filter(([k]) => !/^(utm_|fbclid|gclid|mc_|_ga)/i.test(k) && k.toLowerCase() !== 'ref')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  let path = keepPath ? (u.pathname || '').replace(/\/{2,}/g, '/') : '';
  path = path !== '/' ? path.replace(/\/+$/, '') : '';
  return [`${scheme}://${hostAscii}${portS}${path}${query && keepPath ? `?${query}` : ''}`, hostAscii];
}

export interface PhoneInfo {
  e164: string;
  kind: 'MOBILE' | 'LANDLINE' | 'TOLL_FREE' | 'INTERNATIONAL';
}

function badDigits(d: string): boolean {
  return new Set(d).size <= 2 || ['1234567890', '0123456789', '9876543210', '0987654321'].includes(d) || /^(\d)\1{6,}$/.test(d);
}

function india(n: string): PhoneInfo | null {
  if (/^(1800\d{6,8}|1860\d{6,8})$/.test(n)) return { e164: '+91' + n, kind: 'TOLL_FREE' };
  if (n.length === 10 && '6789'.includes(n[0]) && !badDigits(n)) return { e164: '+91' + n, kind: 'MOBILE' };
  if (n.length === 10 && '12345'.includes(n[0]) && !badDigits(n)) return { e164: '+91' + n, kind: 'LANDLINE' };
  return null;
}

/** E.164 for Indian mobile / landline / toll-free numbers and for international numbers written with + or 00; null otherwise. */
export function normalizePhone(raw: string | null | undefined): PhoneInfo | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/[A-Za-z]{3,}/.test(s.replace(/ext\.?\s*\d+|x\s*\d+$/gi, ''))) return null;
  const cut = s.split(/\b(?:ext|extn|x)\b\.?/i)[0];
  const lead = cut.trimStart();
  const international = lead.startsWith('+') || lead.startsWith('00');
  let digits = cut.replace(/\D/g, '');
  if (lead.startsWith('00')) digits = digits.slice(2);
  if (!digits || badDigits(digits.length >= 10 ? digits.slice(-10) : digits)) return null;
  if (international) {
    if (digits.startsWith('91')) return india(digits.slice(2));
    return digits.length >= 8 && digits.length <= 15 ? { e164: '+' + digits, kind: 'INTERNATIONAL' } : null;
  }
  if (digits.length === 12 && digits.startsWith('91')) return india(digits.slice(2));
  if (digits.length === 11 && digits.startsWith('0')) {
    const rest = digits.slice(1);
    if (rest.startsWith('79') || rest.startsWith('80')) return badDigits(rest) ? null : { e164: '+91' + rest, kind: 'LANDLINE' };
    return india(rest);
  }
  if ([10, 11, 12].includes(digits.length) && (digits.startsWith('1800') || digits.startsWith('1860'))) return india(digits);
  return digits.length === 10 ? india(digits) : null;
}

const EMAIL_RE = /(?<![\w.+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![\w-])/;
const EMAIL_FULL_RE = new RegExp(`^${EMAIL_RE.source}$`);
export const EMAIL_SCAN_RE = new RegExp(EMAIL_RE.source, 'g');

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let decoded = String(raw);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep the undecoded text */
  }
  let e = decoded.trim().replace(/^[<>"' ,;]+|[<>"' ,;]+$/g, '').toLowerCase();
  e = e.replace(/^mailto:/, '').split('?')[0].trim();
  if (ASSET_EXT.some((x) => e.endsWith(x)) || e.split('@').length !== 2 || !EMAIL_FULL_RE.test(e)) return null;
  const [local, domain] = e.split('@');
  if (
    PLACEHOLDER_DOMAINS.has(domain) || PLACEHOLDER_LOCALS.has(local) || e.includes('..') || local.startsWith('.') || local.endsWith('.') ||
    /@\d+x\.|\d+x\d+/.test(e) || /^[0-9a-f]{24,}$/.test(local)
  ) {
    return null;
  }
  return e;
}

const TAGLINE_SPLIT = /\s+[|–—•·]\s+|\s+-\s+|\s*:\s+(?=[A-Z])/;
const NAME_PREFIX = /^(welcome\s+to|welcome|home\s*(page)?\s*(of|-|:)|official\s+(web\s*)?site\s+of|official\s+(web\s*)?site\s*[-:|]?)\s+/i;
const GENERIC_TITLES = new Set([
  'home', 'homepage', 'welcome', 'index', 'untitled', 'contact', 'contact us', 'about', 'about us', 'official website',
  'just a moment...', '403 forbidden', '404 not found', 'access denied', 'page not found',
]);

/** Display-ready business name: entities decoded, NFKC, whitespace collapsed, taglines and 'Home |' prefixes dropped. */
export function cleanBusinessName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = unescapeHtml(String(raw)).normalize('NFKC');
  text = text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').replace(/^[ \t"'|\-–—:]+|[ \t"'|\-–—:]+$/g, '');
  if (!text) return null;
  text = text.replace(NAME_PREFIX, '').trim();
  const parts = text.split(TAGLINE_SPLIT).map((p) => p?.trim()).filter((p) => p && !GENERIC_TITLES.has(p.toLowerCase()));
  if (!parts.length) return null;
  const name = parts[0];
  if (name.length > 120 || name.length < 2 || GENERIC_TITLES.has(name.toLowerCase()) || !/[A-Za-z0-9\u0080-￿]/.test(name)) return null;
  return name;
}

const LEGAL = /\b(pvt|private|ltd|limited|llp|llc|inc|incorporated|corp|corporation|co|company|the|and|&)\b/gi;

/** Case/punctuation/legal-suffix-insensitive key used for duplicate detection ('Acme Works Pvt. Ltd.' == 'ACME WORKS'). */
export function nameKey(name: string | null | undefined): string {
  if (!name) return '';
  const text = String(name).normalize('NFKC').toLowerCase().replace(/[.,]/g, '').replace(LEGAL, ' ');
  return text.replace(/[^a-z0-9\u0080-￿]+/g, '');
}

const PHONE_IN_TEXT = /(?:tel|phone|ph|mobile|mob|call|fax|whatsapp)?\s*[:.\-]?\s*(?:\+|00)?\d[\d\s().\-]{8,17}\d/gi;
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const NAV_WORDS = /\b(home|about( us)?|contact( us)?|menu|login|sign ?in|sign ?up|privacy|terms|copyright|all rights|follow us|subscribe|cart|search|read more)\b/i;
const ADDRESS_HINT = new RegExp(
  '\\b(road|rd|street|st|lane|ln|nagar|colony|sector|plot|floor|building|bldg|tower|park|complex|market|marg|avenue|ave|' +
    'block|phase|village|taluk|district|dist|opp|near|behind|po box|p\\.o\\.|suite|unit)\\b',
  'i',
);

/** A postal address, or null: phones/e-mails sharing the element are removed, navigation text rejects the value. */
export function cleanAddress(raw: string | null | undefined, structured = false): string | null {
  if (!raw) return null;
  let text = unescapeHtml(String(raw));
  text = text.replace(PHONE_IN_TEXT, ' ').replace(EMAIL_IN_TEXT, ' ');
  text = text.replace(/\b(tel|phone|mobile|fax|e-?mail|address)\s*[:.\-]\s*/gi, ' ');
  text = text.replace(/\s+/g, ' ').replace(/^[ ,;|:\-]+|[ ,;|:\-]+$/g, '');
  text = text.replace(/\s*,\s*(,\s*)+/g, ', ');
  const parts = text.split(/[,\n]/).filter((p) => p.trim());
  if (structured) {
    return text.length >= 6 && text.length <= 250 && text.split(',').filter((p) => p.trim()).length >= 2 && !NAV_WORDS.test(text) ? text : null;
  }
  if (text.length < 12 || text.length > 250 || NAV_WORDS.test(text) || (text.match(/\./g) ?? []).length > 6) return null;
  const hasCode = /\b\d{5,6}\b/.test(text);
  const hasStreet = ADDRESS_HINT.test(text) || /\d/.test(text);
  if (!((hasCode || hasStreet) && parts.length >= 2) && !hasCode) return null;
  return text;
}

const AUTOMATED_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounce[s]?|unsubscribe|newsletter[s]?|notifications?|alerts?|abuse|webmaster|root|daemon|auto[-_.]?reply|automailer)$/i;
const LIST_LOCAL = /(-|_|\.)(announce|announcements?|list|lists|discuss|users|devel|dev|commits|bugs|digest|news|updates)$|^(announce|list)$/i;
const ROLE_LOCAL = new RegExp(
  '^(info|contact|contactus|contact[-_.]us|sales|support|help|hello|hi|office|enquir(y|ies)|inquir(y|ies)|admin|care|customercare|' +
    'customer[-_.]?(care|service|support)|service[s]?|mail|reception|accounts?|billing|booking[s]?|reservations?|orders?|' +
    'marketing|hr|careers|jobs|feedback|query|queries|general|team|business|trade|export|exports|purchase|enquiry)$',
  'i',
);

export type MailboxKind = 'AUTOMATED' | 'LIST' | 'ROLE' | 'OTHER';

/** AUTOMATED and LIST mailboxes are never reported as a business's e-mail; ROLE (info@, sales@) is best; OTHER ranks lower. */
export function mailboxKind(email: string): MailboxKind {
  const local = email.split('@')[0].toLowerCase();
  if (AUTOMATED_LOCAL.test(local)) return 'AUTOMATED';
  if (LIST_LOCAL.test(local)) return 'LIST';
  return ROLE_LOCAL.test(local) ? 'ROLE' : 'OTHER';
}

/** '98123 45670 / 98123 45671' -> one string per number. */
export function splitPhoneCandidates(raw: string): string[] {
  const parts = String(raw ?? '').split(/\s*(?:\/|;|,|\||\bor\b|\band\b|&)\s*/i);
  const out = parts.map((x) => x.trim()).filter((p) => /\d{5,}/.test(p.replace(/[\s().\-]/g, '')));
  return out.length ? out : [String(raw ?? '')];
}

/** Ratcliff/Obershelp similarity, the algorithm behind Python's difflib.SequenceMatcher.ratio(). */
export function sequenceRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matches = (x: string, y: string): number => {
    if (!x.length || !y.length) return 0;
    let best = 0, bi = 0, bj = 0;
    for (let i = 0; i < x.length; i++) {
      for (let j = 0; j < y.length; j++) {
        let k = 0;
        while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
        if (k > best) { best = k; bi = i; bj = j; }
      }
    }
    return best ? best + matches(x.slice(0, bi), y.slice(0, bj)) + matches(x.slice(bi + best), y.slice(bj + best)) : 0;
  };
  return (2 * matches(a, b)) / (a.length + b.length);
}

export type NameMatchVerdict = 'MATCH' | 'WEAK' | 'MISMATCH' | 'UNKNOWN';

/** Does a page / website belong to a business of this name? Compares with the page's own names and the domain name. */
export function nameMatch(businessName: string, candidates: string[], domain = ''): [NameMatchVerdict, number] {
  const toks = (s: string): string[] =>
    ((s || '').replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|corporation|corp|the|and|&|india|enterprises?|industries)\b/gi, ' ').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
  const bt = toks(businessName);
  if (!bt.length) return ['UNKNOWN', 0];
  let best = 0;
  const bj = bt.join('');
  const dj = domain ? domain.split('.')[0].replace(/[^a-z0-9]/g, '') : '';
  if (dj && dj.length >= 3 && (bj.includes(dj) || dj.includes(bj))) best = 0.9;
  const bset = new Set(bt);
  for (const c of candidates) {
    const ct = toks(c);
    if (!ct.length) continue;
    const cset = new Set(ct);
    const inter = [...bset].filter((t) => cset.has(t)).length;
    const union = new Set([...bset, ...cset]).size;
    best = Math.max(best, inter / union, sequenceRatio(bj, ct.join('')) * 0.9);
    if ([...bset].every((t) => cset.has(t))) best = Math.max(best, 0.8);
  }
  if (!candidates.length && best === 0) return ['UNKNOWN', 0];
  const rounded = Math.round(best * 100) / 100;
  return [best >= 0.6 ? 'MATCH' : best >= 0.35 ? 'WEAK' : 'MISMATCH', rounded];
}
