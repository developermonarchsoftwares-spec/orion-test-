/**
 * Extraction of one business record from fetched HTML. Port of business_scraper/extract.py.
 *
 * Sources, strongest first: configured selectors, JSON-LD / schema.org, microdata, `tel:` / `mailto:` links, labelled visible text.
 * A value that is not found stays empty. Nothing is guessed, and no value is ever marked VERIFIED: it was read from a page.
 */
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { LocationSet } from './location';
import {
  EMAIL_SCAN_RE, FREE_MAIL, SOCIAL_HOSTS, cleanAddress, cleanBusinessName, mailboxKind, nameKey, normalizeEmail, normalizePhone, normalizeUrl,
  registrableDomain, splitPhoneCandidates,
} from './normalize';

export const FIELDS = ['business_name', 'phone', 'email', 'website', 'address', 'source_url', 'extracted_at', 'verification_status'] as const;
export const STATUS_HIGH = 'EXTRACTED_HIGH_CONFIDENCE';
export const STATUS_MEDIUM = 'EXTRACTED_MEDIUM_CONFIDENCE';
export const STATUS_LOW = 'EXTRACTED_LOW_CONFIDENCE';
export const STATUS_NONE = 'NO_CONTACT_DATA';

type Fld = 'business_name' | 'phone' | 'email' | 'website' | 'address';
type Json = Record<string, any>;
type Selectors = Partial<Record<Fld, string>>;

