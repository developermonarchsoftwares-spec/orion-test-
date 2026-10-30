import { environmentValidationSchema } from '../env.validation';

/** Production must start with the encryption keys and bot protection configured, or say on purpose that it runs without bot protection. */
const REAL = 'f3a91c07d5e24b86a0c1d9e7b25f4a63';
const KEY = 'k7Qp2vXz9LmN4sTa8WbYc1Ud6GhJe3RfVi5OoZxC0';
const BASE = { NODE_ENV: 'production', JWT_ACCESS_SECRET: REAL, JWT_REFRESH_SECRET: REAL.split('').reverse().join(''), DATABASE_URL: 'postgresql://u:p@db.example:5432/orion' };
const FULL = { ...BASE, MFA_ENCRYPTION_KEY: KEY, INTEGRATIONS_ENCRYPTION_KEY: KEY.split('').reverse().join(''), TURNSTILE_SECRET_KEY: 'turnstile-secret-value' };
const check = (env: Record<string, string>) => environmentValidationSchema.validate(env, { allowUnknown: true, abortEarly: false });
const without = (env: Record<string, string>, ...drop: string[]) => Object.fromEntries(Object.entries(env).filter(([k]) => !drop.includes(k)));

describe('production security configuration', () => {
  it('a complete production environment is accepted', () => {
    expect(check(FULL).error).toBeUndefined();
  });

  describe('encryption keys', () => {
    it.each(['MFA_ENCRYPTION_KEY', 'INTEGRATIONS_ENCRYPTION_KEY'])('production refuses to start without %s', (name) => {
      expect(check(without(FULL, name)).error?.message).toContain(name);
      expect(check({ ...FULL, [name]: '' }).error?.message).toContain(name);
    });
    it.each(['MFA_ENCRYPTION_KEY', 'INTEGRATIONS_ENCRYPTION_KEY'])('%s must be at least 32 characters and not an example value', (name) => {
      expect(check({ ...FULL, [name]: 'too-short' }).error?.message).toContain(name);
      expect(check({ ...FULL, [name]: 'your_encryption_key_placeholder_value_123456' }).error?.message).toContain(name);
      expect(check({ ...FULL, [name]: 'changeme_changeme_changeme_changeme_ch' }).error?.message).toContain(name);
    });
    it('the previous-key variables are optional', () => {
      expect(check({ ...FULL, MFA_ENCRYPTION_KEY_PREVIOUS: `${KEY},${KEY}x`, INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS: KEY }).error).toBeUndefined();
    });
    it('outside production they stay optional, but a short value is still refused', () => {
      expect(check({ NODE_ENV: 'development' }).error).toBeUndefined();
      expect(check({ NODE_ENV: 'test' }).error).toBeUndefined();
      expect(check({ NODE_ENV: 'development', MFA_ENCRYPTION_KEY: 'short' }).error?.message).toContain('MFA_ENCRYPTION_KEY');
    });
  });

  describe('bot protection', () => {
    it('production refuses to start without TURNSTILE_SECRET_KEY', () => {
      expect(check(without(FULL, 'TURNSTILE_SECRET_KEY')).error?.message).toContain('TURNSTILE_SECRET_KEY');
      expect(check({ ...FULL, TURNSTILE_SECRET_KEY: '' }).error?.message).toContain('TURNSTILE_SECRET_KEY');
    });
    it('starts without it only when ALLOW_NO_CAPTCHA=true is set on purpose', () => {
      expect(check({ ...without(FULL, 'TURNSTILE_SECRET_KEY'), ALLOW_NO_CAPTCHA: 'true' }).error).toBeUndefined();
      expect(check({ ...without(FULL, 'TURNSTILE_SECRET_KEY'), ALLOW_NO_CAPTCHA: 'false' }).error?.message).toContain('TURNSTILE_SECRET_KEY');
      expect(check({ ...without(FULL, 'TURNSTILE_SECRET_KEY'), ALLOW_NO_CAPTCHA: 'maybe' }).error?.message).toContain('ALLOW_NO_CAPTCHA');
    });
    it('is not required outside production', () => {
      expect(check({ NODE_ENV: 'development' }).error).toBeUndefined();
    });
  });
});
