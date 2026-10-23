/**
 * SSRF-safe HTTP client for the scraper. Port of business_scraper/netsafety.py.
 *
 * Layers: (1) URL validation before any request (http/https, no credentials, no internal names, port allow-list); (2) every address the
 * name resolves to must be public; (3) the connection uses the address we validated (no second lookup, so DNS rebinding cannot swap in a
 * private one); (4) every redirect hop goes through 1-3 again, at most MAX_REDIRECTS; (5) environment proxies are never used; (6) response
 * limits: content-type allow-list, byte cap, overall time budget; (7) TLS certificates are verified unless allowInvalidTls is set.
 */
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { isBlockedAddress } from '../../integrations/net/safe-http';

export class UnsafeUrlError extends Error {}

/** `kind` is one of timeout | connection | tls | unsafe | content_type | robots | invalid. */
export class FetchError extends Error {
  constructor(public readonly kind: string, message: string) {
    super(message);
  }
}

export const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
export const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
export const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'text/xml', 'application/xml', 'application/ld+json'];
export const MAX_REDIRECTS = 5;
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.localdomain'];
const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

export interface HttpResult {
  url: string;
  status: number;
  text: string;
  headers: Record<string, string>;
  contentType: string;
  truncated: boolean;
  tlsVerified: boolean;
  redirects: string[];
}

export type Resolver = (host: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

/** Resolves the host, checks every address, returns [url, host, port] or throws UnsafeUrlError. */
export async function validateUrl(url: string, resolve: Resolver = defaultResolver): Promise<[string, string, number]> {
  if (!url || typeof url !== 'string' || url.length > 2048) throw new UnsafeUrlError('empty or oversized URL');
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch (err) {
    throw new UnsafeUrlError(`malformed URL: ${(err as Error).message}`);
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) throw new UnsafeUrlError(`scheme '${u.protocol.replace(':', '')}' is not allowed (http and https only)`);
  if (u.username || u.password) throw new UnsafeUrlError('URLs with embedded credentials are not allowed');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/^\.+|\.+$/g, '');
  if (!host) throw new UnsafeUrlError('URL has no host');
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new UnsafeUrlError(`internal host name '${host}' is blocked`);
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) throw new UnsafeUrlError(`port ${port} is not allowed`);
  let addrs: string[];
  if (net.isIP(host)) addrs = [host];
  else {
    try {
      addrs = await resolve(host);
    } catch {
      throw new UnsafeUrlError(`DNS resolution failed for '${host}'`);
    }
  }
  if (!addrs.length) throw new UnsafeUrlError(`'${host}' did not resolve`);
  if (addrs.some(isBlockedAddress)) throw new UnsafeUrlError(`'${host}' resolves to a non-public address`);
  return [url.trim(), host, port];
}

/** Decodes a page without corrupting non-ASCII names: header charset, BOM, strict UTF-8, meta charset, then Windows-1252. */
export function decodeBody(body: Buffer, contentType: string): string {
  const candidates: string[] = [];
  const m = /charset=([\w-]+)/i.exec(contentType);
  if (m) candidates.push(m[1]);
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) candidates.push('utf-8');
  candidates.push('utf-8');
  const sniff = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1'));
  if (sniff) candidates.push(sniff[1]);
  for (const enc of candidates) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(body).replace(/^﻿/, '');
    } catch {
      continue;
    }
  }
  return new TextDecoder('windows-1252').decode(body);
}

const TLS_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|ERR_TLS/i;

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

export interface SafeClientOptions {
  timeoutMs?: number;
  maxBytes?: number;
  totalTimeoutMs?: number;
  allowInvalidTls?: boolean;
  resolve?: Resolver;
}

export class SafeClient {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly totalTimeoutMs: number;
  private readonly allowInvalidTls: boolean;
  private readonly resolve: Resolver;

  constructor(public readonly userAgent: string, opts: SafeClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    this.totalTimeoutMs = opts.totalTimeoutMs ?? 30_000;
    this.allowInvalidTls = opts.allowInvalidTls ?? false;
    this.resolve = opts.resolve ?? defaultResolver;
  }

