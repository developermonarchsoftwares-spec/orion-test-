/**
 * Polite fetching: robots.txt, per-domain delay, retries with backoff, and a uniform result for every outcome.
 * Port of business_scraper/fetcher.py.
 *
 * Policy when access is unclear: stop. A robots.txt that cannot be read (5xx, timeout, connection error) closes the whole site for that
 * run; HTTP 401/403 are reported as access restrictions and never retried or worked around; CAPTCHA/challenge pages are recognised and
 * reported, never solved.
 */
import { FetchError, HttpResult, SafeClient, SafeClientOptions } from './netsafety';

export const BOT_NAME = 'BusinessScraperBot';
export const VERSION = '1.0';

const CHALLENGE_RE = /(captcha|cf-challenge|g-recaptcha|h-captcha|just a moment\.\.\.|attention required|verify you are (a )?human|access denied|unusual traffic)/i;

export interface FetchOutcome {
  url: string;
  ok: boolean;
  status: number | null;
  finalUrl: string | null;
  html: string;
  attempts: number;
  /** OK | ROBOTS_DISALLOWED | ROBOTS_UNREACHABLE | ACCESS_DENIED | RATE_LIMITED | CHALLENGE | HTTP_ERROR | TIMEOUT | CONNECTION | TLS | UNSAFE | CONTENT_TYPE | EMPTY */
  reason: string | null;
  message: string;
  truncated: boolean;
  tlsVerified: boolean | null;
}

const newOutcome = (url: string): FetchOutcome => ({
  url, ok: false, status: null, finalUrl: null, html: '', attempts: 0, reason: null, message: '', truncated: false, tlsVerified: null,
});

export const userAgent = (contact?: string | null): string => `${BOT_NAME}/${VERSION}` + (contact ? ` (+${contact})` : '');

interface RobotRule { allow: boolean; pattern: string }
interface RobotEntry { agents: string[]; rules: RobotRule[]; delay: number | null }

/** robots.txt rules for one origin: first matching rule within the best-matching group decides (like Python's urllib.robotparser). */
export class RobotRules {
  private entries: RobotEntry[] = [];
  private fallback: RobotEntry | null = null;

  constructor(body: string) {
    let cur: RobotEntry | null = null;
    let lastWasAgent = false;
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim();
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === 'user-agent') {
        if (!lastWasAgent || !cur) {
          cur = { agents: [], rules: [], delay: null };
          this.entries.push(cur);
        }
        cur.agents.push(value.toLowerCase());
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (!cur) continue;
      if (key === 'disallow') cur.rules.push({ allow: value === '', pattern: value });
      else if (key === 'allow') cur.rules.push({ allow: true, pattern: value });
      else if (key === 'crawl-delay' && /^\d+(\.\d+)?$/.test(value)) cur.delay = parseFloat(value);
    }
    this.fallback = this.entries.find((e) => e.agents.includes('*')) ?? null;
  }

  private entryFor(token: string): RobotEntry | null {
    const t = token.toLowerCase();
    return this.entries.find((e) => e.agents.some((a) => a !== '*' && t.includes(a))) ?? this.fallback;
  }

  private static matches(pattern: string, path: string): boolean {
    if (pattern === '') return true;
    const anchored = pattern.endsWith('$');
    const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
  }

  canFetch(token: string, url: string): boolean {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    if (u.pathname === '/robots.txt') return true;
    const entry = this.entryFor(token);
    if (!entry) return true;
    for (const rule of entry.rules) {
      if (rule.pattern === '' && !rule.allow) continue;
      if (RobotRules.matches(rule.pattern, path)) return rule.allow;
    }
    return true;
  }

  crawlDelay(token: string): number | null {
    return this.entryFor(token)?.delay ?? null;
  }
}

type RobotsState = 'ALLOWED' | 'NO_ROBOTS' | 'UNREACHABLE' | 'UNSAFE';

/** robots.txt per origin, cached for the run (RFC 9309): 4xx = no restrictions; 5xx / unreachable = disallow the origin; an HTML body instead of rules = no robots.txt. */
export class RobotsPolicy {
  private cache = new Map<string, [RobotRules | null, RobotsState]>();

