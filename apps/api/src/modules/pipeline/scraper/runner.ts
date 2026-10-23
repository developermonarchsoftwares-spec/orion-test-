/** Orchestration: URL in, records out. A failure on one page or one URL never stops the run. Port of business_scraper/runner.py. */
import * as cheerio from 'cheerio';
import { DedupIndex } from './dedupe';
import { ScrapedRecord, computeStatus, discoverContactPages, extractBusiness, jsonldItemlistUrls, revalidate } from './extract';
import type { FetchOutcome, PoliteFetcher } from './fetcher';
import type { LocationSet } from './location';
import { nameMatch, normalizeUrl, registrableDomain } from './normalize';
import type { SourceConfig } from './sources';

/** URL for logs and reports without query string or fragment (they can carry tokens). */
export function safeUrl(url: string): string {
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  } catch {
    return '<unparseable>';
  }
}

export interface Stats {
  urls_input: number;
  urls_invalid: number;
  pages_requested: number;
  pages_fetched: number;
  pages_failed: number;
  robots_blocked: number;
  businesses_processed: number;
  records_new: number;
  duplicates: number;
  records_without_contact_data: number;
  skipped_incomplete: number;
  location_mismatch: number;
  location_unverified: number;
  fields_dropped_by_validation: number;
  websites_verified: number;
  websites_rejected: number;
  stopped_by_limit: string | null;
  failures: { url: string; reason: string; message: string }[];
}

const newStats = (): Stats => ({
  urls_input: 0, urls_invalid: 0, pages_requested: 0, pages_fetched: 0, pages_failed: 0, robots_blocked: 0, businesses_processed: 0, records_new: 0,
  duplicates: 0, records_without_contact_data: 0, skipped_incomplete: 0, location_mismatch: 0, location_unverified: 0, fields_dropped_by_validation: 0,
  websites_verified: 0, websites_rejected: 0, stopped_by_limit: null, failures: [],
});

export interface RunnerOptions {
  maxPages?: number;
  maxRecords?: number;
  sources?: SourceConfig[];
  existing?: ScrapedRecord[];
  verifyWebsites?: boolean;
  includeIncomplete?: boolean;
  location?: LocationSet | null;
  allowUnknownLocation?: boolean;
}

export class Runner {
  readonly maxPages: number;
  readonly maxRecords: number;
  readonly sources: SourceConfig[];
  readonly index: DedupIndex;
  readonly stats = newStats();
  /** Records that were read but not accepted into the output, with the reason. */
  readonly skipped: Record<string, unknown>[] = [];
  private readonly location: LocationSet | null;
  private readonly allowUnknownLocation: boolean;
  private readonly verifyWebsites: boolean;
  private readonly includeIncomplete: boolean;
  private budgetUsed = 0;
  private visited = new Set<string>();

  constructor(private readonly fetcher: PoliteFetcher, opts: RunnerOptions = {}) {
    this.maxPages = Math.max(1, opts.maxPages ?? 25);
    this.maxRecords = Math.max(1, opts.maxRecords ?? 100);
    this.sources = opts.sources ?? [];
    this.index = new DedupIndex(opts.existing ?? []);
    this.verifyWebsites = opts.verifyWebsites ?? true;
    this.includeIncomplete = opts.includeIncomplete ?? false;
    this.location = opts.location ?? null;
    this.allowUnknownLocation = opts.allowUnknownLocation ?? false;
  }

  // ---------------------------------------------------------------- budget and fetching
  private limitReached(): boolean {
    if (this.stats.businesses_processed >= this.maxRecords) {
      this.stats.stopped_by_limit ??= `max records (${this.maxRecords})`;
      return true;
    }
    if (this.budgetUsed >= this.maxPages) {
      this.stats.stopped_by_limit ??= `max pages (${this.maxPages})`;
      return true;
    }
    return false;
  }

