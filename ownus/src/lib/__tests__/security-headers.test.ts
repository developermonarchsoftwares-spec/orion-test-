import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HSTS_VALUE, allHeaderRules, baseSecurityHeaders, buildCsp, buildReportOnlyCsp, originOf } from '../security-headers.ts';
import { isLocalRequestHost } from '../cookie-security.ts';

const header = (headers: { key: string; value: string }[], key: string) => headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
const directive = (csp: string, name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

describe('Phase 14: web security headers', () => {
  it('connect-src allows this site and the configured API origin only, not every https origin', () => {
    const csp = buildCsp({ isProd: true, apiUrl: 'https://api.orion-test.example/api/v1' });
    assert.equal(directive(csp, 'connect-src'), "connect-src 'self' https://api.orion-test.example https://api.razorpay.com https://lumberjack.razorpay.com");
    assert.doesNotMatch(directive(csp, 'connect-src'), /(^|\s)https:(\s|$)|\*/);
    assert.equal(directive(buildCsp({ isProd: true }), 'connect-src'), "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com");
  });

  it('Razorpay checkout is allowed by exact origin in script, frame and connect, and nothing else was opened up', () => {
    const csp = buildCsp({ isProd: true });
    assert.equal(directive(csp, 'script-src'), "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://challenges.cloudflare.com");
    assert.equal(directive(csp, 'frame-src'), "frame-src 'self' https://accounts.google.com https://login.microsoftonline.com https://api.razorpay.com https://checkout.razorpay.com https://challenges.cloudflare.com");
    assert.doesNotMatch(csp, /\*\.razorpay/); // exact hosts, never a wildcard
    assert.doesNotMatch(directive(csp, 'script-src') + directive(csp, 'frame-src') + directive(csp, 'connect-src'), /(^|\s)https:(\s|$)/);
    assert.equal(directive(csp, 'default-src'), "default-src 'self'");
    assert.equal(directive(csp, 'form-action'), "form-action 'self'");
  });

  it('production does not allow eval or the local API addresses; development does, because the dev server needs them', () => {
    const prod = buildCsp({ isProd: true });
    assert.doesNotMatch(prod, /unsafe-eval|localhost|127\.0\.0\.1/);
    const dev = buildCsp({ isProd: false });
    assert.match(dev, /unsafe-eval/);
    assert.match(dev, /localhost:4000/);
  });

  it('the framing, plugin and base-uri protections are present', () => {
    const csp = buildCsp({ isProd: true });
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "default-src 'self'"]) assert.ok(csp.includes(d), d);
  });

  it('the report-only policy has no inline script or style and blocks nothing by itself', () => {
    const ro = buildReportOnlyCsp({ isProd: true });
    assert.equal(directive(ro, 'script-src'), "script-src 'self' https://checkout.razorpay.com https://challenges.cloudflare.com");
    assert.doesNotMatch(directive(ro, 'style-src'), /unsafe-inline/);
    const prod = baseSecurityHeaders({ isProd: true });
    assert.ok(header(prod, 'Content-Security-Policy-Report-Only'));
    assert.equal(header(baseSecurityHeaders({ isProd: false }), 'Content-Security-Policy-Report-Only'), undefined);
  });

  it('HSTS is production only, one year, without includeSubDomains or preload', () => {
    assert.equal(header(baseSecurityHeaders({ isProd: true }), 'Strict-Transport-Security'), HSTS_VALUE);
    assert.equal(HSTS_VALUE, 'max-age=31536000');
    assert.doesNotMatch(HSTS_VALUE, /includeSubDomains|preload/i);
    assert.equal(header(baseSecurityHeaders({ isProd: false }), 'Strict-Transport-Security'), undefined);
  });

  it('every page gets nosniff, frame denial, a referrer policy and a restrictive Permissions-Policy', () => {
    const h = baseSecurityHeaders({ isProd: true });
    assert.equal(header(h, 'X-Content-Type-Options'), 'nosniff');
    assert.equal(header(h, 'X-Frame-Options'), 'DENY');
    assert.equal(header(h, 'Referrer-Policy'), 'strict-origin-when-cross-origin');
    for (const f of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()']) assert.ok(header(h, 'Permissions-Policy')!.includes(f), f);
    assert.equal(header(h, 'Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
  });

  it('gateway API responses are never stored; signed-in page shells are private; the reset page sends no Referer and is not cached', () => {
    const rules = allHeaderRules({ isProd: true });
    const forPath = (source: string) => rules.filter((r) => r.source === source);
    assert.match(header(forPath('/api/:path*')[0].headers, 'Cache-Control')!, /no-store/);
    for (const p of ['/admin/:path*', '/dashboard/:path*', '/settings/:path*', '/discover/:path*', '/login']) {
      assert.match(header(forPath(p)[0].headers, 'Cache-Control')!, /private/, p);
    }
    const reset = forPath('/reset-password');
    assert.ok(reset.some((r) => header(r.headers, 'Referrer-Policy') === 'no-referrer'));
    assert.ok(reset.some((r) => /no-store/.test(header(r.headers, 'Cache-Control') ?? '')));
    assert.equal(forPath('/:path*').length, 1);
    // no path is covered by two rules that both set Cache-Control (the browser would see two values)
    const cacheRules = rules.filter((r) => header(r.headers, 'Cache-Control'));
    assert.equal(new Set(cacheRules.map((r) => r.source)).size, cacheRules.length);
  });

  it('originOf extracts a clean origin and refuses anything else', () => {
    assert.equal(originOf('https://api.orion-test.example/api/v1?x=1'), 'https://api.orion-test.example');
    assert.equal(originOf('/api/v1'), null);
    assert.equal(originOf('javascript:alert(1)'), null);
    assert.equal(originOf(undefined), null);
  });
});

describe('Phase 14: cookie Secure flag does not depend on a spoofable Host header', () => {
  it('in production nothing is local, whatever the Host says', () => {
    for (const h of ['localhost', 'localhost:3000', '127.0.0.1', 'localhost.attacker.example', 'app.localhost']) assert.equal(isLocalRequestHost(h, { NODE_ENV: 'production' }), false, h);
  });

  it('outside production only an exact loopback name is local', () => {
    const dev = { NODE_ENV: 'development' };
    for (const h of ['localhost', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'app.localhost:3000']) assert.equal(isLocalRequestHost(h, dev), true, h);
    for (const h of ['localhost.attacker.example', 'evil-localhost.com', 'example.com', '127.0.0.1.attacker.example', '', null, undefined]) assert.equal(isLocalRequestHost(h as string, dev), false, String(h));
  });

  it('takes the first value of a forwarded host list', () => {
    assert.equal(isLocalRequestHost('example.com, localhost', { NODE_ENV: 'development' }), false);
    assert.equal(isLocalRequestHost('localhost, example.com', { NODE_ENV: 'development' }), true);
  });
});
