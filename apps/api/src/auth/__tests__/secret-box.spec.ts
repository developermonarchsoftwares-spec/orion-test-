import { MIN_ENCRYPTION_KEY_LENGTH, needsReseal, openSecret, resealSecret, sealSecret, secretKeyId } from '../services/secret-box.util';

/** Stored-secret encryption: explicit keys, no fail-open in production, key ids, rotation, and legacy rows that must keep opening. */
const KEY_A = 'a'.repeat(32) + 'KEY-A-for-the-mfa-scope';
const KEY_B = 'b'.repeat(32) + 'KEY-B-for-the-mfa-scope';
const JWT = 'jwt-access-secret-used-by-the-old-format';
const prod = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'production', JWT_ACCESS_SECRET: JWT, ...extra }) as NodeJS.ProcessEnv;
const dev = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'development', ...extra }) as NodeJS.ProcessEnv;

describe('secret box', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('seals under the explicit key as v2 with a key id, and opens it', () => {
    const env = prod({ MFA_ENCRYPTION_KEY: KEY_A });
    const sealed = sealSecret('TOTPSEED', env);
    expect(sealed.split('.')).toHaveLength(5);
    expect(sealed.startsWith(`v2.${secretKeyId(KEY_A, 'mfa')}.`)).toBe(true);
    expect(sealed).not.toContain('TOTPSEED');
    expect(openSecret(sealed, env)).toBe('TOTPSEED');
    expect(sealSecret('TOTPSEED', env)).not.toBe(sealed); // a fresh IV every time
  });

  it('the key id names the key without revealing it', () => {
    const kid = secretKeyId(KEY_A, 'mfa');
    expect(kid).toMatch(/^[0-9a-f]{12}$/);
    expect(kid).not.toBe(secretKeyId(KEY_B, 'mfa'));
    expect(kid).not.toBe(secretKeyId(KEY_A, 'integrations')); // the same key text in another scope is a different key
    expect(kid).not.toContain('a'.repeat(8));
  });

  describe('production never seals without an explicit key', () => {
    it('refuses, even though a JWT secret is present (no key derived from another secret)', () => {
      expect(() => sealSecret('x', prod())).toThrow(/MFA_ENCRYPTION_KEY must be set in production/);
      expect(() => sealSecret('x', prod(), 'integrations')).toThrow(/INTEGRATIONS_ENCRYPTION_KEY must be set in production/);
    });
    it('refuses with no JWT secret too, and never falls back to the constant in the source', () => {
      expect(() => sealSecret('x', { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/must be set in production/);
    });
    it('refuses a key that is too short, in every environment', () => {
      expect(MIN_ENCRYPTION_KEY_LENGTH).toBe(32);
      expect(() => sealSecret('x', prod({ MFA_ENCRYPTION_KEY: 'short' }))).toThrow(/at least 32 characters/);
      expect(() => sealSecret('x', dev({ MFA_ENCRYPTION_KEY: 'short' }))).toThrow(/at least 32 characters/);
      expect(() => sealSecret('x', prod({ MFA_ENCRYPTION_KEY: KEY_A, MFA_ENCRYPTION_KEY_PREVIOUS: 'short' }))).toThrow(/MFA_ENCRYPTION_KEY_PREVIOUS/);
    });
  });

  describe('development convenience', () => {
    it('seals without setup (JWT-derived, then constant) and warns once; this is not a secure setup', () => {
      const viaJwt = sealSecret('seed', dev({ JWT_ACCESS_SECRET: JWT }));
      expect(viaJwt.startsWith('v1.')).toBe(true);
      expect(openSecret(viaJwt, dev({ JWT_ACCESS_SECRET: JWT }))).toBe('seed');
      const viaConstant = sealSecret('seed', dev());
      expect(openSecret(viaConstant, dev())).toBe('seed');
      expect(openSecret(viaConstant, dev({ JWT_ACCESS_SECRET: JWT }))).toBe('seed'); // the constant is tried last outside production
    });
  });

  describe('rows sealed before key ids existed (v1) keep opening', () => {
    const legacyViaJwt = sealSecret('OLD', dev({ JWT_ACCESS_SECRET: JWT })); // exactly the old format and derivation
    it('in production, with the JWT secret unchanged, with or without a new explicit key', () => {
      expect(openSecret(legacyViaJwt, prod())).toBe('OLD');
      expect(openSecret(legacyViaJwt, prod({ MFA_ENCRYPTION_KEY: KEY_A }))).toBe('OLD');
    });
    it('a v1 row sealed under an explicit key opens with that key', () => {
      const v1Explicit = sealSecret('OLD2', dev({ MFA_ENCRYPTION_KEY: KEY_A })).replace(/^v2\.[^.]+\./, 'v1.'); // same bytes, old layout
      expect(openSecret(v1Explicit, prod({ MFA_ENCRYPTION_KEY: KEY_A }))).toBe('OLD2');
    });
    it('production never tries the constant, so a row sealed under it cannot be opened there', () => {
      const underConstant = sealSecret('OLD3', dev());
      expect(() => openSecret(underConstant, prod({ MFA_ENCRYPTION_KEY: KEY_A }))).toThrow(/could not be opened/);
    });
    it('after the JWT secret changes the legacy row is unreadable, which is why it must be resealed under an explicit key first', () => {
      expect(() => openSecret(legacyViaJwt, { ...prod({ MFA_ENCRYPTION_KEY: KEY_A }), JWT_ACCESS_SECRET: 'rotated-jwt-secret-value-xyz' })).toThrow(/could not be opened/);
    });
  });

  describe('rotation', () => {
    it('opens data sealed under the previous key and recognises it as old', () => {
      const sealedA = sealSecret('SEED', prod({ MFA_ENCRYPTION_KEY: KEY_A }));
      const rotated = prod({ MFA_ENCRYPTION_KEY: KEY_B, MFA_ENCRYPTION_KEY_PREVIOUS: KEY_A });
      expect(openSecret(sealedA, rotated)).toBe('SEED');
      expect(needsReseal(sealedA, rotated)).toBe(true);
      const resealed = resealSecret(sealedA, rotated);
      expect(resealed.startsWith(`v2.${secretKeyId(KEY_B, 'mfa')}.`)).toBe(true);
      expect(needsReseal(resealed, rotated)).toBe(false);
      // and after the old key is removed, only the resealed copy still opens
      const after = prod({ MFA_ENCRYPTION_KEY: KEY_B });
      expect(openSecret(resealed, after)).toBe('SEED');
      expect(() => openSecret(sealedA, after)).toThrow(/No mfa encryption key with id/);
    });
    it('accepts several previous keys', () => {
      const old1 = sealSecret('S', prod({ MFA_ENCRYPTION_KEY: KEY_A }));
      const env = prod({ MFA_ENCRYPTION_KEY: 'c'.repeat(40), MFA_ENCRYPTION_KEY_PREVIOUS: `${KEY_B} , ${KEY_A}` });
      expect(openSecret(old1, env)).toBe('S');
    });
    it('a legacy row needs resealing once an explicit key exists, and not before', () => {
      const legacy = sealSecret('L', dev({ JWT_ACCESS_SECRET: JWT }));
      expect(needsReseal(legacy, dev({ JWT_ACCESS_SECRET: JWT }))).toBe(false);
      const env = prod({ MFA_ENCRYPTION_KEY: KEY_A });
      expect(needsReseal(legacy, env)).toBe(true);
      expect(openSecret(resealSecret(legacy, env), env)).toBe('L');
    });
  });

  it('the two scopes use different keys, so one cannot open the other', () => {
    const env = prod({ MFA_ENCRYPTION_KEY: KEY_A, INTEGRATIONS_ENCRYPTION_KEY: KEY_A });
    const mfa = sealSecret('S', env, 'mfa');
    expect(() => openSecret(mfa, env, 'integrations')).toThrow(/No integrations encryption key with id/);
  });

  it('tampering, truncation and garbage are rejected, never decoded', () => {
    const env = prod({ MFA_ENCRYPTION_KEY: KEY_A });
    const sealed = sealSecret('SEED', env);
    const parts = sealed.split('.');
    const flipped = [...parts.slice(0, 4), Buffer.from(Buffer.from(parts[4], 'base64url').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64url')].join('.');
    expect(() => openSecret(flipped, env)).toThrow();
    expect(() => openSecret(parts.slice(0, 4).join('.'), env)).toThrow(/Unrecognised/);
    expect(() => openSecret('v3.a.b.c.d', env)).toThrow(/Unrecognised/);
    expect(() => openSecret('', env)).toThrow(/Unrecognised/);
  });
});