  /** quiet: a missing page is expected (guessed contact path, website check); a plain 404 is not listed as a failure. */
  private async fetch(url: string, quiet = false): Promise<FetchOutcome | null> {
    if (this.limitReached()) return null;
    this.budgetUsed++;
    this.stats.pages_requested++;
    this.visited.add(url);
    const out = await this.fetcher.fetch(url);
    if (out.ok) {
      this.stats.pages_fetched++;
      return out;
    }
    if (quiet && out.reason === 'HTTP_ERROR' && out.status === 404) return null;
    this.stats.pages_failed++;
    if (out.reason === 'ROBOTS_DISALLOWED' || out.reason === 'ROBOTS_UNREACHABLE') this.stats.robots_blocked++;
    this.stats.failures.push({ url: safeUrl(url), reason: out.reason || 'FAILED', message: out.message });
    return null;
  }

  private fail(url: string, reason: string, message: string): void {
    this.stats.failures.push({ url: safeUrl(url), reason, message });
  }

  // ---------------------------------------------------------------- record handling
  /**
   * True when the record must not be exported because of its location. Before the website check only a contradiction rejects (the website
   * might still supply the address); after it, anything but a positive match rejects (unless unknown is allowed).
   */
  private locationRejects(rec: ScrapedRecord, final: boolean): boolean {
    if (!this.location) return false;
    const v = this.location.check(rec.address);
    rec.provenance.location = { verdict: v.verdict, reason: v.reason, address: rec.address };
    if (v.verdict === 'MATCH' || (v.verdict === 'UNKNOWN' && (!final || this.allowUnknownLocation))) return false;
    if (v.verdict === 'MISMATCH') this.stats.location_mismatch++;
    else this.stats.location_unverified++;
    this.skipped.push({
      source_url: rec.source_url, business_name: rec.business_name, website: rec.website, address: rec.address,
      reason: `location ${v.verdict !== 'UNKNOWN' ? v.verdict.toLowerCase() : 'not verified'}: ${v.reason}`, dropped_fields: [],
    });
    return true;
  }

  private async store(rec: ScrapedRecord, thirdPartyProfile = false): Promise<void> {
    this.stats.businesses_processed++;
    if (this.location && rec.address && this.location.check(rec.address).verdict === 'MISMATCH') {
      this.locationRejects(rec, false);                 // its own address is elsewhere: no website check can change that
      return;
    }
    if (thirdPartyProfile && this.verifyWebsites && rec.website) await this.verifyWebsite(rec);
    const dropped = revalidate(rec);
    if (this.locationRejects(rec, true)) return;
    this.stats.fields_dropped_by_validation += dropped.length;
    if (!(rec.phone || rec.email)) this.stats.records_without_contact_data++;
    // Acceptance gate: a record needs a name and at least one way to reach or locate the business, otherwise it is reported, not exported.
    if (!this.includeIncomplete && !(rec.business_name && (rec.phone || rec.email || rec.address))) {
      this.stats.skipped_incomplete++;
      this.skipped.push({
        source_url: rec.source_url, business_name: rec.business_name, website: rec.website,
        reason: !rec.business_name ? 'no business name' : 'no phone, e-mail or address found', dropped_fields: dropped,
      });
      return;
    }
    const [isNew] = this.index.add(rec);
    if (isNew) this.stats.records_new++;
    else this.stats.duplicates++;
  }

  private configFor(host: string): SourceConfig | null {
    const dom = registrableDomain(host);
    return this.sources.find((cfg) => cfg.hosts.some((h) => registrableDomain(h) === dom)) ?? null;
  }

  // ---------------------------------------------------------------- modes
  async run(urls: string[]): Promise<ScrapedRecord[]> {
    for (const raw of urls) {
      this.stats.urls_input++;
      if (this.limitReached()) break;
      const norm = normalizeUrl(raw);
      if (!norm) {
        this.stats.urls_invalid++;
        this.fail(String(raw).slice(0, 200), 'INVALID_URL', 'not a valid public http(s) address');
        continue;
      }
      if (this.visited.has(norm[0])) continue;
      try {
        await this.process(norm[0], norm[1]);
      } catch (err) {                                   // one bad source must not end the job
        this.fail(norm[0], 'EXTRACTION_ERROR', `${(err as Error).name}: ${String((err as Error).message).slice(0, 150)}`);
      }
    }
    return this.index.records;
  }

