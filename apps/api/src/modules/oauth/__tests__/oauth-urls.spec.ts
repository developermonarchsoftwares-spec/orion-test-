import { GoogleOAuthProvider } from '../providers/google.provider';
import { defaultOAuthCallbackUrl, oauthFrontendUrl } from '../oauth-urls';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
const config = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as never;

describe('OAuth callback and frontend addresses', () => {
  it('derives the provider callback from the web app address, which is the origin registered with Google', () => {
    expect(defaultOAuthCallbackUrl('google', env({ NODE_ENV: 'production', WEB_APP_URL: 'https://app.example.com/' }))).toBe('https://app.example.com/api/v1/auth/google/callback');
    expect(defaultOAuthCallbackUrl('microsoft', env({ NODE_ENV: 'production', FRONTEND_URL: 'https://app.example.com' }))).toBe('https://app.example.com/api/v1/auth/microsoft/callback');
  });

  it('never guesses in production: with no web address the callback stays empty, with none of the old hard-coded deployments', () => {
    expect(defaultOAuthCallbackUrl('google', env({ NODE_ENV: 'production' }))).toBe('');
    expect(oauthFrontendUrl(env({ NODE_ENV: 'production' }))).toBe('');
  });

  it('keeps the localhost defaults for local development only', () => {
    expect(defaultOAuthCallbackUrl('google', env({ NODE_ENV: 'development' }))).toBe('http://localhost:4000/api/v1/auth/google/callback');
    expect(oauthFrontendUrl(env({ NODE_ENV: 'development' }))).toBe('http://localhost:3000');
  });

  it('prefers FRONTEND_URL for the post-login redirect and tolerates quotes and trailing slashes', () => {
    expect(oauthFrontendUrl(env({ NODE_ENV: 'production', FRONTEND_URL: '"https://app.example.com/"', WEB_APP_URL: 'https://other.example.com' }))).toBe('https://app.example.com');
  });
});

describe('Google provider authorization request', () => {
  const base = { GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'unit-test-secret' };
  const redirectOf = (p: GoogleOAuthProvider) => new URL(p.getAuthorizationUrl('state-1', 'challenge-1')).searchParams.get('redirect_uri');

  it('sends exactly the configured GOOGLE_CALLBACK_URL as redirect_uri', () => {
    const p = new GoogleOAuthProvider(config({ ...base, GOOGLE_CALLBACK_URL: 'https://orion-web-sage.vercel.app/api/v1/auth/google/callback' }));
    expect(redirectOf(p)).toBe('https://orion-web-sage.vercel.app/api/v1/auth/google/callback');
  });

  it('refuses to send a request in production when no callback can be determined', () => {
    const saved = { n: process.env.NODE_ENV, w: process.env.WEB_APP_URL, f: process.env.FRONTEND_URL };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.WEB_APP_URL;
      delete process.env.FRONTEND_URL;
      const p = new GoogleOAuthProvider(config(base));
      expect(() => p.getAuthorizationUrl('state-1')).toThrow(/callback URL is not configured/i);
    } finally {
      process.env.NODE_ENV = saved.n;
      if (saved.w !== undefined) process.env.WEB_APP_URL = saved.w;
      if (saved.f !== undefined) process.env.FRONTEND_URL = saved.f;
    }
  });
});
