import * as crypto from 'crypto';

/**
 * AES-256-GCM envelope for secrets stored at rest: the MFA TOTP seed ('mfa') and integration credentials and signing secrets ('integrations').
 *
 * Keys. Each scope has its own explicit key, MFA_ENCRYPTION_KEY / INTEGRATIONS_ENCRYPTION_KEY (at least 32 characters).
 *   - In PRODUCTION an explicit key is required to seal. There is no fallback: a key derived from another secret (the JWT signing secret) or from
 *     a constant in the source is never used to protect new data there. The application also refuses to start without the keys (env.validation.ts).
 *   - Outside production, with no explicit key, the key is derived from JWT_ACCESS_SECRET, and failing that from a constant. That keeps local
 *     development and the test suites working without setup and is NOT secure; it logs a warning once.
 *
 * Formats. New data is written as  v2.<keyId>.<iv>.<tag>.<ciphertext>  (base64url). The key id is a short fingerprint of the key, so a rotated
 * key is recognised instead of guessed. Data written before this change is  v1.<iv>.<tag>.<ciphertext>  (key derived from the explicit key if set,
 * else from JWT_ACCESS_SECRET, else the constant); it is still opened, so no existing row becomes unreadable, and is rewritten under the current
 * explicit key by `resealSecret` (see scripts/reseal-secrets.ts).
 *
 * Rotation. Put the new key in MFA_ENCRYPTION_KEY and the old one in MFA_ENCRYPTION_KEY_PREVIOUS (comma separated for several), deploy, run the
 * reseal script, then remove the previous key. Rotating the JWT signing secret no longer affects data sealed under an explicit key.
 */
export type SecretScope = 'mfa' | 'integrations';

export const MIN_ENCRYPTION_KEY_LENGTH = 32;

const KEY_VAR: Record<SecretScope, string> = { mfa: 'MFA_ENCRYPTION_KEY', integrations: 'INTEGRATIONS_ENCRYPTION_KEY' };
const PREVIOUS_VAR: Record<SecretScope, string> = { mfa: 'MFA_ENCRYPTION_KEY_PREVIOUS', integrations: 'INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS' };

const clean = (v: string | undefined): string => (v ?? '').trim();
const isProduction = (env: NodeJS.ProcessEnv): boolean => clean(env.NODE_ENV) === 'production';
const label = (scope: SecretScope): string => (scope === 'mfa' ? 'orion:mfa-secret' : `orion:${scope}-secret`);
const constantBase = (scope: SecretScope): string => `orion-${scope}`;

/** Same derivation as the original (v1) format, so data written before key ids existed still opens. */
const deriveKey = (base: string, scope: SecretScope): Buffer => crypto.createHmac('sha256', base).update(label(scope)).digest();

/** A short, non-secret fingerprint that names a key without revealing it. */
export const secretKeyId = (base: string, scope: SecretScope): string => crypto.createHash('sha256').update(`orion:kid:${scope}:${base}`).digest('hex').slice(0, 12);

interface IExplicitKeys {
  current: string | null;
  previous: string[];
}

function explicitKeys(env: NodeJS.ProcessEnv, scope: SecretScope): IExplicitKeys {
  const check = (name: string, value: string) => {
    if (value.length < MIN_ENCRYPTION_KEY_LENGTH) throw new Error(`${name} must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters`);
    return value;
  };
  const current = clean(env[KEY_VAR[scope]]);
  const previous = clean(env[PREVIOUS_VAR[scope]])
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => check(PREVIOUS_VAR[scope], v));
  return { current: current ? check(KEY_VAR[scope], current) : null, previous };
}

let warnedDev = false;
const warnDevKey = (scope: SecretScope) => {
  if (warnedDev) return;
  warnedDev = true;
  console.warn(`[secret-box] ${KEY_VAR[scope]} is not set: sealing with a development-only key. This is not secure and is refused in production.`);
};

const encrypt = (key: Buffer, plain: string) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), enc: enc.toString('base64url') };
};

const decrypt = (key: Buffer, iv: string, tag: string, enc: string): string => {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
};

export function sealSecret(plain: string, env: NodeJS.ProcessEnv = process.env, scope: SecretScope = 'mfa'): string {
  const { current } = explicitKeys(env, scope);
  if (current) {
    const { iv, tag, enc } = encrypt(deriveKey(current, scope), plain);
    return ['v2', secretKeyId(current, scope), iv, tag, enc].join('.');
  }
  if (isProduction(env)) {
    throw new Error(`${KEY_VAR[scope]} must be set in production: stored secrets are never sealed with a key derived from another secret`);
  }
  warnDevKey(scope);
  const { iv, tag, enc } = encrypt(deriveKey(clean(env.JWT_ACCESS_SECRET) || constantBase(scope), scope), plain);
  return ['v1', iv, tag, enc].join('.');
}

export function openSecret(sealed: string, env: NodeJS.ProcessEnv = process.env, scope: SecretScope = 'mfa'): string {
  const parts = sealed.split('.');
  const { current, previous } = explicitKeys(env, scope);
  const configured = [current, ...previous].filter((k): k is string => !!k);

  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, iv, tag, enc] = parts;
    const base = configured.find((k) => secretKeyId(k, scope) === kid);
    if (!base) throw new Error(`No ${scope} encryption key with id ${kid} is configured (set it in ${KEY_VAR[scope]} or ${PREVIOUS_VAR[scope]})`);
    return decrypt(deriveKey(base, scope), iv, tag, enc);
  }

  if (parts[0] === 'v1' && parts.length === 4) {
    const [, iv, tag, enc] = parts;
    // legacy data: the key was the explicit one, else derived from the JWT secret, else (never in production) the constant
    const candidates = [...configured, clean(env.JWT_ACCESS_SECRET), ...(isProduction(env) ? [] : [constantBase(scope)])].filter(Boolean);
    for (const base of new Set(candidates)) {
      try {
        return decrypt(deriveKey(base, scope), iv, tag, enc);
      } catch {
        /* wrong key for this row: GCM authentication fails; try the next one */
      }
    }
    throw new Error('Sealed secret could not be opened with any configured key');
  }

  throw new Error('Unrecognised sealed secret');
}

/** True when the value should be rewritten under the current explicit key: legacy format, or sealed under a previous key. False when no explicit key is set. */
export function needsReseal(sealed: string, env: NodeJS.ProcessEnv = process.env, scope: SecretScope = 'mfa'): boolean {
  const { current } = explicitKeys(env, scope);
  if (!current) return false;
  const parts = sealed.split('.');
  if (parts[0] === 'v2') return parts[1] !== secretKeyId(current, scope);
  return parts[0] === 'v1';
}

/** Opens a value with whatever key it was sealed under and seals it again under the current explicit key. */
export function resealSecret(sealed: string, env: NodeJS.ProcessEnv = process.env, scope: SecretScope = 'mfa'): string {
  return sealSecret(openSecret(sealed, env, scope), env, scope);
}
