import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrapedRecord } from '../extract';
import { FetchError } from '../netsafety';
import { Runner, RunnerOptions } from '../runner';
import { SourceConfigError, loadSourceConfig } from '../sources';
import { CONTACT, HOME } from './extract.spec';
import { FakeWeb, makeFetcher } from './fake-web';

const run = async (web: FakeWeb, urls: string[], opts: RunnerOptions = {}) => {
  const r = new Runner(makeFetcher(web), opts);
  return { r, recs: await r.run(urls) };
};

const SITE = { 'https://acmeworks.in/': HOME, 'https://acmeworks.in/contact-us': CONTACT, 'https://acmeworks.in/about': '<html><body>About</body></html>' };

describe('business sites', () => {
  it('turns home and contact pages into one record', async () => {
    const web = new FakeWeb(SITE);
    const { r, recs } = await run(web, ['acmeworks.in']);
    expect(recs).toHaveLength(1);
    expect([recs[0].business_name, recs[0].phone, recs[0].email]).toEqual(['Acme Works Pvt Ltd', '+919812345670', 'hello@acmeworks.in']);
    const s = r.stats;
    expect([s.businesses_processed, s.records_new, s.duplicates, s.pages_fetched, s.pages_failed]).toEqual([1, 1, 0, 3, 0]);
    expect(web.pageCalls.some((c) => c.includes('blog'))).toBe(false);
  });

  it('treats the same business given twice as a duplicate and fills gaps only', async () => {
    const pages = {
      ...SITE,
      'https://www.acmeworks.in/': '<html><head><title>Acme Works</title></head><body><address>12 MIDC Road, Pune</address></body></html>',
    };
    const { r, recs } = await run(new FakeWeb(pages), ['https://acmeworks.in/', 'https://www.acmeworks.in/']);
    expect(recs).toHaveLength(1);
    expect([r.stats.duplicates, r.stats.records_new]).toEqual([1, 1]);
    expect([recs[0].business_name, recs[0].phone]).toEqual(['Acme Works Pvt Ltd', '+919812345670']);
  });

  it('counts records already in the output file as duplicates', async () => {
    const old = new ScrapedRecord({ business_name: 'Acme Works', website: 'https://acmeworks.in', phone: '+919812345670' });
    const { r, recs } = await run(new FakeWeb(SITE), ['https://acmeworks.in/'], { existing: [old] });
    expect(recs).toHaveLength(1);
    expect([r.stats.duplicates, r.stats.records_new]).toEqual([1, 0]);
    expect(recs[0].email).toBe('hello@acmeworks.in');
  });

  it('does not merge different businesses that share a phone number', async () => {
    const a = "<html><head><title>Alpha Foods</title></head><body><a href='tel:+912225678901'>c</a></body></html>";
    const b = "<html><head><title>Beta Garments</title></head><body><a href='tel:+912225678901'>c</a></body></html>";
    const { r, recs } = await run(new FakeWeb({ 'https://alpha.in/': a, 'https://beta.in/': b }), ['https://alpha.in/', 'https://beta.in/']);
    expect(recs).toHaveLength(2);
    expect(r.stats.duplicates).toBe(0);
  });

  it('does not stop the job when one source fails', async () => {
    const web = new FakeWeb({
      'https://down.in/': [500, '<html>err</html>'], 'https://slow.in/': new FetchError('timeout', 'slow'), 'https://acmeworks.in/': SITE['https://acmeworks.in/'],
    });
    const { r, recs } = await run(web, ['https://down.in/', 'not a url', 'https://slow.in/', 'https://acmeworks.in/']);
    expect(recs).toHaveLength(1);
    expect(r.stats.urls_invalid).toBe(1);
    expect(r.stats.pages_failed).toBeGreaterThanOrEqual(2);
    expect(r.stats.businesses_processed).toBe(1);
    const reasons = new Set(r.stats.failures.map((f) => f.reason));
    for (const x of ['INVALID_URL', 'HTTP_ERROR', 'TIMEOUT']) expect(reasons.has(x)).toBe(true);
  });

  it('contains an extraction crash', async () => {
    jest.resetModules();
    jest.doMock('../extract', () => ({ ...jest.requireActual('../extract'), extractBusiness: () => { throw new Error('boom'); } }));
    const { Runner: R } = await import('../runner');
    const { makeFetcher: mf, FakeWeb: FW } = await import('./fake-web');
    const r = new R(mf(new FW(SITE)));
    expect(await r.run(['https://acmeworks.in/'])).toEqual([]);
    expect(r.stats.failures.some((f) => f.reason === 'EXTRACTION_ERROR')).toBe(true);
    jest.dontMock('../extract');
  });

  it('counts robots-blocked sites and does not fetch them', async () => {
    const web = new FakeWeb({ 'https://closed.in/': '<html>x</html>' }, { 'closed.in': 'User-agent: *\nDisallow: /\n' });
    const { r, recs } = await run(web, ['https://closed.in/']);
    expect(recs).toEqual([]);
    expect(r.stats.robots_blocked).toBe(1);
    expect(web.pageCalls).toEqual([]);
  });

  it('keeps query strings out of failure reports', async () => {
    const { r } = await run(new FakeWeb({}), ['https://nothing.in/page?token=SECRET123&x=1']);
    const dump = JSON.stringify(r.stats.failures);
    expect(dump).not.toContain('SECRET123');
    expect(dump).toContain('nothing.in/page');
  });
});

