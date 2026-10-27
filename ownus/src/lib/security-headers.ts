/**
 * Browser security headers for the web app (Phase 14). Pure functions, so the policy can be tested without starting Next.js.
 * Used by next.config.ts; the API sets its own headers (apps/api/src/common/http/security-headers.ts) and the two never overlap: this file
 * covers pages and the gateway's /api routes served by Next.js, the API covers what NestJS answers.
 */

/** The origin of an absolute URL, or null. Used to allow the browser to call the configured API origin and nothing broader. */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

export interface IHeaderEnv {
  isProd: boolean;
  /** NEXT_PUBLIC_API_URL when it is an absolute URL (the browser then calls that origin directly). */
  apiUrl?: string | null;
}

/** Razorpay Standard Checkout: the script, the payment frame (served from api.razorpay.com) and its API and analytics calls. Exact origins only. */
export const RAZORPAY_ORIGINS = {
  script: ['https://checkout.razorpay.com'],
  frame: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
  connect: ['https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
} as const;

/** Cloudflare Turnstile (the sign-in / sign-up CAPTCHA): its script, and the challenge frame served from the same origin. */
export const TURNSTILE_ORIGINS = {
  script: ['https://challenges.cloudflare.com'],
  frame: ['https://challenges.cloudflare.com'],
} as const;

const common = (env: IHeaderEnv) => {
  const api = originOf(env.apiUrl);
  return {
    connect: ["'self'", ...(api && api !== 'null' ? [api] : []), ...(env.isProd ? [] : ['http://localhost:4000', 'http://127.0.0.1:4000']), ...RAZORPAY_ORIGINS.connect],
  };
};

/**
 * The enforced policy. Differences from the previous one: connect-src no longer allows every https origin (the browser only talks to this
 * site and, if configured, the API origin; Google and the mail provider are called by the server, never by the browser). Still open, and
 * recorded as such: 'unsafe-inline' for scripts and styles (Next.js hydration data and the theme script are inline), https images (business
 * logos come from many hosts) and the two sign-in frames.
 */
export function buildCsp(env: IHeaderEnv): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    ["script-src 'self' 'unsafe-inline'", ...RAZORPAY_ORIGINS.script, ...TURNSTILE_ORIGINS.script].join(' ') + (env.isProd ? '' : " 'unsafe-eval'"),
    `connect-src ${common(env).connect.join(' ')}`,
    ["frame-src 'self' https://accounts.google.com https://login.microsoftonline.com", ...RAZORPAY_ORIGINS.frame, ...TURNSTILE_ORIGINS.frame].join(' '),
  ].join('; ');
}

/**
 * The policy the application should move to: no inline script. Sent as REPORT-ONLY in production so it blocks nothing; a browser console
 * shows what would break. Enforcing it needs a per-request nonce (Next.js middleware) and dynamic rendering of every page, which is a change
 * to how pages are served and is NOT done here. Without a report endpoint the violations are visible in the browser console only.
 */
export function buildReportOnlyCsp(env: IHeaderEnv): string {
  return buildCsp(env).replace(/script-src [^;]*/, ["script-src 'self'", ...RAZORPAY_ORIGINS.script, ...TURNSTILE_ORIGINS.script].join(' ')).replace(/style-src [^;]*/, "style-src 'self' https://fonts.googleapis.com");
}

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

/** HSTS for one year. includeSubDomains and preload are deliberately absent: both are hard to undo and need every subdomain to be HTTPS-only. */
export const HSTS_VALUE = 'max-age=31536000';

export interface IHeader {
  key: string;
  value: string;
}

export function baseSecurityHeaders(env: IHeaderEnv): IHeader[] {
  return [
    { key: 'Content-Security-Policy', value: buildCsp(env) },
    ...(env.isProd ? [{ key: 'Content-Security-Policy-Report-Only', value: buildReportOnlyCsp(env) }] : []),
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    ...(env.isProd ? [{ key: 'Strict-Transport-Security', value: HSTS_VALUE }] : []),
  ];
}

/** Gateway responses carry accounts, wallets, exports and tokens: never stored by a browser cache, a CDN or a proxy. */
export const NO_STORE: IHeader[] = [
  { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' },
  { key: 'Pragma', value: 'no-cache' },
];

/** The signed-in page shells hold no customer data, but they must not be kept in a shared cache that could serve one session's state to another. */
export const PRIVATE_SHELL: IHeader[] = [{ key: 'Cache-Control', value: 'private, no-cache, must-revalidate' }];

/** Paths (Next.js route syntax) of signed-in or credential-bearing pages. /reset-password has its own stricter rule below, so it is not listed here (two matching rules would emit two Cache-Control values). */
export const PRIVATE_SHELL_PATHS = ['/admin/:path*', '/dashboard/:path*', '/discover/:path*', '/credits/:path*', '/leads/:path*', '/saved-searches/:path*', '/settings/:path*', '/auth/:path*', '/login', '/register', '/forgot-password'];

export function allHeaderRules(env: IHeaderEnv): { source: string; headers: IHeader[] }[] {
  return [
    { source: '/:path*', headers: baseSecurityHeaders(env) },
    { source: '/api/:path*', headers: NO_STORE },
    ...PRIVATE_SHELL_PATHS.map((source) => ({ source, headers: PRIVATE_SHELL })),
    // the reset page carries a credential in its URL: no Referer to anyone, never cached
    { source: '/reset-password', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }, ...NO_STORE] },
  ];
}
