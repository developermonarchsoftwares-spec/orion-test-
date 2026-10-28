import { BusinessException } from '../../common/errors/business.exception';
import { AuthController } from '../auth.controller';
import { CAPTCHA_MESSAGES } from '../captcha/captcha.service';

/** The controllers must refuse before any account work happens when the CAPTCHA check throws. */
describe('CAPTCHA on sign-in and sign-up', () => {
  const req = { headers: { 'user-agent': 'jest' }, ip: '203.0.113.7' } as never;
  const build = (assertHuman: jest.Mock) => {
    const authService = { login: jest.fn().mockResolvedValue({ ok: true }), register: jest.fn() };
    const emailOtp = { send: jest.fn().mockResolvedValue({ sent: true }) };
    const controller = new AuthController(authService as never, {} as never, emailOtp as never, { assertHuman } as never);
    return { controller, authService, emailOtp };
  };
  const refusal = new BusinessException(CAPTCHA_MESSAGES.required, 'CAPTCHA_REQUIRED', 400);

  it('login: a failed check stops the request before the password is looked at', async () => {
    const { controller, authService } = build(jest.fn().mockRejectedValue(refusal));
    await expect(controller.login({ email: 'a@b.co', password: 'x' } as never, req)).rejects.toBe(refusal);
    expect(authService.login).not.toHaveBeenCalled();
  });

  it('sign-up code: a failed check stops the request before any e-mail is sent', async () => {
    const { controller, emailOtp } = build(jest.fn().mockRejectedValue(refusal));
    await expect(controller.sendOtp({ email: 'a@b.co' } as never, req)).rejects.toBe(refusal);
    expect(emailOtp.send).not.toHaveBeenCalled();
  });

  it('a passing check lets both requests through, and the token and caller address are what get verified', async () => {
    const assertHuman = jest.fn().mockResolvedValue(undefined);
    const { controller, authService, emailOtp } = build(assertHuman);
    await controller.login({ email: 'a@b.co', password: 'x', captchaToken: 'tok-1' } as never, req);
    await controller.sendOtp({ email: 'a@b.co', captchaToken: 'tok-2' } as never, req);
    expect(authService.login).toHaveBeenCalledTimes(1);
    expect(emailOtp.send).toHaveBeenCalledTimes(1);
    expect(assertHuman.mock.calls.map((c) => c[0])).toEqual(['tok-1', 'tok-2']);
    expect(assertHuman.mock.calls[0][1]).toBeTruthy();
  });
});
