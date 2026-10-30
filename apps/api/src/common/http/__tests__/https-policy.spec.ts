import { configuredHosts, httpsDecision, httpsEnforcement } from '../https-policy';

/** Production HTTPS enforcement: acts only on an explicit "http" from the proxy, and only redirects to hosts the app was configured for. */
const PROD = { NODE_ENV: 'production', APP_URL: 'https://api.orion.example', FRONTEND_URL: 'https://app.orion.example', CORS_ORIGINS: 'https://app.orion.example,https://www.orion.example' } as NodeJS.ProcessEnv;
const req = (over: Record<string, any> = {}) => ({ method: 'GET', originalUrl: '/api/v1/health/liveness?x=1', url: '/api/v1/health/liveness?x=1', headers: { host: 'api.orion.example', 'x-forwarded-proto': 'http' }, ...over }) as any;

describe('https policy', () => {
  it('does nothing outside production', () => {
    expect(httpsDecision(req(), { ...PROD, NODE_ENV: 'development' })).toEqual({ action: 'next' });
    expect(httpsDecision(req(), { NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toEqual({ action: 'next' });
  });

  it('leaves requests alone that are https, or that carry no proxy information (health probes, local use)', () => {
    expect(httpsDecision(req({ headers: { host: 'api.orion.example', 'x-forwarded-proto': 'https' } }), PROD)).toEqual({ action: 'next' });
    expect(httpsDecision(req({ headers: { host: 'localhost:4000' } }), PROD)).toEqual({ action: 'next' });
    expect(httpsDecision(req({ headers: {} }), PROD)).toEqual({ action: 'next' });
  });

  it('redirects a plain-http GET or HEAD to the same URL over https, keeping the path and query', () => {
    expect(httpsDecision(req(), PROD)).toEqual({ action: 'redirect', location: 'https://api.orion.example/api/v1/health/liveness?x=1' });
    expect(httpsDecision(req({ method: 'HEAD' }), PROD)).toMatchObject({ action: 'redirect' });
  });

  it('prefers the forwarded host, and takes the first value of a list', () => {
    const r = req({ headers: { host: 'internal:4000', 'x-forwarded-host': 'app.orion.example, other', 'x-forwarded-proto': 'http, https' } });
    expect(httpsDecision(r, PROD)).toEqual({ action: 'redirect', location: 'https://app.orion.example/api/v1/health/liveness?x=1' });
  });

  it('refuses instead of redirecting a method that would be replayed, so no credentials travel twice', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(httpsDecision(req({ method }), PROD)).toEqual({ action: 'refuse' });
  });

  it('never redirects to a host it was not configured for (no open redirect through a forged Host header)', () => {
    expect(httpsDecision(req({ headers: { host: 'evil.example', 'x-forwarded-proto': 'http' } }), PROD)).toEqual({ action: 'refuse' });
    expect(httpsDecision(req({ headers: { 'x-forwarded-host': 'evil.example/', 'x-forwarded-proto': 'http' } }), PROD)).toEqual({ action: 'refuse' });
    expect(httpsDecision(req({ headers: { 'x-forwarded-proto': 'http' } }), PROD)).toEqual({ action: 'refuse' }); // no host at all
    expect(httpsDecision(req(), { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toEqual({ action: 'refuse' }); // nothing configured
  });

  it('knows the hosts from the configuration only', () => {
    expect([...configuredHosts(PROD)].sort()).toEqual(['api.orion.example', 'app.orion.example', 'www.orion.example']);
    expect(configuredHosts({ APP_URL: 'not a url', CORS_ORIGINS: ',,' } as NodeJS.ProcessEnv).size).toBe(0);
  });

  describe('middleware', () => {
    const run = (r: any) => {
      const out: any = { status: 200, redirected: null, body: null, nextCalled: false };
      const res: any = {
        redirect: (code: number, location: string) => { out.status = code; out.redirected = location; },
        status: (code: number) => { out.status = code; return res; },
        json: (b: unknown) => { out.body = b; },
      };
      httpsEnforcement(PROD)(r, res, () => { out.nextCalled = true; });
      return out;
    };
    it('passes https through, redirects with 308, and answers 403 HTTPS_REQUIRED for the rest', () => {
      expect(run(req({ headers: { host: 'api.orion.example', 'x-forwarded-proto': 'https' } })).nextCalled).toBe(true);
      expect(run(req())).toMatchObject({ status: 308, redirected: 'https://api.orion.example/api/v1/health/liveness?x=1', nextCalled: false });
      const refused = run(req({ method: 'POST' }));
      expect(refused).toMatchObject({ status: 403, nextCalled: false });
      expect(refused.body.errorCode).toBe('HTTPS_REQUIRED');
    });
  });

  it('is mounted before the security headers in main.ts', () => {
    const main = require('fs').readFileSync(require('path').resolve(__dirname, '../../../main.ts'), 'utf8');
    expect(main).toContain('app.use(httpsEnforcement())');
    expect(main.indexOf('httpsEnforcement()')).toBeLessThan(main.indexOf('securityMiddleware()'));
  });
});