  private async process(url: string, host: string): Promise<void> {
    const out = await this.fetch(url);
    if (!out) return;
    const final = out.finalUrl || url;
    const cfg = this.configFor(host);
    if (cfg) return this.directory(final, out.html, cfg);
    const listed = this.sameSiteLinks(final, jsonldItemlistUrls(out.html));
    if (listed.length) return this.itemList(final, out.html, listed);
    return this.businessSite(final, out.html);
  }

  private async businessSite(url: string, html: string): Promise<void> {
    const pages: [string, string][] = [[url, html]];
    const linked = discoverContactPages(url, html, 3);
    for (const extra of linked) {
      if (this.limitReached()) break;
      const sub = await this.fetch(extra);
      if (sub) pages.push([sub.finalUrl || extra, sub.html]);
    }
    let rec = extractBusiness(pages, { businessSite: true, location: this.location });
    if (!linked.length && (!(rec.phone || rec.email) || (this.location && !rec.address))) {
      // nothing linked and nothing found: try the two conventional contact paths of the same site (a missed page is a missed contact)
      const base = (normalizeUrl(url, false) as [string, string])[0];
      for (const path of ['/contact-us', '/contact']) {
        const cand = base + path;
        if (this.visited.has(cand) || this.limitReached()) continue;
        const sub = await this.fetch(cand, true);
        if (sub) pages.push([sub.finalUrl || cand, sub.html]);
      }
      if (pages.length > 1) rec = extractBusiness(pages, { businessSite: true, location: this.location });
    }
    await this.store(rec);
  }

  /**
   * A directory entry names a website. A reachable website is not proof that it belongs to the business, so the site is read and its own
   * name is compared with the listed name. MISMATCH or unreachable: the website is removed (and reported). WEAK: kept, the status is
   * lowered one level. MATCH: kept; phone / e-mail / address the listing lacked are taken from the site itself.
   */
  private async verifyWebsite(rec: ScrapedRecord): Promise<void> {
    const out = await this.fetch(rec.website, true);
    const check: Record<string, unknown> = { website: rec.website };
    const rejected = (reason: string) => {
      (rec.provenance._rejected ??= []).push({ field: 'website', value: rec.website, reason, source_url: rec.source_url });
      rec.website = '';
      this.stats.websites_rejected++;
    };
    if (!out) {
      check.result = 'UNREACHABLE';
      rejected('website could not be read');
      rec.provenance.website_check = check;
      return;
    }
    const site = extractBusiness([[out.finalUrl || rec.website, out.html]], { businessSite: true, location: this.location });
    // The evidence is the site's OWN name. The domain is not used: a directory chose that website, so a domain that resembles the name
    // proves nothing (it is circular). A site that names nobody cannot be checked: UNKNOWN, treated like WEAK.
    const [verdict, score] = nameMatch(rec.business_name, site.business_name ? [site.business_name] : [], '');
    Object.assign(check, { result: verdict, score, site_name: site.business_name });
    if (verdict === 'MISMATCH') {
      rejected(`the website calls itself '${site.business_name}', not '${rec.business_name}'`);
    } else {
      this.stats.websites_verified++;
      if (verdict === 'MATCH') {
        for (const fld of ['phone', 'email', 'address'] as const) {
          if (!rec.get(fld) && site.get(fld)) {
            rec[fld] = site.get(fld);
            rec.provenance[fld] = { ...(site.provenance[fld] ?? {}), method: 'VERIFIED_WEBSITE:' + (site.provenance[fld]?.method ?? '') };
          }
        }
        const agree = (['phone', 'email'] as const).filter((f) => rec.get(f) && rec.get(f) === site.get(f));
        if (agree.length) check.corroborated = agree;
      }
    }
    rec.provenance.website_check = check;
    rec.verification_status = computeStatus(rec);       // lowers one level itself when the check says WEAK / UNKNOWN
  }