  constructor(private readonly get: (url: string) => Promise<HttpResult>, readonly token: string = BOT_NAME) {}

  private async load(origin: string): Promise<[RobotRules | null, RobotsState]> {
    const cached = this.cache.get(origin);
    if (cached) return cached;
    let parser: RobotRules | null = null;
    let state: RobotsState = 'NO_ROBOTS';
    try {
      const r = await this.get(origin + '/robots.txt');
      const body = r.text || '';
      if (r.status === 200 && !r.contentType.includes('html') && !/<\s*(html|body|head)\b/i.test(body.slice(0, 500))) {
        parser = new RobotRules(body);
        state = 'ALLOWED';
      } else if (r.status >= 500 || r.status === 429) state = 'UNREACHABLE';
    } catch (err) {
      state = err instanceof FetchError && err.kind === 'unsafe' ? 'UNSAFE' : 'UNREACHABLE';
    }
    const entry: [RobotRules | null, RobotsState] = [parser, state];
    this.cache.set(origin, entry);
    return entry;
  }

  /** [allowed, state, crawlDelaySeconds] */
  async check(url: string): Promise<[boolean, string, number | null]> {
    const u = new URL(url);
    const [parser, state] = await this.load(u.origin);
    if (state === 'UNREACHABLE' || state === 'UNSAFE') return [false, state, null];
    if (!parser) return [true, 'NO_ROBOTS', null];
    const allowed = parser.canFetch(this.token, url);
    return [allowed, allowed ? 'ALLOWED' : 'DISALLOWED', parser.crawlDelay(this.token) || null];
  }
}

export interface PoliteFetcherOptions extends SafeClientOptions {
  client?: SafeClient;
  /** Seconds between two requests to the same host. */
  delay?: number;
  maxAttempts?: number;
  sleep?: (seconds: number) => Promise<void>;
  clock?: () => number;
  httpGet?: (url: string) => Promise<HttpResult>;
  contact?: string | null;
}

const TRANSIENT = new Set([500, 502, 503, 504]);

export class PoliteFetcher {
  private readonly delay: number;
  private readonly maxAttempts: number;
  private readonly sleep: (seconds: number) => Promise<void>;
  private readonly clock: () => number;
  private readonly doGet: (url: string) => Promise<HttpResult>;
  readonly robots: RobotsPolicy;
  private nextOk = new Map<string, number>();
  /** Hosts that answered 429 with a long Retry-After. */
  private blockedHosts = new Map<string, string>();

  constructor(opts: PoliteFetcherOptions = {}) {
    const client = opts.client ?? new SafeClient(userAgent(opts.contact), opts);
    const rawGet = opts.httpGet ?? ((u: string) => client.get(u));      // robots.txt itself (no hop vetting: that would recurse)
    this.doGet = opts.httpGet ?? ((u: string) => client.get(u, (hop) => this.vetHop(hop)));
    this.delay = opts.delay ?? 1.5;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.sleep = opts.sleep ?? ((s) => new Promise((r) => setTimeout(r, s * 1000)));
    this.clock = opts.clock ?? (() => performance.now() / 1000);
    this.robots = new RobotsPolicy(rawGet);
  }

  /** A redirect leads to another URL, possibly another host: its robots.txt and rate limit apply as well. */
  private async vetHop(url: string): Promise<void> {
    const [allowed, state, crawlDelay] = await this.robots.check(url);
    if (!allowed) throw new FetchError('robots', state === 'DISALLOWED' ? 'ROBOTS_DISALLOWED' : 'ROBOTS_UNREACHABLE');
    await this.wait(new URL(url).hostname.toLowerCase(), Math.min(Math.max(this.delay, crawlDelay ?? 0), 30));
  }

  private async wait(host: string, delay: number): Promise<void> {
    const now = this.clock();
    const ready = this.nextOk.get(host) ?? 0;
    if (ready > now) await this.sleep(ready - now);
    this.nextOk.set(host, this.clock() + delay);
  }

