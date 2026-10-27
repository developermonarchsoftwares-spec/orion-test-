import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkCaptcha, isCaptchaEnabled } from '../captcha.ts';

const ON = { TURNSTILE_SECRET_KEY: 'test-secret' } as unknown as NodeJS.ProcessEnv;
const reply = (body: unknown, ok = true) => (async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response) as typeof fetch;

describe('gateway CAPTCHA check', () => {
  it('is off without a secret and never calls Cloudflare', async () => {
    let called = false;
    const spy = (async () => { called = true; return {} as Response; }) as typeof fetch;
    assert.equal(isCaptchaEnabled({} as NodeJS.ProcessEnv), false);
    assert.equal(await checkCaptcha(undefined, '1.2.3.4', {} as NodeJS.ProcessEnv, spy), null);
    assert.equal(called, false);
  });

  it('requires a usable token when a secret is configured', async () => {
    for (const bad of [undefined, '', '  ', 'x'.repeat(5000), 7]) {
      const r = await checkCaptcha(bad, '1.2.3.4', ON, reply({ success: true }));
      assert.equal(r?.errorCode, 'CAPTCHA_REQUIRED');
      assert.equal(r?.status, 400);
    }
  });

  it('passes a token Cloudflare confirms and sends secret, token and IP', async () => {
    let sent: URLSearchParams | undefined;
    const spy = (async (_u: string, init: RequestInit) => { sent = new URLSearchParams(String(init.body)); return { ok: true, json: async () => ({ success: true }) } as Response; }) as unknown as typeof fetch;
    assert.equal(await checkCaptcha('tok', '9.9.9.9', ON, spy), null);
    assert.equal(sent?.get('secret'), 'test-secret');
    assert.equal(sent?.get('response'), 'tok');
    assert.equal(sent?.get('remoteip'), '9.9.9.9');
  });

  it('rejects refused tokens, fails closed on outages and treats a bad secret as unavailable', async () => {
    assert.equal((await checkCaptcha('tok', undefined, ON, reply({ success: false, 'error-codes': ['timeout-or-duplicate'] })))?.errorCode, 'CAPTCHA_FAILED');
    const down = (async () => { throw new Error('offline'); }) as typeof fetch;
    const out = await checkCaptcha('tok', undefined, ON, down);
    assert.equal(out?.errorCode, 'CAPTCHA_UNAVAILABLE');
    assert.equal(out?.status, 503);
    assert.equal((await checkCaptcha('tok', undefined, ON, reply({}, false)))?.errorCode, 'CAPTCHA_UNAVAILABLE');
    assert.equal((await checkCaptcha('tok', undefined, ON, reply({ success: false, 'error-codes': ['invalid-input-secret'] })))?.errorCode, 'CAPTCHA_UNAVAILABLE');
  });
});