const ORG_TYPES = [
  'organization', 'localbusiness', 'corporation', 'store', 'restaurant', 'professionalservice', 'medicalbusiness', 'foodestablishment',
  'lodgingbusiness', 'financialservice', 'automotivebusiness', 'homeandconstructionbusiness', 'healthandbeautybusiness', 'legalservice',
  'realestateagent', 'travelagency', 'educationalorganization', 'ngo', 'shop',
];
const PHONE_TEXT_RE = /(?<![\w./@-])(?:\+|00)?\d[\d\s().-]{8,17}\d(?![\w@-])/g;
const PHONE_CONTEXT_RE = /(?:tel|telephone|phone|ph|call|mobile|mob|cell|whatsapp|contact|helpline|toll[\s-]?free|customer\s*care|enquiry)\b[^0-9+]{0,24}$/i;
const FAX_RE = /\bfax\b[^0-9+]{0,12}$/i;
const OBFUSCATED: [RegExp, string][] = [[/\s*[[(]\s*at\s*[\])]\s*/gi, '@'], [/\s*[[(]\s*dot\s*[\])]\s*/gi, '.']];
const ADDRESS_LABEL_RE = /\b(?:registered\s+|corporate\s+|head\s+)?(?:office\s+)?address\s*[:\-–]\s*(.{12,220})/i;
const WEBSITE_LINK_TEXT = /^\s*(visit\s+)?(our\s+|the\s+|official\s+)?(web\s*site|site|homepage|www\.\S+)\s*$|visit\s+(website|site)/i;
const CREDIT_RE = /\b(designed|developed|powered|hosted|built|created|website|site)\s+by\b/i;
const WA_RE = /^(?:https?:\/\/(?:wa\.me\/|api\.whatsapp\.com\/send\?(?:[^#]*&)?phone=)|whatsapp:\/\/send\?(?:[^#]*&)?phone=)\+?(\d{8,15})/i;

export class ScrapedRecord {
  business_name = '';
  phone = '';
  email = '';
  website = '';
  address = '';
  source_url = '';
  extracted_at = '';
  verification_status: string = STATUS_NONE;
  /** Per-field method / source page / confidence / alternatives (report only). */
  provenance: Json = {};

  constructor(init: Partial<ScrapedRecord> = {}) {
    Object.assign(this, init);
  }

  row(): { [k: string]: string } {
    return Object.fromEntries(FIELDS.map((k) => [k, (this[k] as string) || '']));
  }

  get(name: Fld | 'source_url'): string {
    return this[name] || '';
  }
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

const tidy = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const asList = (v: unknown): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const endsWithAny = (host: string, suffixes: string[]): boolean => suffixes.some((s) => host.endsWith(s));

function join(url: string, href: string): string {
  try {
    return new URL(href, url).href;
  } catch {
    return href;
  }
}

/** Text nodes under `root`, each stripped, empties dropped, joined with `sep` (BeautifulSoup get_text(sep, strip=True)). */
function textOf(root: AnyNode | AnyNode[], sep: string): string {
  const out: string[] = [];
  const walk = (n: AnyNode): void => {
    if (n.type === 'text') {
      const t = (n as any).data.trim();
      if (t) out.push(t);
    } else if ((n as any).children && n.type !== 'comment' && n.type !== 'directive') {
      (n as any).children.forEach(walk);
    }
  };
  (Array.isArray(root) ? root : [root]).forEach(walk);
  return out.join(sep);
}

function jsonldNodes($: cheerio.CheerioAPI): Json[] {
  const nodes: Json[] = [];
  const walk = (o: any, depth = 0): void => {
    if (depth > 6) return;
    if (Array.isArray(o)) o.forEach((x) => walk(x, depth + 1));
    else if (o && typeof o === 'object') {
      nodes.push(o);
      for (const key of ['@graph', 'mainEntity', 'publisher', 'provider', 'itemListElement', 'item', 'contactPoint', 'department', 'location']) {
        if (key in o) walk(o[key], depth + 1);
      }
    }
  };
  $('script').each((_, el) => {
    if (!/ld\+json/i.test($(el).attr('type') ?? '')) return;
    try {
      walk(JSON.parse(($(el).text() || '').trim() || 'null'));
    } catch {
      /* invalid JSON-LD is ignored */
    }
  });
  return nodes;
}

const typesOf = (node: Json): string[] => asList(node['@type']).map((t) => String(t).toLowerCase().split('/').pop() as string);
const isOrg = (node: Json): boolean => typesOf(node).some((t) => ORG_TYPES.includes(t) || /(business|store|organization|service)$/.test(t));

/** Cloudflare 'email protection' publishes the address XOR-encoded in the page. */
export function decodeCfEmail(hex: string): string | null {
  const h = hex.trim();
  if (!/^([0-9a-f]{2}){2,}$/i.test(h)) return null;
  const raw = Buffer.from(h, 'hex');
  const key = raw[0];
  return Buffer.from(raw.subarray(1).map((b) => b ^ key)).toString('utf8');
}

function addressText(addr: unknown): string | null {
  if (typeof addr === 'string') return cleanAddress(addr);
  if (addr && typeof addr === 'object') {
    const parts: string[] = [];
    for (const k of ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']) {
      let v = (addr as Json)[k];
      if (v && typeof v === 'object') v = v.name;
      if (typeof v === 'string' && v.trim()) parts.push(tidy(v));
    }
    return cleanAddress(parts.join(', '), true);
  }
  return null;
}

/** URLs listed in a schema.org ItemList (a standard way for a directory page to list its entries). */
export function jsonldItemlistUrls(html: string): string[] {
  const urls: string[] = [];
  for (const node of jsonldNodes(cheerio.load(html || ''))) {
    if (!typesOf(node).includes('itemlist')) continue;
    for (const el of asList(node.itemListElement)) {
      if (!el || typeof el !== 'object') continue;
      let u = el.url;
      if (!u && el.item && typeof el.item === 'object') u = el.item.url;
      if (typeof el.item === 'string') u = u || el.item;
      if (typeof u === 'string') urls.push(u);
    }
  }
  return urls;
}

interface Cand { value: string; confidence: number; method: string; source_url: string; [k: string]: any }

class Candidates {
  items: Rec_<Fld, Cand[]> = { business_name: [], phone: [], email: [], website: [], address: [] };
  rejected: Json[] = [];

  reject(field: string, value: string, reason: string, url: string): void {
    if (this.rejected.length < 40) this.rejected.push({ field, value, reason, source_url: url });
  }

  add(field: Fld, value: string | null | undefined, conf: number, method: string, url: string, extra: Json = {}): void {
    if (value) this.items[field].push({ value, confidence: Math.round(conf * 100) / 100, method, source_url: url, ...extra });
  }

  best(field: Fld): Json | null {
    const cands = this.items[field];
    if (!cands.length) return null;
    const top = cands.reduce((a, c) => (c.confidence > a.confidence ? c : a));     // keeps the first of equals
    const merged: Json = { ...top };
    merged.alternatives = [...new Set(cands.filter((c) => c.value !== top.value).map((c) => c.value))].sort().slice(0, 5);
    const methods = [...new Set(cands.filter((c) => c.value === top.value).map((c) => c.method))].sort();
    if (methods.length >= 2) {                                // the same value found by independent routes is more trustworthy
      merged.confidence = Math.round(Math.min(top.confidence + 0.05, 0.99) * 100) / 100;
      merged.corroborated_by = methods;
    }
    return merged;
  }
}
type Rec_<K extends string, V> = { [P in K]: V };

export interface ExtractOptions {
  selectors?: Selectors;
  businessSite?: boolean;
  excludeDomains?: Set<string>;
  extractedAt?: string;
  location?: LocationSet | null;
}

/**
 * pages: [url, html] pairs; the first is the primary page. businessSite=true means the primary page belongs to the business itself, so its
 * own address is the official website; false means a third-party profile page, where the website must be published on the page and
 * platform-level contacts (header, nav, footer, the platform's own domain) are ignored.
 */
export function extractBusiness(pages: [string, string][], opts: ExtractOptions = {}): ScrapedRecord {
  const selectors = opts.selectors ?? {};
  const businessSite = opts.businessSite ?? true;
  const excludeDomains = opts.excludeDomains ?? new Set<string>();
  const cands = new Candidates();
  const primaryUrl = pages.length ? pages[0][0] : '';
  const normPrimary = normalizeUrl(primaryUrl);
  const siteDomain = normPrimary && businessSite ? registrableDomain(normPrimary[1]) : '';
  const strict = !businessSite;

  const originOf = (u: string): string | null => {
    const n = normalizeUrl(u, false);
    return n ? n[0] : null;
  };

  const addPhone = (raw: string, conf: number, method: string, url: string): void => {
    for (const piece of splitPhoneCandidates(raw)) {
      const info = normalizePhone(piece);
      if (info) cands.add('phone', info.e164, conf, method, url, { kind: info.kind });
    }
  };

  const addEmail = (raw: string, conf: number, method: string, url: string, strong: boolean, contactCtx: boolean, suspect = false): void => {
    const e = normalizeEmail(raw);
    if (!e) return;
    const dom = e.split('@')[1];
    if (excludeDomains.has(registrableDomain(dom))) return;
    const mk = mailboxKind(e);
    if (mk === 'AUTOMATED' || mk === 'LIST') {
      cands.reject('email', e, `${mk.toLowerCase()} mailbox, not a contact address of the business`, url);
      return;
    }
    const adj = mk === 'ROLE' ? 0.05 : -0.1;
    const same = !!siteDomain && registrableDomain(dom) === siteDomain;
    if (same) cands.add('email', e, Math.min(conf + 0.1 + adj, 0.99), method, url, { kind: 'BUSINESS_DOMAIN', mailbox: mk });
    else if (FREE_MAIL.has(dom) && (strong || contactCtx)) cands.add('email', e, Math.min(conf + adj, 0.7), method, url, { kind: 'FREE_MAIL', mailbox: mk });
    else if (strong && (/^(JSON_LD|SELECTOR|MICRODATA)/.test(method) || (contactCtx && !suspect))) {
      cands.add('email', e, Math.min(conf + adj, 0.6), method, url, { kind: 'OTHER_DOMAIN', mailbox: mk });
    } else cands.reject('email', e, 'domain differs from the business website and is not published as its contact', url);
  };

  pages.forEach(([url, html], idx) => {
    const $ = cheerio.load(html || '');
    const primary = idx === 0;
    const inPlatformRegion = (el: Element): boolean => strict && $(el).parents('header,nav,footer').length > 0;

    // ---- structured data
    for (const node of jsonldNodes($)) {
      if (typesOf(node).includes('contactpoint')) {
        asList(node.telephone).forEach((t) => addPhone(String(t), 0.92, 'JSON_LD_CONTACTPOINT', url));
        asList(node.email).forEach((e) => addEmail(String(e), 0.92, 'JSON_LD_CONTACTPOINT', url, true, true));
        continue;
      }
      if (!isOrg(node)) continue;
      if (primary && typeof node.name === 'string') cands.add('business_name', cleanBusinessName(node.name), 0.95, 'JSON_LD', url);
      asList(node.telephone).forEach((t) => addPhone(String(t), 0.95, 'JSON_LD', url));
      asList(node.email).forEach((e) => addEmail(String(e), 0.95, 'JSON_LD', url, true, true));
      if (typeof node.url === 'string') {
        const n = normalizeUrl(join(url, node.url));
        if (n && !endsWithAny(n[1], SOCIAL_HOSTS) && !excludeDomains.has(registrableDomain(n[1]))) {
          // on a business's own site, a JSON-LD url that points to another domain is a warning sign, not a website
          const same = !businessSite || registrableDomain(n[1]) === siteDomain;
          cands.add('website', originOf(n[0]), same ? 0.9 : 0.5, 'JSON_LD', url);
        }
      }
      cands.add('address', addressText(node.address), 0.95, 'JSON_LD', url);
    }
    $('[itemscope][itemtype]').each((_, scope) => {
      if (!/(LocalBusiness|Organization|Store|Restaurant)/i.test($(scope).attr('itemtype') ?? '')) return;
      const prop = (name: string): string | null => {
        const el = $(scope).find(`[itemprop="${name}"]`).first();
        if (!el.length) return null;
        return el.attr('content') || el.attr('href') || textOf(el.get(0) as AnyNode, ' ');
      };
      if (primary) cands.add('business_name', cleanBusinessName(prop('name')), 0.9, 'MICRODATA', url);
      const tel = prop('telephone');
      if (tel) addPhone(tel, 0.9, 'MICRODATA', url);
      const mail = prop('email');
      if (mail) addEmail(mail, 0.9, 'MICRODATA', url, true, true);
      cands.add('address', cleanAddress(prop('address')), 0.9, 'MICRODATA', url);
    });
    // ---- configured selectors (verified by the user for this source)
    if (primary && Object.keys(selectors).length) {
      const pick = (key: Fld) => {
        const sel = selectors[key];
        if (!sel) return null;
        try {
          const el = $(sel).first();
          return el.length ? el : null;
        } catch {
          return null;
        }
      };
      let el = pick('business_name');
      if (el) cands.add('business_name', cleanBusinessName(textOf(el.get(0) as AnyNode, ' ')), 0.92, 'SELECTOR', url);
      el = pick('phone');
      if (el) addPhone((el.attr('href') ?? '').replace('tel:', '') || textOf(el.get(0) as AnyNode, ' '), 0.92, 'SELECTOR', url);
      el = pick('email');
      if (el) addEmail(el.attr('href') || textOf(el.get(0) as AnyNode, ' '), 0.92, 'SELECTOR', url, true, true);
      el = pick('website');
      if (el) {
        const n = normalizeUrl(join(url, el.attr('href') || textOf(el.get(0) as AnyNode, ' ')));
        if (n && !excludeDomains.has(registrableDomain(n[1]))) cands.add('website', originOf(n[0]), 0.9, 'SELECTOR', url);
      }
      el = pick('address');
      if (el) cands.add('address', cleanAddress(textOf(el.get(0) as AnyNode, ' ')), 0.9, 'SELECTOR', url);
    }
    // ---- identity hints on the primary page
    if (primary) {
      const og = $('meta[property="og:site_name"]').attr('content');
      if (og) cands.add('business_name', cleanBusinessName(og), 0.8, 'OG_SITE_NAME', url);
      const h1 = $('h1').first();
      if (h1.length) cands.add('business_name', cleanBusinessName(textOf(h1.get(0) as AnyNode, ' ')), 0.6, 'H1', url);
      const title = $('title').first();
      if (title.length && title.text()) cands.add('business_name', cleanBusinessName(title.text()), 0.5, 'TITLE', url);
    }
    // ---- links
    let pathname = '';
    try {
      pathname = new URL(url).pathname;
    } catch {
      /* no path */
    }
    const contactPage = /contact|reach|touch|enquir|about|location|find/i.test(pathname);
    $('script,style,noscript,template,iframe,svg,pre,code,kbd,samp').remove();
    $('[data-cfemail]').each((_, el) => {
      const decoded = decodeCfEmail($(el).attr('data-cfemail') ?? '');
      if (decoded && !inPlatformRegion(el)) addEmail(decoded, 0.86, 'CLOUDFLARE_EMAIL', url, true, contactPage || primary);
    });
    $('a[href]').each((_, a) => {
      const href = ($(a).attr('href') ?? '').trim();
      const low = href.toLowerCase();
      const wa = WA_RE.exec(href);
      if (wa && !inPlatformRegion(a)) addPhone('+' + wa[1], 0.8, 'WHATSAPP_LINK', url);
      else if (low.startsWith('tel:')) {
        if (!inPlatformRegion(a)) {
          let v = href.slice(4);
          try {
            v = decodeURIComponent(v);
          } catch {
            /* keep as is */
          }
          addPhone(v, 0.9, 'TEL_LINK', url);
        }
      } else if (low.startsWith('mailto:')) {
        if (inPlatformRegion(a)) return;
        const parent = $(a).parent();
        const near = tidy(parent.length ? textOf(parent.get(0) as AnyNode, ' ').slice(0, 200) : '');
        const suspect = $(a).parents('footer').length > 0 || CREDIT_RE.test(near);
        addEmail(href.slice(7), 0.88, 'MAILTO_LINK', url, true, contactPage || primary, suspect);
      } else if (primary && !businessSite && !inPlatformRegion(a) && WEBSITE_LINK_TEXT.test(textOf(a, ' '))) {
        const n = normalizeUrl(join(url, href));
        if (n && !endsWithAny(n[1], SOCIAL_HOSTS) && !excludeDomains.has(registrableDomain(n[1]))) cands.add('website', originOf(n[0]), 0.7, 'WEBSITE_LINK', url);
      }
    });
    // ---- address element
    $('address').each((_, el) => {
      if (!strict || !inPlatformRegion(el)) cands.add('address', cleanAddress(textOf(el, ' ')), 0.8, 'ADDRESS_TAG', url);
    });
    // ---- visible text (outside platform regions for third-party profile pages)
    if (strict) $('header,nav,footer').remove();
    const root = $.root().get(0) as AnyNode;
    const text = textOf(root, '\n');
    const flat = tidy(text);
    let deob = flat;
    for (const [pat, rep] of OBFUSCATED) deob = deob.replace(pat, rep);
    for (const m of deob.matchAll(EMAIL_SCAN_RE)) addEmail(m[0], 0.7, 'VISIBLE_TEXT', url, false, contactPage);
    for (const m of flat.matchAll(PHONE_TEXT_RE)) {
      const raw = m[0];
      const start = m.index ?? 0;
      const before = flat.slice(Math.max(0, start - 40), start);
      if (FAX_RE.test(before)) continue;
      const groups: string[] = raw.match(/\d+/g) ?? [];
      if (groups.length > 5 || groups.filter((g) => g.length === 1).length >= 3) continue;
      const ctx = PHONE_CONTEXT_RE.test(before);
      const formatted = /^\s*(\+|00)/.test(raw) || /[\s\-().]/.test(raw.trim());
      const info = normalizePhone(raw);
      if (!info || !(ctx || formatted || contactPage)) continue;
      if (info.kind === 'LANDLINE' && !ctx && !/^\s*(\+|00|0\d)/.test(raw)) continue;
      addPhone(raw, ctx ? 0.8 : formatted ? 0.6 : 0.5, ctx ? 'VISIBLE_TEXT_LABELLED' : 'VISIBLE_TEXT', url);
    }
    for (const line of text.split(/\r?\n/)) {
      const m = ADDRESS_LABEL_RE.exec(line);
      if (m) cands.add('address', cleanAddress(m[1]), 0.6, 'LABELLED_TEXT', url);
    }
  });

  // ---- the business's own site is its official website (only when the page belongs to the business)
  if (businessSite && normPrimary) cands.add('website', originOf(normPrimary[0]), 0.8, 'SOURCE_URL', primaryUrl);

  const rec = new ScrapedRecord({ source_url: primaryUrl, extracted_at: opts.extractedAt || nowIso() });
  let locationNote: Json | null = null;
  if (opts.location) {
    // A company may list several addresses (head office, branches). Take the best one inside the imported location; if none is, the best
    // candidate is kept only so the verdict (and why) can be reported. Never a guessed address.
    const ranked = [...cands.items.address].sort((a, b) => b.confidence - a.confidence);
    const verdicts = ranked.map((c) => [c, opts.location!.check(c.value)] as const);
    const inside = verdicts.filter(([, v]) => v.verdict === 'MATCH');
    if (inside.length) {
      const set = new Set(inside.map(([c]) => c));
      cands.items.address = cands.items.address.filter((c) => set.has(c));
      locationNote = { verdict: 'MATCH', reason: inside[0][1].reason, address: inside[0][0].value };
    } else if (verdicts.length) {
      locationNote = { verdict: verdicts[0][1].verdict, reason: verdicts[0][1].reason, address: verdicts[0][0].value };
    } else {
      locationNote = { verdict: 'UNKNOWN', reason: 'no address was found, so the location cannot be validated', address: '' };
    }
  }
  if (siteDomain) {                                            // the name that agrees with the domain name is more likely the business's
    const label = siteDomain.split('.')[0];
    for (const c of cands.items.business_name) {
      const k = nameKey(c.value);
      if (label.length >= 3 && (k.includes(label) || (k.length >= 3 && label.includes(k)))) c.confidence = Math.round(Math.min(c.confidence + 0.1, 0.99) * 100) / 100;
    }
  }
  if (cands.rejected.length) rec.provenance._rejected = cands.rejected;
  if (locationNote) rec.provenance.location = locationNote;
  for (const fld of ['business_name', 'phone', 'email', 'website', 'address'] as Fld[]) {
    const best = cands.best(fld);
    if (best) {
      const { value, ...rest } = best;
      rec[fld] = value;
      rec.provenance[fld] = rest;
    }
  }
  rec.verification_status = computeStatus(rec);
  return rec;
}

/** From the evidence behind the phone / e-mail. Never VERIFIED: nothing here is confirmed with the business. */
export function computeStatus(rec: ScrapedRecord): string {
  const conf = (['phone', 'email'] as const).filter((f) => rec.get(f) && rec.provenance[f]).map((f) => rec.provenance[f].confidence as number);
  if (!conf.length) return STATUS_NONE;
  const top = Math.max(...conf);
  let status = top >= 0.85 && rec.business_name ? STATUS_HIGH : top >= 0.65 ? STATUS_MEDIUM : STATUS_LOW;
  const check = rec.provenance.website_check?.result;
  if (check === 'WEAK' || check === 'UNKNOWN') status = status === STATUS_HIGH ? STATUS_MEDIUM : status === STATUS_MEDIUM ? STATUS_LOW : status;
  return status;
}

const STATUSES = new Set([STATUS_HIGH, STATUS_MEDIUM, STATUS_LOW, STATUS_NONE]);

/**
 * Last gate before a record is stored: every field is checked again with the same rules that extracted it. A field that does not pass is
 * blanked (never repaired or guessed). Returns the names of the fields that were dropped.
 */
export function revalidate(rec: ScrapedRecord): string[] {
  const dropped: string[] = [];
  if (rec.phone) {
    const info = normalizePhone(rec.phone);
    if (!(info && info.e164 === rec.phone)) { rec.phone = ''; dropped.push('phone'); }
  }
  if (rec.email) {
    const e = normalizeEmail(rec.email);
    if (e && e === rec.email.toLowerCase() && !['AUTOMATED', 'LIST'].includes(mailboxKind(e))) rec.email = e;
    else { rec.email = ''; dropped.push('email'); }
  }
  if (rec.website) {
    const n = normalizeUrl(rec.website, false);
    if (!(n && n[0] === rec.website)) { rec.website = ''; dropped.push('website'); }
  }
  if (rec.address) {
    const a = cleanAddress(rec.address, true);
    if (a) rec.address = a;
    else { rec.address = ''; dropped.push('address'); }
  }
  if (rec.business_name) {
    const nm = cleanBusinessName(rec.business_name);
    if (nm) rec.business_name = nm;
    else { rec.business_name = ''; dropped.push('business_name'); }
  }
  if (Number.isNaN(Date.parse(rec.extracted_at))) rec.extracted_at = nowIso();
  if (rec.source_url && !normalizeUrl(rec.source_url)) { rec.source_url = ''; dropped.push('source_url'); }
  for (const f of dropped) delete rec.provenance[f];
  rec.verification_status = STATUSES.has(rec.verification_status) ? computeStatus(rec) : STATUS_NONE;
  return dropped;
}

/** Same-site links that usually carry contact details (contact / about / reach us / location), shallow paths only. */
export function discoverContactPages(baseUrl: string, html: string, limit = 3): string[] {
  const $ = cheerio.load(html || '');
  const base = normalizeUrl(baseUrl);
  if (!base) return [];
  const dom = registrableDomain(base[1]);
  const pattern = /contact|reach[-_ ]?us|get[-_ ]?in[-_ ]?touch|enquir|about|who[-_ ]we|location|find[-_ ]?us|support/i;
  const found: string[] = [];
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim();
    if (/^(#|javascript:|mailto:|tel:)/i.test(href)) return;
    const n = normalizeUrl(join(baseUrl, href.split('#')[0]));
    if (!n || registrableDomain(n[1]) !== dom || /\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?)$/i.test(n[0])) return;
    const path = new URL(n[0]).pathname;
    if ((path.match(/\//g) ?? []).length > 2 || n[0].replace(/\/+$/, '') === base[0].replace(/\/+$/, '')) return;
    if (pattern.test(path) || pattern.test(textOf(a, ' ').slice(0, 40))) {
      if (!found.includes(n[0])) found.push(n[0]);
    }
  });
  const rank = (u: string) => (/contact|reach|touch|enquir/i.test(u) ? 0 : 1);
  found.sort((a, b) => rank(a) - rank(b) || a.length - b.length);
  return found.slice(0, limit);
}