  private sameSiteLinks(base: string, links: string[]): string[] {
    const n = normalizeUrl(base);
    const dom = n ? registrableDomain(n[1]) : '';
    const out: string[] = [];
    for (const link of links) {
      let joined = link;
      try {
        joined = new URL(link, base).href;
      } catch {
        /* normalizeUrl rejects it */
      }
      const m = normalizeUrl(joined);
      if (m && registrableDomain(m[1]) === dom && !out.includes(m[0])) out.push(m[0]);
    }
    return out;
  }

  private async itemList(url: string, html: string, firstLinks: string[]): Promise<void> {
    const dom = registrableDomain((normalizeUrl(url) as [string, string])[1]);
    let pageUrl = url, pageHtml = html, links = firstLinks;
    for (;;) {
      for (const link of links) {
        if (this.limitReached()) return;
        if (this.visited.has(link)) continue;
        const prof = await this.fetch(link);
        if (prof) {
          await this.store(extractBusiness([[prof.finalUrl || link, prof.html]], { businessSite: false, excludeDomains: new Set([dom]), location: this.location }), true);
        }
      }
      const nxt = Runner.relNext(pageUrl, pageHtml);
      if (!nxt || this.visited.has(nxt) || this.limitReached()) return;
      const nextPage = await this.fetch(nxt);
      if (!nextPage) return;
      pageUrl = nextPage.finalUrl || nxt;
      pageHtml = nextPage.html;
      links = this.sameSiteLinks(pageUrl, jsonldItemlistUrls(pageHtml));
      if (!links.length) return;
    }
  }

  private static relNext(base: string, html: string): string | null {
    const $ = cheerio.load(html);
    const hasNext = (_: number, el: any) => ($(el).attr('rel') ?? '').toLowerCase().split(/\s+/).includes('next');
    const el = $('link').filter(hasNext).first().length ? $('link').filter(hasNext).first() : $('a[href]').filter(hasNext).first();
    const href = el.attr('href');
    if (!el.length || !href) return null;
    let joined = href;
    try {
      joined = new URL(href, base).href;
    } catch {
      /* rejected below */
    }
    const n = normalizeUrl(joined);
    const b = normalizeUrl(base);
    return n && b && registrableDomain(n[1]) === registrableDomain(b[1]) ? n[0] : null;
  }

  private async directory(url: string, html: string, cfg: SourceConfig): Promise<void> {
    const dom = registrableDomain((normalizeUrl(url) as [string, string])[1]);
    let pageUrl = url, pageHtml = html, listingPages = 0;
    while (listingPages < cfg.max_pages) {
      listingPages++;
      const $ = cheerio.load(pageHtml);
      const hrefs = $(cfg.profile_link_selector).toArray().map((a) => $(a).attr('href')).filter((h): h is string => !!h);
      const links = this.sameSiteLinks(pageUrl, hrefs);
      if (!links.length && listingPages === 1) this.fail(pageUrl, 'NO_PROFILE_LINKS', `selector '${cfg.profile_link_selector}' matched no links; check the source file`);
      for (const link of links) {
        if (this.limitReached()) return;
        if (this.visited.has(link)) continue;
        const prof = await this.fetch(link);
        if (prof) {
          await this.store(
            extractBusiness([[prof.finalUrl || link, prof.html]], { selectors: cfg.selectors, businessSite: false, excludeDomains: new Set([dom]), location: this.location }),
            true,
          );
        }
      }
      if (!cfg.next_page_selector || this.limitReached()) return;
      const href = $(cfg.next_page_selector).first().attr('href');
      let nxt: string | null = null;
      if (href) {
        let joined = href;
        try {
          joined = new URL(href, pageUrl).href;
        } catch {
          /* rejected below */
        }
        const n = normalizeUrl(joined);
        nxt = n && registrableDomain(n[1]) === dom ? n[0] : null;
      }
      if (!nxt || this.visited.has(nxt)) return;
      const nextPage = await this.fetch(nxt);
      if (!nextPage) return;
      pageUrl = nextPage.finalUrl || nxt;
      pageHtml = nextPage.html;
    }
  }
}
