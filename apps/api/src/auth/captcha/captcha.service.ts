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
 * Server-side Cloudflare Turnstile verification. The browser's token is never trusted on its own: it is checked with Cloudflare using the
 * secret key, once (Cloudflare rejects a token it has already redeemed), and bound to the caller's IP when known.
 *
 * The check is active when TURNSTILE_SECRET_KEY is set. With no secret it is off (local development and the automated test suites), so a
 * deployment that has not been given keys keeps working instead of locking everyone out.
 */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);

  isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return clean(env.TURNSTILE_SECRET_KEY).length > 0;
  }

  async assertHuman(token: unknown, ip?: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const secret = clean(env.TURNSTILE_SECRET_KEY);
    if (!secret) return;

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
