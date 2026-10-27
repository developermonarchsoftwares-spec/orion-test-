/**
 * Cloudflare Turnstile verification for the gateway's native auth routes (the same rules as apps/api/src/auth/captcha/captcha.service.ts,
 * which guards the NestJS API). Server-only: it holds the secret key. When the gateway proxies to the API the API does the check; this
 * runs only on the native fallback path.
 *
 * Active when TURNSTILE_SECRET_KEY is set. With no secret it is off, so a deployment without keys keeps working.
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

export function isCaptchaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return clean(env.TURNSTILE_SECRET_KEY).length > 0;
}

/** Resolves to null when the visitor passed (or the check is off), otherwise to the rejection to send back. */
export async function checkCaptcha(
  token: unknown,
  ip: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptchaRejection | null> {
  const secret = clean(env.TURNSTILE_SECRET_KEY);
  if (!secret) return null;

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
