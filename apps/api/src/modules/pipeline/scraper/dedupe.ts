/**
 * Duplicate detection on normalised identifiers. Port of business_scraper/dedupe.py.
 *
 * Two records are the same business when they share ANY of: the same source page; the registrable domain of the official website; a
 * business-domain e-mail (free-mail is too generic); the same normalised name AND phone; the same normalised name AND address. A phone
 * or a name alone is not a key. On a duplicate the first record is kept and its EMPTY fields are filled from the newcomer.
 */
import type { ScrapedRecord } from './extract';
import { FREE_MAIL, nameKey, normalizeUrl, registrableDomain } from './normalize';

export function recordKeys(rec: ScrapedRecord): string[] {
  const keys: string[] = [];
  if (rec.source_url) {
    const n = normalizeUrl(rec.source_url);
    if (n) keys.push('src:' + n[0]);
  }
  if (rec.website) {
    const n = normalizeUrl(rec.website);
    if (n) keys.push('site:' + registrableDomain(n[1]));
  }
  if (rec.email && rec.email.includes('@')) {
    const dom = rec.email.split('@')[1];
    if (!FREE_MAIL.has(dom)) keys.push('mail:' + rec.email.toLowerCase());
  }
  const nk = nameKey(rec.business_name);
  if (nk && rec.phone) keys.push(`namephone:${nk}|${rec.phone}`);
  if (nk && rec.address) keys.push(`nameaddr:${nk}|${rec.address.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 80)}`);
  return keys;
}

const FILL_FIELDS = ['business_name', 'phone', 'email', 'website', 'address'] as const;

export class DedupIndex {
  records: ScrapedRecord[] = [];
  duplicates = 0;
  private byKey = new Map<string, number>();

  constructor(records: Iterable<ScrapedRecord> = []) {
    for (const r of records) this.add(r, false);
  }

  /** [isNew, storedRecord]. A duplicate fills empty fields of the stored record and is counted. */
  add(rec: ScrapedRecord, countDuplicate = true): [boolean, ScrapedRecord] {
    const keys = recordKeys(rec);
    const hitKey = keys.find((k) => this.byKey.has(k));
    if (hitKey === undefined) {
      this.records.push(rec);
      keys.forEach((k) => this.byKey.set(k, this.records.length - 1));
      return [true, rec];
    }
    const hit = this.byKey.get(hitKey) as number;
    const kept = this.records[hit];
    for (const f of FILL_FIELDS) {
      if (!kept[f] && rec[f]) {
        kept[f] = rec[f];
        kept.provenance[f] = rec.provenance[f] ?? {};
      }
    }
    for (const k of recordKeys(kept)) if (!this.byKey.has(k)) this.byKey.set(k, hit);
    if (countDuplicate) this.duplicates++;
    return [false, kept];
  }
}
