import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { captchaKeyProblem, captchaMode, checkCaptcha, isCaptchaEnabled } from '../captcha.ts';
import { httpsRedirectRules } from '../security-headers.ts';

/** Bot protection that cannot vanish silently, Turnstile keys that must match, forgot-password covered, and plain http sent to https in production. */
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
const read = (...p: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');

describe('gateway captcha mode', () => {
  it('is enforced with a secret, off outside production without one, misconfigured in production without one', () => {
    assert.equal(captchaMode(env({ NODE_ENV: 'production', TURNSTILE_SECRET_KEY: 's3cret' })), 'enforced');
    assert.equal(captchaMode(env({ NODE_ENV: 'development' })), 'off');
    assert.equal(captchaMode(env({})), 'off');
    assert.equal(captchaMode(env({ NODE_ENV: 'production' })), 'misconfigured');
    assert.equal(captchaMode(env({ NODE_ENV: 'production', TURNSTILE_SECRET_KEY: '  ' })), 'misconfigured');
    assert.equal(captchaMode(env({ NODE_ENV: 'production', ALLOW_NO_CAPTCHA: 'yes' })), 'misconfigured');
    assert.equal(captchaMode(env({ NODE_ENV: 'production', ALLOW_NO_CAPTCHA: 'true' })), 'acknowledged-off');
    assert.equal(captchaMode(env({ NODE_ENV: 'production', ALLOW_NO_CAPTCHA: 'true', TURNSTILE_SECRET_KEY: 's3cret' })), 'enforced');
  });
  it('isCaptchaEnabled means enforced only', () => {
    assert.equal(isCaptchaEnabled(env({ NODE_ENV: 'production', TURNSTILE_SECRET_KEY: 's3cret' })), true);
    assert.equal(isCaptchaEnabled(env({ NODE_ENV: 'production', ALLOW_NO_CAPTCHA: 'true' })), false);
  });
  it('production with no secret FAILS CLOSED with 503, with or without a token', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    for (const token of [undefined, 'looks-like-a-token']) {
      assert.deepEqual(await checkCaptcha(token, '203.0.113.1', env({ NODE_ENV: 'production' }), (async () => { throw new Error('must not call Cloudflare'); }) as any), {
        status: 503,
        errorCode: 'CAPTCHA_UNAVAILABLE',
        message: 'We could not verify the security check right now. Please try again in a moment.',
      });
    }
  });
  it('an acknowledged deployment, and development, pass without calling Cloudflare', async () => {
    const never = (async () => { throw new Error('must not call Cloudflare'); }) as any;
    assert.equal(await checkCaptcha(undefined, undefined, env({ NODE_ENV: 'production', ALLOW_NO_CAPTCHA: 'true' }), never), null);
    assert.equal(await checkCaptcha(undefined, undefined, env({ NODE_ENV: 'development' }), never), null);
  });
  it('with the secret a missing token is refused with 400', async () => {
    const r = await checkCaptcha(undefined, undefined, env({ NODE_ENV: 'production', TURNSTILE_SECRET_KEY: 's3cret' }));
    assert.equal(r?.status, 400);
    assert.equal(r?.errorCode, 'CAPTCHA_REQUIRED');
  });
});

describe('Turnstile keys must be set together in production', () => {
  it('flags the secret without the site key (everyone would be locked out) and the site key without the secret (a check nobody verifies)', () => {
    assert.match(captchaKeyProblem(env({ NODE_ENV: 'production', TURNSTILE_SECRET_KEY: 's3cret' }))!, /NEXT_PUBLIC_TURNSTILE_SITE_KEY is not/);
    assert.match(captchaKeyProblem(env({ NODE_ENV: 'production', NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAA' }))!, /TURNSTILE_SECRET_KEY is not/);
  });
  it('accepts both, neither (handled at run time) and anything outside production', () => {
    assert.equal(captchaKeyProblem(env({ NODE_ENV: 'production', TURNSTILE_SECRET_KEY: 's3cret', NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAA' })), null);
    assert.equal(captchaKeyProblem(env({ NODE_ENV: 'production' })), null);
    assert.equal(captchaKeyProblem(env({ NODE_ENV: 'development', TURNSTILE_SECRET_KEY: 's3cret' })), null);
    assert.equal(captchaKeyProblem(env({})), null);
  });
  it('next.config.ts stops a mismatched production build or start', () => {
    const cfg = read('next.config.ts');
    assert.match(cfg, /const keyProblem = captchaKeyProblem\(\);\s*if \(keyProblem\) throw new Error\(keyProblem\);/);
  });
});

describe('forgot-password is checked', () => {
  it('the gateway verifies before it looks anything up or sends anything', () => {
    const route = read('src', 'app', 'api', 'v1', '[...path]', 'route.ts');
    const start = route.indexOf('async function handleForgotPassword');
    const body = route.slice(start, route.indexOf('\nasync function ', start + 10));
    assert.ok(body.includes('checkCaptcha(body?.captchaToken'));
    assert.ok(body.indexOf('checkCaptcha(') < body.indexOf('queryDb('), 'checked before the user lookup');
    assert.ok(body.indexOf('checkCaptcha(') < body.indexOf('gatewayRateLimited('), 'checked before the rate limiter spends anything');
  });
  it('the page shows the widget, will not submit without a token, and resets it after each attempt', () => {
    const page = read('src', 'app', '(auth)', 'forgot-password', 'page.tsx');
    assert.match(page, /<Turnstile/);
    assert.match(page, /captchaEnabled && !captchaToken/);
    assert.match(page, /forgotPassword\(email, captchaToken\)/);
    assert.match(page, /captchaRef\.current\?\.reset\(\)/);
  });
  it('the API client sends the token only when there is one', () => {
    assert.match(read('src', 'lib', 'api-client.ts'), /forgotPassword: \(email: string, captchaToken\?: string \| null\) =>[^\n]*\.\.\.\(captchaToken \? \{ captchaToken \} : \{\}\)/);
  });
});

describe('plain http goes to https in production', () => {
  it('has no rule outside production', () => {
    assert.deepEqual(httpsRedirectRules(false), []);
  });
  it('production redirects only a request the proxy reports as http, permanently, to the same host and path', () => {
    const [rule] = httpsRedirectRules(true);
    assert.equal(httpsRedirectRules(true).length, 1);
    assert.equal(rule.source, '/:path*');
    assert.equal(rule.destination, 'https://:host/:path*');
    assert.equal(rule.permanent, true);
    assert.deepEqual(rule.has[0], { type: 'header', key: 'x-forwarded-proto', value: 'http' });
    assert.deepEqual(rule.has[1], { type: 'host', value: '(?<host>.*)' });
  });
  it('is wired into next.config.ts', () => {
    assert.match(read('next.config.ts'), /async redirects\(\) \{\s*return httpsRedirectRules\(isProd\);/);
  });
});
