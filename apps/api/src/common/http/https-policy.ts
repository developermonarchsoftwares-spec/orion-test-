import type { NextFunction, Request, Response } from 'express';

/**
 * HTTPS enforcement for production. TLS ends at the platform's proxy, which tells the app what the BROWSER used in X-Forwarded-Proto. A request
 * that the proxy marks as plain "http" is redirected to the same URL over https (308 keeps the method), or refused for methods that must not be
 * replayed by a redirect. HSTS (security-headers.ts) then keeps the browser on https afterwards.
 *
 * What this deliberately does not do:
 *  - act on a request with NO forwarded protocol (internal health probes, Docker health checks and local use have none and must keep working);
 *  - redirect to a host it was not configured for: the target is built only from hosts named in APP_URL, FRONTEND_URL, WEB_APP_URL or
 *    CORS_ORIGINS, so a forged Host header cannot turn this into an open redirect. An unknown host is refused instead of redirected.
 */
export type HttpsDecision = { action: 'next' } | { action: 'redirect'; location: string } | { action: 'refuse' };

const hostOf = (value: string): string | null => {
  try {
    const u = new URL(value.trim());
    return u.host.toLowerCase();
  } catch {
    return null;
  }
};

/** Hosts this deployment is known by, from configuration only. */
export function configuredHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  for (const name of ['APP_URL', 'FRONTEND_URL', 'WEB_APP_URL']) {
    const h = hostOf(env[name] ?? '');
    if (h) out.add(h);
  }
  for (const origin of (env.CORS_ORIGINS ?? '').split(',')) {
    const h = hostOf(origin);
    if (h) out.add(h);
  }
  return out;
}

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v ?? '').split(',')[0].trim().toLowerCase();

export function httpsDecision(req: Pick<Request, 'headers' | 'method' | 'originalUrl' | 'url'>, env: NodeJS.ProcessEnv = process.env): HttpsDecision {
  if ((env.NODE_ENV ?? '').trim() !== 'production') return { action: 'next' };
  if (first(req.headers['x-forwarded-proto']) !== 'http') return { action: 'next' }; // https, or no proxy information: nothing to enforce

  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host);
  if (!['GET', 'HEAD'].includes((req.method ?? '').toUpperCase()) || !host || !configuredHosts(env).has(host)) return { action: 'refuse' };
  return { action: 'redirect', location: `https://${host}${req.originalUrl || req.url || '/'}` };
}

export function httpsEnforcement(env: NodeJS.ProcessEnv = process.env) {
  return (req: Request, res: Response, next: NextFunction) => {
    const d = httpsDecision(req, env);
    if (d.action === 'next') return next();
    if (d.action === 'redirect') return res.redirect(308, d.location);
    return res.status(403).json({ success: false, statusCode: 403, errorCode: 'HTTPS_REQUIRED', message: 'This service is only available over HTTPS.' });
  };
}
