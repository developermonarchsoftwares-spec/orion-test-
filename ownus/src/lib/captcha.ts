/**
 * Cloudflare Turnstile verification for the gateway's native auth routes (the same rules as apps/api/src/auth/captcha/captcha.service.ts,
 * which guards the NestJS API). Server-only: it holds the secret key. When the gateway proxies to the API the API does the check; this
 * runs only on the native fallback path.
 *
 * Active when TURNSTILE_SECRET_KEY is set. With no secret it is off outside production; in production it fails closed unless ALLOW_NO_CAPTCHA=true.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 4096;

export const CAPTCHA_MESSAGES = {
  required: 'Please complete the security check before continuing.',
  failed: 'The security check failed or expired. Please try again.',
  unavailable: 'We could not verify the security check right now. Please try again in a moment.',
} as const;

export interface CaptchaRejection {
  status: number;
  errorCode: 'CAPTCHA_REQUIRED' | 'CAPTCHA_FAILED' | 'CAPTCHA_UNAVAILABLE';
  message: string;
}

const clean = (v?: string) => String(v ?? '').replace(/[\r\n]+/g, '').trim().replace(/^["'`]|["'`]$/g, '').trim();

/** Same modes as the API (apps/api/src/auth/captcha/captcha.service.ts): enforced, off (outside production), misconfigured (production without a secret: fail closed) and acknowledged-off (ALLOW_NO_CAPTCHA=true). */
export type CaptchaMode = 'enforced' | 'off' | 'misconfigured' | 'acknowledged-off';

export function captchaMode(env: NodeJS.ProcessEnv = process.env): CaptchaMode {
  if (clean(env.TURNSTILE_SECRET_KEY).length > 0) return 'enforced';
  if (clean(env.NODE_ENV) === 'production') return clean(env.ALLOW_NO_CAPTCHA).toLowerCase() === 'true' ? 'acknowledged-off' : 'misconfigured';
  return 'off';
}

/**
 * The two Turnstile keys must be set together. With the secret but no site key the sign-in forms show no check while the server demands one, so
 * nobody can sign in; with the site key but no secret the forms show a check nobody verifies. Returns a message when production is set up that
 * way (used by next.config.ts to stop the build or start), otherwise null. Both unset is handled at run time (fail closed, or ALLOW_NO_CAPTCHA).
 */
export function captchaKeyProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (clean(env.NODE_ENV) !== 'production') return null;
  const secret = clean(env.TURNSTILE_SECRET_KEY);
  const site = clean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  if (secret && !site) return 'TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not: the sign-in forms would show no security check and every sign-in would be refused. Set both keys.';
  if (!secret && site) return 'NEXT_PUBLIC_TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is not: the security check would be shown but never verified. Set both keys.';
  return null;
}

export function isCaptchaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return captchaMode(env) === 'enforced';
}

/** Resolves to null when the visitor passed (or the check is off), otherwise to the rejection to send back. */
export async function checkCaptcha(
  token: unknown,
  ip: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptchaRejection | null> {
  const mode = captchaMode(env);
  if (mode === 'misconfigured') {
    console.error('[CAPTCHA] TURNSTILE_SECRET_KEY is not set in production: refusing the request (set the key, or ALLOW_NO_CAPTCHA=true to run without bot protection on purpose)');
    return { status: 503, errorCode: 'CAPTCHA_UNAVAILABLE', message: CAPTCHA_MESSAGES.unavailable };
  }
  const secret = clean(env.TURNSTILE_SECRET_KEY);
  if (!secret) return null; // 'off' or 'acknowledged-off'

  if (typeof token !== 'string' || !token.trim() || token.length > MAX_TOKEN_LENGTH) {
    return { status: 400, errorCode: 'CAPTCHA_REQUIRED', message: CAPTCHA_MESSAGES.required };
  }

  const form = new URLSearchParams({ secret, response: token.trim() });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);

  let result: { success?: boolean; 'error-codes'?: string[] };
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
    result = (await res.json()) as typeof result;
  } catch (err) {
    console.error(`[CAPTCHA] verification unavailable: ${(err as Error).message}`);
    return { status: 503, errorCode: 'CAPTCHA_UNAVAILABLE', message: CAPTCHA_MESSAGES.unavailable };
  }

  if (result.success === true) return null;

  const codes = result['error-codes'] ?? [];
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
    console.error(`[CAPTCHA] secret key rejected by Cloudflare (${codes.join(', ')}); check TURNSTILE_SECRET_KEY`);
    return { status: 503, errorCode: 'CAPTCHA_UNAVAILABLE', message: CAPTCHA_MESSAGES.unavailable };
  }
  return { status: 400, errorCode: 'CAPTCHA_FAILED', message: CAPTCHA_MESSAGES.failed };
}
