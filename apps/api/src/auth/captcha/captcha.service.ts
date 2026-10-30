import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { BusinessException } from '../../common/errors/business.exception';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 4096;

export const CAPTCHA_MESSAGES = {
  required: 'Please complete the security check before continuing.',
  failed: 'The security check failed or expired. Please try again.',
  unavailable: 'We could not verify the security check right now. Please try again in a moment.',
} as const;

const clean = (v?: string) => String(v ?? '').replace(/[\r\n]+/g, '').trim().replace(/^["'`]|["'`]$/g, '').trim();

/**
 * What the check does in this deployment:
 *  - enforced: TURNSTILE_SECRET_KEY is set; every protected request is verified with Cloudflare.
 *  - off: no secret outside production (local development and the test suites).
 *  - misconfigured: no secret IN PRODUCTION without the explicit acknowledgement. The check FAILS CLOSED (503) instead of silently letting every request through.
 *  - acknowledged-off: production with no secret and ALLOW_NO_CAPTCHA=true, a decision the operator has recorded; requests pass and a warning is logged once.
 * The API also refuses to start in the misconfigured case (config/env.validation.ts); this is the second line.
 */
export type CaptchaMode = 'enforced' | 'off' | 'misconfigured' | 'acknowledged-off';

export function captchaMode(env: NodeJS.ProcessEnv = process.env): CaptchaMode {
  if (clean(env.TURNSTILE_SECRET_KEY).length > 0) return 'enforced';
  if (clean(env.NODE_ENV) === 'production') return clean(env.ALLOW_NO_CAPTCHA).toLowerCase() === 'true' ? 'acknowledged-off' : 'misconfigured';
  return 'off';
}

/**
 * Server-side Cloudflare Turnstile verification. The browser's token is never trusted on its own: it is checked with Cloudflare using the
 * secret key, once (Cloudflare rejects a token it has already redeemed), and bound to the caller's IP when known.
 *
 * The check is active when TURNSTILE_SECRET_KEY is set (see captchaMode for the other cases: off outside production, fail closed in production).
 */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);

  private warnedAcknowledgedOff = false;

  isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return captchaMode(env) === 'enforced';
  }

  async assertHuman(token: unknown, ip?: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const mode = captchaMode(env);
    if (mode === 'misconfigured') {
      this.logger.error('TURNSTILE_SECRET_KEY is not set in production: refusing the request. Set the key, or set ALLOW_NO_CAPTCHA=true to run without bot protection on purpose.');
      throw new BusinessException(CAPTCHA_MESSAGES.unavailable, 'CAPTCHA_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (mode === 'acknowledged-off') {
      if (!this.warnedAcknowledgedOff) {
        this.warnedAcknowledgedOff = true;
        this.logger.warn('Bot protection is OFF in production (ALLOW_NO_CAPTCHA=true). Sign-in, sign-up and password-reset requests are not checked.');
      }
      return;
    }
    const secret = clean(env.TURNSTILE_SECRET_KEY);
    if (!secret) return; // mode 'off'

    if (typeof token !== 'string' || !token.trim() || token.length > MAX_TOKEN_LENGTH) {
      throw new BusinessException(CAPTCHA_MESSAGES.required, 'CAPTCHA_REQUIRED', HttpStatus.BAD_REQUEST);
    }

    const form = new URLSearchParams({ secret, response: token.trim() });
    if (ip) form.set('remoteip', ip);

    let result: { success?: boolean; 'error-codes'?: string[] };
    try {
      const res = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
      result = (await res.json()) as typeof result;
    } catch (err) {
      // fail closed: if Cloudflare cannot be reached nobody is let through unchecked
      this.logger.error(`CAPTCHA verification unavailable: ${(err as Error).message}`);
      throw new BusinessException(CAPTCHA_MESSAGES.unavailable, 'CAPTCHA_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    }

    if (result.success === true) return;

    const codes = result['error-codes'] ?? [];
    // a wrong or missing secret is a deployment problem, not the visitor's: report it as unavailable and log it for the operator
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
      this.logger.error(`CAPTCHA secret key rejected by Cloudflare (${codes.join(', ')}); check TURNSTILE_SECRET_KEY`);
      throw new BusinessException(CAPTCHA_MESSAGES.unavailable, 'CAPTCHA_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    }
    throw new BusinessException(CAPTCHA_MESSAGES.failed, 'CAPTCHA_FAILED', HttpStatus.BAD_REQUEST, { reasons: codes });
  }
}