// ---- listings: schema.org ItemList with rel=next pagination
const profile = (n: number) =>
  `<html><head><title>Biz ${n}</title><script type="application/ld+json">{"@type":"LocalBusiness","name":"Biz ${n}",` +
  `"telephone":"+91 98123 4567${n}","url":"https://biz${n}.in"}</script></head><body>profile ${n}</body></html>`;

const listing = (urls: string[], nxt?: string) => {
  const items = urls.map((u) => `{"@type":"ListItem","url":"${u}"}`).join(',');
  const head = nxt ? `<link rel="next" href="${nxt}">` : '';
  return `<html><head>${head}<script type="application/ld+json">{"@type":"ItemList","itemListElement":[${items}]}</script></head><body>list</body></html>`;
};

const listingWeb = () =>
  new FakeWeb({
    'https://platform.org/list': listing(['https://platform.org/p/1', 'https://platform.org/p/2', 'https://evil.example/p/9'], 'https://platform.org/list?page=2'),
    'https://platform.org/list?page=2': listing(['https://platform.org/p/3', 'https://platform.org/p/4'], 'https://platform.org/list?page=3'),
    'https://platform.org/list?page=3': listing(['https://platform.org/p/5'], 'https://platform.org/list?page=3'),
    ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`https://platform.org/p/${n}`, profile(n)])),
    'https://evil.example/p/9': profile(9),
  });

describe('listings', () => {
  it('follows rel=next, stays on the site and ends', async () => {
    const web = listingWeb();
    const { recs } = await run(web, ['https://platform.org/list'], { maxPages: 50 });
    expect(recs.map((x) => x.business_name).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `Biz ${n}`));
    expect(web.calls.some((c) => c.includes('evil.example'))).toBe(false);
    expect(recs.every((x) => x.source_url.startsWith('https://platform.org/p/'))).toBe(true);
    expect(web.pageCalls.length).toBe(new Set(web.pageCalls).size);
  });

  it('stops at the max pages limit', async () => {
    const { r, recs } = await run(listingWeb(), ['https://platform.org/list'], { maxPages: 4 });
    expect(r.stats.pages_requested).toBe(4);
    expect(r.stats.stopped_by_limit).toMatch(/^max pages/);
    expect(recs).toHaveLength(2);
  });

  it('stops at the max records limit', async () => {
    const { r, recs } = await run(listingWeb(), ['https://platform.org/list'], { maxPages: 50, maxRecords: 2 });
    expect(recs).toHaveLength(2);
    expect(r.stats.stopped_by_limit).toMatch(/^max records/);
  });
});

// ---- directory with a verified source file
function sourceFile(over: Record<string, unknown> = {}): string {
  const cfg = {
    name: 'Platform', hosts: ['platform.org'], terms_reviewed: true, terms_notes: 'reviewed in test', profile_link_selector: 'a.entry', next_page_selector: 'a.next',
    selectors: { business_name: 'h1.biz', phone: 'a.phone', email: 'a.mail', website: 'a.site', address: 'div.addr' }, max_pages: 5, ...over,
  };
  const p = join(mkdtempSync(join(tmpdir(), 'scraper-')), 'source.json');
  writeFileSync(p, JSON.stringify(cfg), 'utf8');
  return p;
}

const dirPage = (n: number, nxt?: string) =>
  `<html><body>${[1, 2].map((i) => `<a class="entry" href="/biz/${n}${i}">e</a>`).join('')}${nxt ? `<a class=next href=${nxt}>next</a>` : ''}</body></html>`;

const bizPage = (code: string) =>
  `<html><body><header><a href="tel:+911800123456">help</a></header><h1 class="biz">Shop ${code}</h1><div class="addr">${code} Main Road, Nagpur</div>` +
  `<a class="phone" href="tel:+91 98123 4567${code.slice(-1)}">c</a><a class="mail" href="mailto:shop${code}@shop${code}.in">m</a>` +
  `<a class="site" href="https://shop${code}.in">visit</a></body></html>`;