  async fetch(url: string): Promise<FetchOutcome> {
    const out = newOutcome(url);
    const host = new URL(url).hostname.toLowerCase();
    let allowed: boolean, state: string, crawlDelay: number | null;
    try {
      [allowed, state, crawlDelay] = await this.robots.check(url);
    } catch (err) {
      out.reason = 'UNSAFE';
      out.message = (err as Error).message;
      return out;
    }
    if (!allowed) {
      out.reason = state === 'DISALLOWED' ? 'ROBOTS_DISALLOWED' : state === 'UNSAFE' ? 'UNSAFE' : 'ROBOTS_UNREACHABLE';
      out.message = state === 'DISALLOWED' ? 'robots.txt does not allow this page'
        : state !== 'UNSAFE' ? 'robots.txt could not be read, so access policy is unclear; skipped' : 'unsafe destination';
      return out;
    }
    const blocked = this.blockedHosts.get(host);
    if (blocked) {
      out.reason = 'RATE_LIMITED';
      out.message = blocked;
      return out;
    }
    const delay = Math.min(Math.max(this.delay, crawlDelay ?? 0), 30);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      out.attempts = attempt;
      await this.wait(host, delay);
      let r: HttpResult;
      try {
        r = await this.doGet(url);
      } catch (err) {
        if (!(err instanceof FetchError)) throw err;
        out.reason = err.kind.toUpperCase();
        out.message = err.message;
        if (err.kind === 'robots') {
          out.reason = err.message;
          out.message = 'a redirect led to a page that robots.txt does not allow (or could not be checked)';
        }
        if ((err.kind === 'timeout' || err.kind === 'connection') && attempt < this.maxAttempts) {
          await this.backoff(attempt, null);
          continue;
        }
        return out;
      }
      out.status = r.status;
      out.finalUrl = r.url;
      out.truncated = r.truncated;
      out.tlsVerified = r.tlsVerified;
      const retryAfter = r.headers['retry-after'] ?? null;
      if (r.status === 429 || TRANSIENT.has(r.status)) {
        const wait = PoliteFetcher.retryWait(retryAfter);
        if (r.status === 429 && wait !== null && wait > 30) {
          const msg = `server asked to wait ${wait}s (HTTP 429); host skipped for this run`;
          this.blockedHosts.set(host, msg);
          out.reason = 'RATE_LIMITED';
          out.message = msg;
          return out;
        }
        if (attempt < this.maxAttempts) {
          await this.backoff(attempt, retryAfter);
          continue;
        }
        out.reason = r.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR';
        out.message = `HTTP ${r.status} after ${attempt} attempts`;
        return out;
      }
      if (r.status === 401 || r.status === 403) {
        out.reason = 'ACCESS_DENIED';
        out.message = `HTTP ${r.status}: access is restricted; not retried and not worked around`;
        return out;
      }
      if (r.status >= 400) {
        out.reason = 'HTTP_ERROR';
        out.message = `HTTP ${r.status}`;
        return out;
      }
      if (!r.text.trim()) {
        out.reason = 'EMPTY';
        out.message = 'empty response';
        return out;
      }
      if (CHALLENGE_RE.test(r.text.slice(0, 6000)) && r.text.length < 20000 && !/<(address|a)\b[^>]*(mailto|tel):/i.test(r.text)) {
        out.reason = 'CHALLENGE';
        out.message = 'bot-check / challenge page detected; not bypassed';
        return out;
      }
      out.ok = true;
      out.html = r.text;
      out.reason = 'OK';
      out.message = '';
      return out;
    }
    return out;
  }

  private static retryWait(retryAfter: string | null): number | null {
    return retryAfter && /^\d{1,6}$/.test(retryAfter.trim()) ? parseFloat(retryAfter) : null;
  }

  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const w = PoliteFetcher.retryWait(retryAfter);
    const wait = w !== null ? Math.min(w, 30) : Math.min(0.5 * 2 ** (attempt - 1), 8);
    await this.sleep(wait + Math.random() * 0.25);
  }
}
