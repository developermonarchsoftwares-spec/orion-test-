/**
 * Source configuration for a public directory. Port of business_scraper/sources.py.
 *
 * The scraper ships NO selectors for any specific website: how a directory is built has to be inspected on the real site, and whether
 * collecting from it is permitted has to be decided by a person who has read its terms and robots.txt. A source file records both:
 *
 *   { "name": "...", "hosts": ["directory.example.org"], "terms_reviewed": true, "terms_notes": "...",
 *     "profile_link_selector": "a.listing-title", "next_page_selector": "a.next",
 *     "selectors": { "business_name": "h1", "phone": "a.tel", "email": "a.mail", "website": "a.site", "address": "div.addr" },
 *     "max_pages": 10 }
 */
import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';

const SELECTOR_KEYS = new Set(['business_name', 'phone', 'email', 'website', 'address']);

export class SourceConfigError extends Error {}

export interface SourceConfig {
  name: string;
  hosts: string[];
  profile_link_selector: string;
  next_page_selector: string | null;
  selectors: Record<string, string>;
  max_pages: number;
  terms_notes: string;
}

function checkSelector(sel: unknown, what: string): string {
  if (typeof sel !== 'string' || !sel.trim() || sel.length > 200) throw new SourceConfigError(`${what}: selector must be a non-empty string of at most 200 characters`);
  try {
    cheerio.load('<div></div>')(sel);
  } catch {
    throw new SourceConfigError(`${what}: invalid CSS selector (SyntaxError)`);
  }
  return sel.trim();
}

export function parseSourceConfig(raw: unknown): SourceConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SourceConfigError('source file must contain a JSON object');
  const r = raw as Record<string, any>;
  if (r.terms_reviewed !== true) {
    throw new SourceConfigError(
      "terms_reviewed must be true: confirm that you reviewed the site's terms and robots.txt and that collection is permitted. When permission is unclear, do not scrape the source.",
    );
  }
  const hosts = r.hosts;
  if (!Array.isArray(hosts) || !hosts.length || !hosts.every((h) => typeof h === 'string' && /^[A-Za-z0-9.-]{3,253}$/.test(h))) {
    throw new SourceConfigError('hosts must be a non-empty list of host names');
  }
  const selectors = r.selectors ?? {};
  if (typeof selectors !== 'object' || Array.isArray(selectors) || Object.keys(selectors).some((k) => !SELECTOR_KEYS.has(k))) {
    throw new SourceConfigError(`selectors may only use these keys: ${JSON.stringify([...SELECTOR_KEYS].sort())}`);
  }
  const maxPages = r.max_pages ?? 10;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new SourceConfigError('max_pages must be an integer from 1 to 200');
  return {
    name: String(r.name || hosts[0]).slice(0, 100),
    hosts: hosts.map((h: string) => h.toLowerCase().replace(/^\.+|\.+$/g, '')),
    profile_link_selector: checkSelector(r.profile_link_selector, 'profile_link_selector'),
    next_page_selector: r.next_page_selector ? checkSelector(r.next_page_selector, 'next_page_selector') : null,
    selectors: Object.fromEntries(Object.entries(selectors).map(([k, v]) => [k, checkSelector(v, `selectors.${k}`)])),
    max_pages: maxPages,
    terms_notes: String(r.terms_notes || '').slice(0, 500),
  };
}

export function loadSourceConfig(path: string): SourceConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new SourceConfigError(`cannot read source file '${path}': ${(err as Error).message}`);
  }
  return parseSourceConfig(raw);
}
