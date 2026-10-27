import { CaptchaService } from '../captcha/captcha.service';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
const ON = env({ TURNSTILE_SECRET_KEY: 'test-secret' });

const mockSiteverify = (body: unknown, ok = true) =>
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body } as Response);

describe('CaptchaService', () => {
  const svc = new CaptchaService();
  afterEach(() => jest.restoreAllMocks());

  it('is off when no secret is configured, so keyless deployments and the test suites are unaffected', async () => {
    const spy = jest.spyOn(global, 'fetch');
    expect(svc.isEnabled(env({}))).toBe(false);
    await expect(svc.assertHuman(undefined, '1.2.3.4', env({}))).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a missing, empty or oversized token without calling Cloudflare', async () => {
    const spy = jest.spyOn(global, 'fetch');
    for (const bad of [undefined, '', '   ', 'x'.repeat(5000), 42]) {
      await expect(svc.assertHuman(bad, '1.2.3.4', ON)).rejects.toMatchObject({ response: { errorCode: 'CAPTCHA_REQUIRED', statusCode: 400 } });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts a token Cloudflare confirms, sending the secret, token and caller IP', async () => {
    const spy = mockSiteverify({ success: true });
    await expect(svc.assertHuman('good-token', '9.9.9.9', ON)).resolves.toBeUndefined();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get('secret')).toBe('test-secret');
    expect(sent.get('response')).toBe('good-token');
    expect(sent.get('remoteip')).toBe('9.9.9.9');
  });

  it('rejects a token Cloudflare refuses (expired, reused or forged) with a retry message', async () => {
    mockSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    await expect(svc.assertHuman('used-token', undefined, ON)).rejects.toMatchObject({
      response: { errorCode: 'CAPTCHA_FAILED', statusCode: 400, message: expect.stringMatching(/try again/i) },
    });
  });

  it('fails closed when Cloudflare cannot be reached', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(svc.assertHuman('any', '1.1.1.1', ON)).rejects.toMatchObject({ response: { errorCode: 'CAPTCHA_UNAVAILABLE', statusCode: 503 } });
    mockSiteverify({}, false);
    await expect(svc.assertHuman('any', '1.1.1.1', ON)).rejects.toMatchObject({ response: { errorCode: 'CAPTCHA_UNAVAILABLE' } });
  });

  it('reports a wrong secret key as unavailable, not as the visitor failing', async () => {
    mockSiteverify({ success: false, 'error-codes': ['invalid-input-secret'] });
    await expect(svc.assertHuman('any', undefined, ON)).rejects.toMatchObject({ response: { errorCode: 'CAPTCHA_UNAVAILABLE' } });
  });
});