describe('configured directories', () => {
  it('crawls with pagination', async () => {
    const codes = ['11', '12', '21', '22'];
    const web = new FakeWeb({
      'https://platform.org/d': dirPage(1, '/d?p=2'), 'https://platform.org/d?p=2': dirPage(2),
      ...Object.fromEntries(codes.map((c) => [`https://platform.org/biz/${c}`, bizPage(c)])),
      ...Object.fromEntries(codes.map((c) => [`https://shop${c}.in`, `<html><head><title>Shop ${c}</title></head><body>site</body></html>`])),
    });
    const { r, recs } = await run(web, ['https://platform.org/d'], { sources: [loadSourceConfig(sourceFile())], maxPages: 30 });
    expect(recs.map((x) => x.business_name).sort()).toEqual(['Shop 11', 'Shop 12', 'Shop 21', 'Shop 22']);
    const one = recs.find((x) => x.business_name === 'Shop 11') as ScrapedRecord;
    expect([one.phone, one.email, one.website, one.address]).toEqual(['+919812345671', 'shop11@shop11.in', 'https://shop11.in', '11 Main Road, Nagpur']);
    expect(one.source_url).toBe('https://platform.org/biz/11');
    expect(r.stats.pages_fetched).toBe(10);
    expect(r.stats.websites_verified).toBe(4);
  });

  it('reports wrong selectors instead of guessing', async () => {
    const web = new FakeWeb({ 'https://platform.org/d': "<html><body><a href='/biz/1'>x</a></body></html>" });
    const { r, recs } = await run(web, ['https://platform.org/d'], { sources: [loadSourceConfig(sourceFile())] });
    expect(recs).toEqual([]);
    expect(r.stats.failures.some((f) => f.reason === 'NO_PROFILE_LINKS')).toBe(true);
  });

  it('applies the source page limit', async () => {
    const codes = ['11', '12', '21', '22', '31', '32'];
    const web = new FakeWeb({
      'https://platform.org/d': dirPage(1, '/d?p=2'), 'https://platform.org/d?p=2': dirPage(2, '/d?p=3'), 'https://platform.org/d?p=3': dirPage(3),
      ...Object.fromEntries(codes.map((c) => [`https://platform.org/biz/${c}`, bizPage(c)])),
    });
    const { recs } = await run(web, ['https://platform.org/d'], { sources: [loadSourceConfig(sourceFile({ max_pages: 2 }))], maxPages: 50 });
    expect(recs).toHaveLength(4);
  });
});

describe('source file validation', () => {
  it.each([
    [{ terms_reviewed: false }, 'terms_reviewed'], [{ terms_reviewed: 'yes' }, 'terms_reviewed'], [{ hosts: [] }, 'hosts'],
    [{ selectors: { phone: 'a', ssn: 'x' } }, 'selectors may only'], [{ profile_link_selector: 'a[[[' }, 'invalid CSS'], [{ max_pages: 0 }, 'max_pages'],
    [{ profile_link_selector: '' }, 'profile_link_selector'],
  ])('refuses %j', (over, msg) => {
    expect(() => loadSourceConfig(sourceFile(over))).toThrow(new RegExp(msg));
    expect(() => loadSourceConfig(sourceFile(over))).toThrow(SourceConfigError);
  });

  it('refuses a file without the terms flag, and a missing file', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scraper-')), 's.json');
    writeFileSync(p, JSON.stringify({ hosts: ['a.org'], profile_link_selector: 'a' }));
    expect(() => loadSourceConfig(p)).toThrow(/terms_reviewed/);
    expect(() => loadSourceConfig(join(tmpdir(), 'nope-does-not-exist.json'))).toThrow(SourceConfigError);
  });
});

describe('hostile markup', () => {
  it('does not crash a run', async () => {
    const deep = '<div>'.repeat(6000) + 'x' + '</div>'.repeat(6000);
    const hugeAttr = "<a href='/x' title='" + 'a'.repeat(500_000) + "'>y</a>";
    const web = new FakeWeb({
      'https://deep.in/': `<html><head><title>Deep Co</title></head><body>${deep}${hugeAttr}</body></html>`,
      'https://ok.in/': "<html><head><title>Ok Co</title></head><body><a href='tel:+919812345670'>c</a></body></html>",
    });
    const { r, recs } = await run(web, ['https://deep.in/', 'https://ok.in/']);
    expect(recs.some((x) => x.business_name === 'Ok Co')).toBe(true);
    expect(r.stats.businesses_processed + r.stats.failures.filter((f) => f.reason === 'EXTRACTION_ERROR').length).toBe(2);
  });
});
