import { CaptchaService, captchaMode } from '../captcha/captcha.service';

/** Bot protection must not disappear silently in production: no secret there fails closed unless the operator says so on purpose. */
const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

describe('captcha mode', () => {
  it('is enforced whenever the secret is set, in any environment', () => {
    for (const env of ['production', 'development', 'test']) expect(captchaMode({ NODE_ENV: env, TURNSTILE_SECRET_KEY: 'secret-value' } as NodeJS.ProcessEnv)).toBe('enforced');
    expect(captchaMode({ ...PROD, TURNSTILE_SECRET_KEY: 'secret-value', ALLOW_NO_CAPTCHA: 'true' })).toBe('enforced'); // the acknowledgement never weakens a configured check
  });
  it('is off outside production with no secret (local development and the test suites)', () => {
    expect(captchaMode({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe('off');
    expect(captchaMode({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe('off');
    expect(captchaMode({} as NodeJS.ProcessEnv)).toBe('off');
  });
  it('is misconfigured in production with no secret, and a blank or whitespace secret counts as none', () => {
    expect(captchaMode(PROD)).toBe('misconfigured');
    expect(captchaMode({ ...PROD, TURNSTILE_SECRET_KEY: '   ' })).toBe('misconfigured');
    expect(captchaMode({ ...PROD, ALLOW_NO_CAPTCHA: 'false' })).toBe('misconfigured');
    expect(captchaMode({ ...PROD, ALLOW_NO_CAPTCHA: 'yes' })).toBe('misconfigured'); // only the exact word "true" is an acknowledgement
  });
  it('is acknowledged-off only with ALLOW_NO_CAPTCHA=true', () => {
    expect(captchaMode({ ...PROD, ALLOW_NO_CAPTCHA: 'true' })).toBe('acknowledged-off');
    expect(captchaMode({ ...PROD, ALLOW_NO_CAPTCHA: ' TRUE ' })).toBe('acknowledged-off');
  });
});

describe('CaptchaService.assertHuman', () => {
  const svc = () => {
    const s = new CaptchaService();
    jest.spyOn((s as any).logger, 'error').mockImplementation(() => undefined);
    jest.spyOn((s as any).logger, 'warn').mockImplementation(() => undefined);
    return s;
  };

  it('production with no secret FAILS CLOSED with 503 CAPTCHA_UNAVAILABLE, even for a request that carries a token', async () => {
    const s = svc();
    await expect(s.assertHuman(undefined, '203.0.113.1', PROD)).rejects.toMatchObject({ errorCode: 'CAPTCHA_UNAVAILABLE', getStatus: expect.any(Function) });
    await expect(s.assertHuman('looks-like-a-token', '203.0.113.1', PROD)).rejects.toMatchObject({ errorCode: 'CAPTCHA_UNAVAILABLE' });
    const err: any = await s.assertHuman(undefined, undefined, PROD).catch((e) => e);
    expect(err.getStatus()).toBe(503);
    expect((s as any).logger.error).toHaveBeenCalled();
  });

  it('an acknowledged deployment passes and warns once, not on every request', async () => {
    const s = svc();
    const env = { ...PROD, ALLOW_NO_CAPTCHA: 'true' };
    await expect(s.assertHuman(undefined, undefined, env)).resolves.toBeUndefined();
    await expect(s.assertHuman(undefined, undefined, env)).resolves.toBeUndefined();
    expect((s as any).logger.warn).toHaveBeenCalledTimes(1);
  });

  it('outside production with no secret it passes quietly', async () => {
    const s = svc();
    await expect(s.assertHuman(undefined, undefined, { NODE_ENV: 'development' } as NodeJS.ProcessEnv)).resolves.toBeUndefined();
    expect((s as any).logger.warn).not.toHaveBeenCalled();
  });

  it('with the secret set, a missing token is still refused (400 CAPTCHA_REQUIRED)', async () => {
    const s = svc();
    await expect(s.assertHuman(undefined, undefined, { ...PROD, TURNSTILE_SECRET_KEY: 'secret-value' })).rejects.toMatchObject({ errorCode: 'CAPTCHA_REQUIRED' });
  });

  it('isEnabled is true only when the check is enforced', () => {
    const s = svc();
    expect(s.isEnabled({ ...PROD, TURNSTILE_SECRET_KEY: 'x' })).toBe(true);
    expect(s.isEnabled(PROD)).toBe(false);
    expect(s.isEnabled({ ...PROD, ALLOW_NO_CAPTCHA: 'true' })).toBe(false);
  });
});

describe('the check covers forgot-password', () => {
  const read = (p: string) => require('fs').readFileSync(require('path').resolve(__dirname, p), 'utf8');
  it('the controller verifies before it sends anything, and the DTO accepts the token', () => {
    const controller = read('../auth.controller.ts');
    const block = controller.slice(controller.indexOf('async forgotPassword('));
    expect(block.indexOf('this.captcha.assertHuman(dto.captchaToken')).toBeGreaterThan(-1);
    expect(block.indexOf('assertHuman')).toBeLessThan(block.indexOf('this.authService.forgotPassword'));
    expect(read('../dto/auth.dto.ts')).toMatch(/class ForgotPasswordDto[\s\S]*?captchaToken\?: string/);
  });
});
