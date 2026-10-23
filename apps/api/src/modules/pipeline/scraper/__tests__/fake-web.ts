/** Shared test helpers. No test here uses the network (a fake transport replaces the HTTP client) and none needs a database. */
import { PoliteFetcher } from '../fetcher';
import { FetchError, HttpResult } from '../netsafety';

export type Spec = string | [number, string] | [number, string, Record<string, string>] | FetchError | (() => Spec);

const key = (u: string): string => u.replace(/\/+$/, '') || u;

/** In-memory web: {url: html | [status, html] | [status, html, headers] | FetchError | function}. Unknown URLs are 404. */
export class FakeWeb {
  pages = new Map<string, Spec>();
  calls: string[] = [];

  constructor(pages: Record<string, Spec> = {}, public robots: Record<string, Spec> = {}) {
    for (const [url, spec] of Object.entries(pages)) this.pages.set(key(url), spec);
  }

  get = async (url: string): Promise<HttpResult> => {
    this.calls.push(url);
    const p = new URL(url);
    const result = (status: number, text: string, headers: Record<string, string>, ctype: string): HttpResult => ({
      url, status, text, headers, contentType: ctype, truncated: false, tlsVerified: true, redirects: [],
    });
    if (p.pathname === '/robots.txt') {
      const spec = this.robots[p.host];
      if (spec === undefined) return result(404, '', {}, 'text/plain');
      if (spec instanceof FetchError) throw spec;
      const [status, body] = Array.isArray(spec) ? spec : [200, spec as string];
      return result(status as number, body as string, {}, 'text/plain');
    }
    let spec: Spec = this.pages.get(key(url)) ?? [404, '<html><body>not found</body></html>'];
    if (typeof spec === 'function') spec = spec();
    if (spec instanceof FetchError) throw spec;
    if (typeof spec === 'string') spec = [200, spec];
    const [status, body, headers] = spec as [number, string, Record<string, string>?];
    return result(status, body, headers ?? {}, 'text/html');
  };

  get pageCalls(): string[] {
    return this.calls.filter((c) => !c.endsWith('/robots.txt'));
  }
}

export function makeFetcher(web: FakeWeb, opts: { delay?: number; clock?: () => number; maxAttempts?: number } = {}): PoliteFetcher & { sleeps: number[] } {
  const sleeps: number[] = [];
  const f = new PoliteFetcher({
    httpGet: web.get, delay: opts.delay ?? 0, sleep: async (s) => { sleeps.push(s); }, clock: opts.clock ?? (() => 0), maxAttempts: opts.maxAttempts,
  }) as PoliteFetcher & { sleeps: number[] };
  f.sleeps = sleeps;
  return f;
}
