import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { environmentValidationSchema } from '../env.validation';
import { isPlaceholderSecret, resolveSecret } from '../secrets';

const REAL = 'f3a91c07d5e24b86a0c1d9e7b25f4a63';
const PROD = { NODE_ENV: 'production', JWT_ACCESS_SECRET: REAL, JWT_REFRESH_SECRET: REAL.split('').reverse().join(''), DATABASE_URL: 'postgresql://u:p@db.example:5432/orion', MFA_ENCRYPTION_KEY: 'm'.repeat(40) + 'k1', INTEGRATIONS_ENCRYPTION_KEY: 'i'.repeat(40) + 'k2', TURNSTILE_SECRET_KEY: 'turnstile-secret-for-tests' };
const check = (env: Record<string, string>) => environmentValidationSchema.validate(env, { allowUnknown: true, abortEarly: false });
const ROOT = path.resolve(__dirname, '../../../../..');
const JWT_LINE = /^\s+JWT_(ACCESS|REFRESH)_SECRET:/;
const composeValues = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((l) => JWT_LINE.test(l))
    .map((l) => l.replace(/^[^:]+:\s*/, '').replace(/^['"]|['"]$/g, '').trim());

describe('placeholder and published secrets are refused in production', () => {
  it.each(['orion_example_value_long_enough_0123456789', 'your_secret_value_long_enough_here', 'generate_a_random_value_here_0123', 'changeme_changeme_changeme'])(
    'rejects %s',
    (value) => {
      expect(isPlaceholderSecret(value)).toBe(true);
      expect(check({ ...PROD, JWT_ACCESS_SECRET: value }).error?.message).toContain('JWT_ACCESS_SECRET');
      expect(check({ ...PROD, JWT_REFRESH_SECRET: value }).error?.message).toContain('JWT_REFRESH_SECRET');
      expect(() => resolveSecret('JWT_ACCESS_SECRET', { NODE_ENV: 'production', JWT_ACCESS_SECRET: value } as NodeJS.ProcessEnv)).toThrow(/placeholder/);
    },
  );

  it('accepts a real-looking secret and does not touch non-production environments', () => {
    expect(isPlaceholderSecret(REAL)).toBe(false);
    expect(check(PROD).error).toBeUndefined();
    expect(resolveSecret('JWT_ACCESS_SECRET', { NODE_ENV: 'production', JWT_ACCESS_SECRET: REAL } as NodeJS.ProcessEnv)).toBe(REAL);
    expect(check({ NODE_ENV: 'development', JWT_ACCESS_SECRET: 'orion_example_value_long_enough_0123456789' }).error).toBeUndefined();
  });

  it('the JWT values in the committed example files are all caught, so copying an example to production cannot start the API', () => {
    for (const file of ['apps/api/.env.example', '.env.production.example']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of text.matchAll(/^JWT_(?:ACCESS|REFRESH)_SECRET=(.*)$/gm)) {
        const value = m[1].trim().replace(/^["']|["']$/g, '');
        if (value) expect({ file, placeholder: isPlaceholderSecret(value) }).toEqual({ file, placeholder: true });
      }
    }
  });

  // The two signing secrets that were committed as literals in docker-compose.yml (public in git history).
  const committedCompose = (() => {
    try {
      return execSync('git show 03075bd:docker-compose.yml', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch {
      return null; // shallow clone or history unavailable
    }
  })();

  (committedCompose ? it : it.skip)('the secrets committed in docker-compose.yml (commit 03075bd) are refused in production', () => {
    const values = composeValues(committedCompose as string);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect({ refused: isPlaceholderSecret(value) }).toEqual({ refused: true });
      expect(check({ ...PROD, JWT_ACCESS_SECRET: value }).error?.message).toContain('JWT_ACCESS_SECRET');
    }
  });

  it('the current docker-compose.yml carries no literal signing secrets (they must be supplied by the operator)', () => {
    const values = composeValues(fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8'));
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect({ required: /^\$\{[A-Z_]+:\?/.test(value) }).toEqual({ required: true });
  });
});
