/**
 * Where the browser is sent for an OAuth provider's callback and, afterwards, back into the web app.
 *
 * Both values come from configuration. When they are not set they are derived from the web app's own address (WEB_APP_URL / FRONTEND_URL),
 * because the web app is the origin that is registered with the provider (its gateway forwards /api/v1/auth/<provider>/callback to this API).
 * Outside production a localhost default keeps local development working. In production nothing is guessed: a hard-coded address (an old
 * deployment, localhost) would send users to a page that is not theirs, so the value stays empty and the caller reports the provider as
 * not configured.
 */
export type OAuthProviderName = 'google' | 'microsoft';

const trimSlash = (v: string | undefined): string => (v ?? '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');

/** The provider callback used when GOOGLE_CALLBACK_URL / MICROSOFT_CALLBACK_URL is not set; '' when it cannot be known safely. */
export function defaultOAuthCallbackUrl(provider: OAuthProviderName, env: NodeJS.ProcessEnv = process.env): string {
  const base = trimSlash(env.WEB_APP_URL) || trimSlash(env.FRONTEND_URL);
  if (base) return `${base}/api/v1/auth/${provider}/callback`;
  return env.NODE_ENV === 'production' ? '' : `http://localhost:4000/api/v1/auth/${provider}/callback`;
}

/** The web app's address for redirects after a provider returns; '' in production when unset (a relative redirect then stays on the current host). */
export function oauthFrontendUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = trimSlash(env.FRONTEND_URL) || trimSlash(env.WEB_APP_URL);
  if (url) return url;
  return env.NODE_ENV === 'production' ? '' : 'http://localhost:3000';
}