  /** GET with redirects followed manually. `vet(url)` runs before every redirect hop and may throw FetchError to stop. */
  async get(url: string, vet?: (url: string) => Promise<void> | void): Promise<HttpResult> {
    const deadline = Date.now() + this.totalTimeoutMs;
    let current = url;
    const redirects: string[] = [];
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let safeUrl: string;
      try {
        [safeUrl] = await validateUrl(current, this.resolve);
      } catch (err) {
        throw new FetchError('unsafe', (err as Error).message);
      }
      if (vet && hop > 0) await vet(safeUrl);
      const { raw, tlsOk } = await this.request(safeUrl, deadline);
      const location = raw.headers['location'];
      if ([301, 302, 303, 307, 308].includes(raw.status) && location) {
        redirects.push(safeUrl);
        current = new URL(location, safeUrl).href;
        continue;
      }
      const ctype = (raw.headers['content-type'] ?? '').toLowerCase();
      if (ctype && !ALLOWED_CONTENT_TYPES.some((t) => ctype.includes(t))) throw new FetchError('content_type', `unsupported content type '${ctype.split(';')[0]}'`);
      return {
        url: safeUrl, status: raw.status, text: decodeBody(raw.body, raw.headers['content-type'] ?? ''), headers: raw.headers, contentType: ctype,
        truncated: raw.truncated, tlsVerified: tlsOk, redirects,
      };
    }
    throw new FetchError('unsafe', `more than ${MAX_REDIRECTS} redirects`);
  }

  private async request(url: string, deadline: number): Promise<{ raw: RawResponse; tlsOk: boolean }> {
    try {
      return { raw: await this.once(url, deadline, true), tlsOk: true };
    } catch (err) {
      if (err instanceof FetchError && err.kind === 'tls' && this.allowInvalidTls) return { raw: await this.once(url, deadline, false), tlsOk: false };
      throw err;
    }
  }

  private once(url: string, deadline: number, verify: boolean): Promise<RawResponse> {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const resolve = this.resolve;
    // The address that is connected to is the one that was checked here (closes DNS rebinding between validation and connection).
    const guardedLookup = (hostname: string, options: any, cb: any): void => {
      const done = (err: Error | null, address?: string, family?: number) => (options?.all ? cb(err, address ? [{ address, family }] : []) : cb(err, address, family));
      const literal = hostname.replace(/^\[|\]$/g, '');
      const check = (addrs: string[]) => {
        if (!addrs.length || addrs.some(isBlockedAddress)) return done(new UnsafeUrlError('connection to a non-public address blocked'));
        return done(null, addrs[0], net.isIPv6(addrs[0]) ? 6 : 4);
      };
      if (net.isIP(literal)) return check([literal]);
      resolve(literal).then(check, () => done(new UnsafeUrlError('DNS resolution failed')));
    };
    return new Promise<RawResponse>((resolvePromise, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new FetchError('timeout', 'response exceeded the total time budget'));
      const req = lib.request(
        {
          protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: `${u.pathname}${u.search}`, method: 'GET',
          headers: { 'User-Agent': this.userAgent, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en;q=0.9', 'Accept-Encoding': 'identity' },
          lookup: guardedLookup as any, agent: false, rejectUnauthorized: verify,
        } as https.RequestOptions,
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
          const finish = () => resolvePromise({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated });
          res.on('data', (chunk: Buffer) => {
            if (Date.now() > deadline) { req.destroy(new FetchError('timeout', 'response exceeded the total time budget')); return; }
            size += chunk.length;
            if (size > this.maxBytes) {
              chunks.push(chunk.subarray(0, chunk.length - (size - this.maxBytes)));
              truncated = true;
              res.destroy();
              finish();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', finish);
          res.on('error', (e) => (truncated ? undefined : reject(this.mapError(e))));
        },
      );
      req.setTimeout(Math.min(this.timeoutMs, remaining), () => req.destroy(new FetchError('timeout', `timed out after ${this.timeoutMs / 1000}s`)));
      req.on('error', (e) => reject(this.mapError(e)));
      req.end();
    });
  }

  private mapError(err: unknown): FetchError {
    if (err instanceof FetchError) return err;
    const e = err as NodeJS.ErrnoException;
    if (err instanceof UnsafeUrlError || e?.cause instanceof UnsafeUrlError) return new FetchError('unsafe', (e.cause as Error | undefined)?.message ?? e.message);
    if (TLS_ERRORS.test(e?.code ?? '') || TLS_ERRORS.test(e?.message ?? '')) return new FetchError('tls', 'TLS certificate could not be verified');
    if (e?.code === 'ETIMEDOUT' || e?.code === 'ESOCKETTIMEDOUT') return new FetchError('timeout', `timed out after ${this.timeoutMs / 1000}s`);
    return new FetchError('connection', e?.code ?? e?.name ?? 'Error');
  }
}
