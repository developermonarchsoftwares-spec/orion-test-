import * as fs from 'fs';
import * as path from 'path';

/**
 * Phase 14: deployment files are code too. These tests read the repository's own deployment configuration and fail if a hardening step is
 * removed. They check configuration TEXT; they do not build an image or run CI (Docker was not available when they were written).
 */
const root = path.resolve(__dirname, '../../../../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

/** Does a .dockerignore pattern list exclude this path? (the subset of Docker's rules these files use: ** globs, ! re-includes) */
function ignored(rules: string[], file: string): boolean {
  let result = false;
  for (const raw of rules) {
    const negate = raw.startsWith('!');
    const rule = negate ? raw.slice(1) : raw;
    // tokens first, so the stars produced for ** are not rewritten by the single-star rule
    const esc = rule.replace(/[.+^${}()|[\]\\]/g, (c) => String.fromCharCode(92) + c);
    const body = esc
      .split("**/").join("<<GS>>")
      .split("**").join("<<GG>>")
      .split("*").join("[^/]*")
      .split("?").join("[^/]")
      .split("<<GS>>").join("(?:.*/)?")
      .split("<<GG>>").join(".*");
    const re = new RegExp('^' + body + '(?:/.*)?$');
    if (re.test(file)) result = !negate;
  }
  return result;
}

describe('Docker build context (Phase 14)', () => {
  const rules = read('.dockerignore')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  it('keeps local environment files, keys and certificates out of every image layer, but keeps the example templates', () => {
    for (const f of ['apps/api/.env', 'ownus/.env', 'ownus/.env.local', 'apps/api/.env.production', '.env', 'keys/server.pem', 'apps/api/id_rsa', 'ownus/.npmrc', 'apps/api/secret.key']) {
      expect(ignored(rules, f)).toBe(true);
    }
    for (const f of ['apps/api/.env.example', '.env.production.example', 'apps/api/src/main.ts', 'ownus/src/app/page.tsx']) expect(ignored(rules, f)).toBe(false);
  });

  it('keeps build output, VCS data, dependency folders and internal documents out as well', () => {
    for (const f of ['node_modules/x/index.js', 'apps/api/dist/main.js', 'ownus/.next/server.js', '.git/config', 'docs/INCIDENT_RESPONSE.md', 'ops/security/scan-secrets.mjs']) expect(ignored(rules, f)).toBe(true);
  });

  it.each(['apps/api/Dockerfile', 'ownus/Dockerfile'])('%s runs as a non-root user in production mode and never copies an env file', (file) => {
    const d = read(file);
    expect(d).toMatch(/^USER node$/m);
    expect(d).toMatch(/ENV NODE_ENV=production/);
    expect(d).not.toMatch(/COPY[^\n]*\.env(?!\.example)/);
    expect(d).not.toMatch(/ENV [A-Z_]*(SECRET|PASSWORD|TOKEN|KEY)[A-Z_]*=/);
  });
});

describe('CI workflow (Phase 14)', () => {
  const ci = read('.github/workflows/test.yml');
  it('gives the job token read-only access to the repository', () => {
    expect(ci).toMatch(/^permissions:\n  contents: read$/m);
  });
  it('fails the build on a high or critical production dependency advisory, for the API and the web app', () => {
    expect(ci).toMatch(/npm audit --omit=dev --audit-level=high/);
    expect(ci).toMatch(/npm --prefix ownus audit --omit=dev --audit-level=high/);
  });
  it('builds the shared package, the API and the web app, and still runs the secret scan, type checks and test classes', () => {
    for (const s of ['packages/shared run build', 'apps/api run build', 'ownus run build', 'scan-secrets.mjs', 'tsc --noEmit -p apps/api/tsconfig.json', 'npm run test:e2e']) expect(ci).toContain(s);
  });
});

describe('web configuration (Phase 14)', () => {
  const next = read('ownus/next.config.ts');
  it('does not advertise the framework and does not publish browser source maps', () => {
    expect(next).toMatch(/poweredByHeader:\s*false/);
    expect(next).toMatch(/productionBrowserSourceMaps:\s*false/);
  });
  it('takes its headers from the tested policy module, not an inline copy', () => {
    expect(next).toMatch(/from "\.\/src\/lib\/security-headers"/);
    expect(next).not.toMatch(/Strict-Transport-Security/);
  });
  it('browser-visible environment names (NEXT_PUBLIC_*) are limited to two public URLs and the CAPTCHA site key', () => {
    const names = new Set<string>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && !p.includes('__tests__')) for (const m of read(p).matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) names.add(m[0]);
      }
    };
    walk('ownus/src');
    // the Turnstile site key is public by design (it is shipped to every browser to draw the widget); the secret half, TURNSTILE_SECRET_KEY, never carries the prefix
    expect([...names].sort()).toEqual(['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY']);
    for (const n of names) if (n !== 'NEXT_PUBLIC_TURNSTILE_SITE_KEY') expect(n).not.toMatch(/SECRET|KEY|TOKEN|PASSWORD|DATABASE/);
  });
});

describe('API production bootstrap (Phase 14)', () => {
  const main = read('apps/api/src/main.ts');
  it('mounts the shared header chain and CORS options, and never the wildcard', () => {
    expect(main).toContain('securityMiddleware()');
    expect(main).toContain('apiCorsOptions(corsOrigins)');
    expect(main).not.toMatch(/origin:\s*(true|'\*'|"\*")/);
  });
  it('shows the API explorer only outside production unless it is switched on explicitly, and binds to all interfaces only in production', () => {
    expect(main).toMatch(/NODE_ENV !== 'production' && process\.env\.SWAGGER_ENABLED !== 'false'/);
    expect(main).toMatch(/NODE_ENV === 'production' \? '0\.0\.0\.0' : '127\.0\.0\.1'/);
  });
  it('trusts exactly one proxy hop in production and none elsewhere', () => {
    expect(main).toMatch(/'trust proxy', process\.env\.NODE_ENV === 'production' \? 1 : false/);
  });
});
