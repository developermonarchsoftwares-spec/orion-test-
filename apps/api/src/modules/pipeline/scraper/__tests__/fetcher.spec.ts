import { PoliteFetcher } from '../fetcher';
import { FetchError, HttpResult } from '../netsafety';
import { FakeWeb, makeFetcher } from './fake-web';

const URL_ = 'https://acme.in/';

describe('PoliteFetcher', () => {
  it('fetches a normal page', async () => {
    const out = await makeFetcher(new FakeWeb({ [URL_]: '<html><body>hi</body></html>' })).fetch(URL_);
    expect([out.ok, out.reason, out.attempts, out.status]).toEqual([true, 'OK', 1, 200]);
  });

  it('obeys robots disallow and never requests the page', async () => {
    const web = new FakeWeb({ 'https://acme.in/private/x': '<html>secret</html>' }, { 'acme.in': 'User-agent: *\nDisallow: /private/\n' });
    const out = await makeFetcher(web).fetch('https://acme.in/private/x');
    expect([out.reason, out.ok]).toEqual(['ROBOTS_DISALLOWED', false]);
    expect(web.pageCalls).toEqual([]);
  });

  it('applies rules for its own token', async () => {
    const web = new FakeWeb({ [URL_]: '<html>x</html>' }, { 'acme.in': 'User-agent: BusinessScraperBot\nDisallow: /\n' });
    expect((await makeFetcher(web).fetch(URL_)).reason).toBe('ROBOTS_DISALLOWED');
  });

  it('allows when robots is missing but stops when it is unreadable', async () => {
    expect((await makeFetcher(new FakeWeb({ [URL_]: '<html>x</html>' })).fetch(URL_)).ok).toBe(true);
    let web = new FakeWeb({ [URL_]: '<html>x</html>' }, { 'acme.in': [503, ''] });
    expect((await makeFetcher(web).fetch(URL_)).reason).toBe('ROBOTS_UNREACHABLE');
    expect(web.pageCalls).toEqual([]);
    web = new FakeWeb({ [URL_]: '<html>x</html>' }, { 'acme.in': new FetchError('timeout', 'slow') });
    expect((await makeFetcher(web).fetch(URL_)).reason).toBe('ROBOTS_UNREACHABLE');
  });

  it('does not treat HTML returned instead of robots.txt as rules', async () => {
    const web = new FakeWeb({ [URL_]: '<html>x</html>' }, { 'acme.in': '<html><body>Welcome</body></html>' });
    expect((await makeFetcher(web).fetch(URL_)).ok).toBe(true);
  });

  it('honours crawl-delay', async () => {
    const web = new FakeWeb({ [URL_]: '<html>a</html>', 'https://acme.in/b': '<html>b</html>' }, { 'acme.in': 'User-agent: *\nCrawl-delay: 7\n' });
    const f = makeFetcher(web);
    await f.fetch(URL_);
    await f.fetch('https://acme.in/b');
    expect(f.sleeps.some((s) => Math.abs(s - 7) < 0.01)).toBe(true);
  });

  it('delays the same host but not other hosts', async () => {
    const web = new FakeWeb({ 'https://a.in/': '<html>a</html>', 'https://a.in/x': '<html>x</html>', 'https://b.in/': '<html>b</html>' });
    const f = makeFetcher(web, { delay: 2 });
    await f.fetch('https://a.in/');
    await f.fetch('https://b.in/');
    expect(f.sleeps).toEqual([]);
    await f.fetch('https://a.in/x');
    expect(Math.abs(f.sleeps[f.sleeps.length - 1] - 2)).toBeLessThan(0.01);
  });

  it('retries timeouts then succeeds', async () => {
    let n = 0;
    const f = makeFetcher(new FakeWeb({ [URL_]: () => { n++; if (n < 3) throw new FetchError('timeout', 'slow'); return '<html>ok</html>'; } }));
    const out = await f.fetch(URL_);
    expect([out.ok, out.attempts]).toEqual([true, 3]);
    expect(f.sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it('bounds retries', async () => {
    const out = await makeFetcher(new FakeWeb({ [URL_]: new FetchError('connection', 'refused') }), { maxAttempts: 3 }).fetch(URL_);
    expect([out.ok, out.reason, out.attempts]).toEqual([false, 'CONNECTION', 3]);
  });

  it('retries server errors but not client errors', async () => {
    const seq: [number, string][] = [[503, 'x'], [503, 'x'], [200, '<html>fine</html>']];
    expect((await makeFetcher(new FakeWeb({ [URL_]: () => seq.shift() as [number, string] })).fetch(URL_)).attempts).toBe(3);
    const out = await makeFetcher(new FakeWeb({ [URL_]: [404, '<html>nope</html>'] })).fetch(URL_);
    expect([out.reason, out.attempts]).toEqual(['HTTP_ERROR', 1]);
  });

  it('reports 403 as access denied, never retried', async () => {
    const web = new FakeWeb({ [URL_]: [403, '<html>forbidden</html>'] });
    const out = await makeFetcher(web).fetch(URL_);
    expect([out.reason, out.attempts, web.pageCalls.length]).toEqual(['ACCESS_DENIED', 1, 1]);
  });

  it('respects Retry-After on 429 and gives up cleanly', async () => {
    const f = makeFetcher(new FakeWeb({ [URL_]: [429, 'slow down', { 'retry-after': '2' }] }), { maxAttempts: 2 });
    const out = await f.fetch(URL_);
    expect([out.reason, out.attempts]).toEqual(['RATE_LIMITED', 2]);
    expect(f.sleeps.some((s) => s >= 2 && s < 2.5)).toBe(true);
  });

  it('stops the whole host for the run after a long Retry-After', async () => {
    const web = new FakeWeb({ 'https://acme.in/a': [429, 'x', { 'retry-after': '3600' }], 'https://acme.in/b': '<html>b</html>' });
    const f = makeFetcher(web);
    expect((await f.fetch('https://acme.in/a')).reason).toBe('RATE_LIMITED');
    expect((await f.fetch('https://acme.in/b')).reason).toBe('RATE_LIMITED');
    expect(web.pageCalls).toEqual(['https://acme.in/a']);
  });

  it('reports challenge pages and does not solve them', async () => {
    const web = new FakeWeb({ [URL_]: "<html><title>Just a moment...</title><body>Verify you are human <div class='g-recaptcha'></div></body></html>" });
    expect((await makeFetcher(web).fetch(URL_)).reason).toBe('CHALLENGE');
  });

  it('still reads a page that mentions captcha but has contact links', async () => {
    const web = new FakeWeb({ [URL_]: "<html><body><p>Protected by captcha</p><a href='mailto:hi@acme.in'>mail</a></body></html>" });
    expect((await makeFetcher(web).fetch(URL_)).ok).toBe(true);
  });

  it('gives reasons for empty, unsafe and TLS failures', async () => {
    expect((await makeFetcher(new FakeWeb({ [URL_]: [200, '   '] })).fetch(URL_)).reason).toBe('EMPTY');
    let out = await makeFetcher(new FakeWeb({ [URL_]: new FetchError('unsafe', 'blocked') })).fetch(URL_);
    expect([out.reason, out.attempts]).toEqual(['UNSAFE', 1]);
    out = await makeFetcher(new FakeWeb({ [URL_]: new FetchError('tls', 'bad cert') })).fetch(URL_);
    expect([out.reason, out.attempts]).toEqual(['TLS', 1]);
  });

  it('checks a redirect target against that host\'s robots.txt', async () => {
    const seen: string[] = [];
    const client = {
      userAgent: 'T/1',
      get: async (url: string, vet?: (u: string) => Promise<void>): Promise<HttpResult> => {
        seen.push(url);
        const res = (u: string, status: number, text: string, ct = 'text/html'): HttpResult => ({ url: u, status, text, headers: {}, contentType: ct, truncated: false, tlsVerified: true, redirects: [] });
        if (url.endsWith('/robots.txt')) return res(url, url.includes('other.in') ? 200 : 404, url.includes('other.in') ? 'User-agent: *\nDisallow: /\n' : '', 'text/plain');
        if (url === 'https://acme.in/go') {
          await vet?.('https://other.in/landing');
          return res('https://other.in/landing', 200, '<html>other</html>');
        }
        return res(url, 404, '');
      },
    };
    const f = new PoliteFetcher({ client: client as never, delay: 0, sleep: async () => undefined });
    const out = await f.fetch('https://acme.in/go');
    expect([out.ok, out.reason]).toEqual([false, 'ROBOTS_DISALLOWED']);
    expect(seen).not.toContain('https://other.in/landing');
  });
});
