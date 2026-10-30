import * as fs from 'fs';
import * as path from 'path';
import { environmentValidationSchema } from '../env.validation';
import { DEV_ONLY_DEFAULTS, productionOptional, productionRequired } from '../secrets';

const PROD = { NODE_ENV: 'production', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), DATABASE_URL: 'postgresql://u:p@db.example:5432/orion', MFA_ENCRYPTION_KEY: 'm'.repeat(40) + 'k1', INTEGRATIONS_ENCRYPTION_KEY: 'i'.repeat(40) + 'k2', TURNSTILE_SECRET_KEY: 'turnstile-secret-for-tests' };
const check = (env: Record<string, string>) => environmentValidationSchema.validate(env, { allowUnknown: true, abortEarly: false });

describe('Production configuration (Phase 6.18)', () => {
  it('production refuses to start without signing secrets or a database url, or with a short secret', () => {
    expect(check(PROD).error).toBeUndefined();
    for (const drop of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL']) {
      const env: Record<string, string> = { ...PROD };
      delete env[drop];
      expect(check(env).error?.message).toContain(drop);
    }
    expect(check({ ...PROD, JWT_ACCESS_SECRET: 'short' }).error?.message).toContain('JWT_ACCESS_SECRET');
  });

  it('outside production nothing is required and no value is invented by the schema', () => {
    const r = check({ NODE_ENV: 'development' });
    expect(r.error).toBeUndefined();
    expect(r.value.JWT_ACCESS_SECRET).toBeUndefined();
    expect(r.value.JWT_REFRESH_SECRET).toBeUndefined();
  });

  it('Typesense: required and never the development key in production when it is the search provider; ignored otherwise', () => {
    expect(check({ ...PROD, SEARCH_PROVIDER: 'typesense' }).error?.message).toContain('TYPESENSE_API_KEY');
    expect(check({ ...PROD, SEARCH_PROVIDER: 'typesense', TYPESENSE_API_KEY: DEV_ONLY_DEFAULTS.typesenseApiKey }).error?.message).toContain('TYPESENSE_API_KEY');
    expect(check({ ...PROD, SEARCH_PROVIDER: 'typesense', TYPESENSE_API_KEY: 'a-real-typesense-key-0123456789' }).error).toBeUndefined();
    expect(check({ ...PROD, SEARCH_PROVIDER: 'postgres' }).error).toBeUndefined();
    expect(check({ NODE_ENV: 'development', SEARCH_PROVIDER: 'typesense' }).error).toBeUndefined();
  });

  it('object storage: the local MinIO credentials are refused in production; a missing value leaves storage unconfigured', () => {
    expect(check({ ...PROD, STORAGE_ACCESS_KEY: 'minioadmin' }).error?.message).toContain('STORAGE_ACCESS_KEY');
    expect(check({ ...PROD, STORAGE_SECRET_KEY: 'minioadmin' }).error?.message).toContain('STORAGE_SECRET_KEY');
    expect(check({ ...PROD, STORAGE_ACCESS_KEY: 'AKIAREALKEY', STORAGE_SECRET_KEY: 'a-real-storage-secret' }).error).toBeUndefined();
    expect(check({ ...PROD }).error).toBeUndefined();
    expect(check({ NODE_ENV: 'development', STORAGE_ACCESS_KEY: 'minioadmin' }).error).toBeUndefined();
  });

  it('productionRequired / productionOptional: development convenience only, explicit values in production, the dev value refused', () => {
    expect(productionRequired('K', 'dev', { NODE_ENV: 'development' } as any)).toBe('dev');
    expect(productionRequired('K', 'dev', { NODE_ENV: 'development', K: 'real' } as any)).toBe('real');
    expect(() => productionRequired('K', 'dev', { NODE_ENV: 'production' } as any)).toThrow(/must be set/);
    expect(() => productionRequired('K', 'dev', { NODE_ENV: 'production', K: 'dev' } as any)).toThrow(/development value/);
    expect(productionRequired('K', 'dev', { NODE_ENV: 'production', K: 'real' } as any)).toBe('real');
    expect(productionOptional('K', 'dev', { NODE_ENV: 'production' } as any)).toBeUndefined();
    expect(() => productionOptional('K', 'dev', { NODE_ENV: 'production', K: 'dev' } as any)).toThrow();
    expect(productionOptional('K', 'dev', { NODE_ENV: 'test' } as any)).toBe('dev');
  });

  it('the only source files that contain a local-development credential are the helper and the local example files', () => {
    const root = path.resolve(__dirname, '../..');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    const offenders = walk(root).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && /xyz123_orion_typesense_master_key|minioadmin|postgres:postgres@/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f).replace(/\\/g, '/'));
    expect(offenders.sort()).toEqual(['config/env.validation.ts', 'config/secrets.ts', 'database/migrate.ts', 'database/seed.ts']);
  });

  it('the admin OTP fixed code is only possible under NODE_ENV=test on a local database', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../auth/admin-auth.controller.ts'), 'utf8');
    expect(text).not.toMatch(/NODE_ENV === 'production'/);
    // Stricter than development-or-test: only NODE_ENV=test on a local database (fixedOtpAllowed), used by both OTP paths.
    expect(text).toMatch(/process\.env\.NODE_ENV === 'test' && isLocalDbUrl\(process\.env\.DATABASE_URL\)/);
    expect((text.match(/fixedOtpAllowed\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(text).not.toMatch(/\['development', 'test'\]\.includes/);
  });
});
