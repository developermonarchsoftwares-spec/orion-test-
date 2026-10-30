import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as path from 'path';
import * as schema from '../../database/schema';
import { resealAll } from '../services/reseal-secrets';
import { openSecret, sealSecret } from '../services/secret-box.util';

/** Re-encryption of stored secrets on the real schema: a dry run writes nothing, applying is all-or-nothing, and a key rotation ends with nothing left under the old key. */
const MIGRATIONS = path.resolve(__dirname, '../../database/migrations');
const JWT = 'jwt-access-secret-used-by-the-old-format';
const KEY_A = 'a'.repeat(32) + 'KEY-A-mfa';
const KEY_B = 'b'.repeat(32) + 'KEY-B-mfa';
const KEY_I = 'i'.repeat(40) + 'KEY-I-integrations';
const dev = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'development', JWT_ACCESS_SECRET: JWT, ...extra }) as NodeJS.ProcessEnv;
const prod = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'production', JWT_ACCESS_SECRET: JWT, ...extra }) as NodeJS.ProcessEnv;

describe('reseal stored secrets', () => {
  let client: PGlite;
  let db: any;

  beforeAll(async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
  });
  afterAll(async () => client.close());
  beforeEach(async () => {
    await client.exec('TRUNCATE users CASCADE');
  });

  const user = async (email: string, twoFactorSecret: string | null) =>
    ((await db.insert(schema.users).values({ email, firstName: 'T', lastName: 'U', twoFactorSecret }).returning()) as any[])[0];
  const integration = async (userId: string, signing: string, credential: string | null) =>
    ((await db.insert(schema.integrations).values({ userId, type: 'WEBHOOK', name: 'hook', signingSecretEnc: signing, credentialEnc: credential }).returning()) as any[])[0];
  const mfaOf = async (id: string) => ((await db.select().from(schema.users).where(eq(schema.users.id, id))) as any[])[0].twoFactorSecret as string;

  /** Rows as they exist today: written before key ids existed, under the JWT-derived key. */
  const legacy = async () => {
    const u = await user('legacy@example.com', sealSecret('TOTP-LEGACY', dev()));
    const i = await integration(u.id, sealSecret('SIGNING-LEGACY', dev(), 'integrations'), sealSecret('CRM-TOKEN', dev(), 'integrations'));
    return { u, i };
  };
  const KEYS = { MFA_ENCRYPTION_KEY: KEY_A, INTEGRATIONS_ENCRYPTION_KEY: KEY_I };

  it('a dry run counts what needs resealing and writes nothing', async () => {
    const { u, i } = await legacy();
    const before = await mfaOf(u.id);
    const report = await resealAll(db, prod(KEYS));
    expect(report).toMatchObject({ applied: false, upToDate: false, safeToApply: true });
    expect(report.columns.map((c) => [c.table, c.rows, c.needResealing, c.resealed])).toEqual([
      ['users.two_factor_secret', 1, 1, 0],
      ['integrations.signing_secret_enc', 1, 1, 0],
      ['integrations.credential_enc', 1, 1, 0],
    ]);
    expect(await mfaOf(u.id)).toBe(before);
    expect(((await db.select().from(schema.integrations).where(eq(schema.integrations.id, i.id))) as any[])[0].signingSecretEnc).toBe(i.signingSecretEnc);
  });

  it('applying rewrites every row under the explicit keys; the values still open, and a second run finds nothing to do', async () => {
    const { u, i } = await legacy();
    const report = await resealAll(db, prod(KEYS), { apply: true });
    expect(report).toMatchObject({ applied: true, safeToApply: true });
    expect(report.columns.map((c) => c.resealed)).toEqual([1, 1, 1]);
    const mfa = await mfaOf(u.id);
    expect(mfa.startsWith('v2.')).toBe(true);
    expect(openSecret(mfa, prod(KEYS))).toBe('TOTP-LEGACY');
    const row = ((await db.select().from(schema.integrations).where(eq(schema.integrations.id, i.id))) as any[])[0];
    expect(openSecret(row.signingSecretEnc, prod(KEYS), 'integrations')).toBe('SIGNING-LEGACY');
    expect(openSecret(row.credentialEnc, prod(KEYS), 'integrations')).toBe('CRM-TOKEN');
    // they no longer depend on the JWT secret
    expect(openSecret(mfa, { ...prod(KEYS), JWT_ACCESS_SECRET: 'rotated-jwt-secret-value-xyz' })).toBe('TOTP-LEGACY');
    expect(await resealAll(db, prod(KEYS), { apply: true })).toMatchObject({ applied: false, upToDate: true });
  });

  it('leaves rows without a secret alone (no 2FA, no CRM credential)', async () => {
    const u = await user('plain@example.com', null);
    await integration(u.id, sealSecret('S', dev(), 'integrations'), null);
    const report = await resealAll(db, prod(KEYS), { apply: true });
    expect(report.columns.map((c) => [c.table, c.rows])).toEqual([['users.two_factor_secret', 0], ['integrations.signing_secret_enc', 1], ['integrations.credential_enc', 0]]);
    expect(report.columns.map((c) => c.resealed)).toEqual([0, 1, 0]);
  });

  it('with no explicit key configured there is nothing to reseal into, so nothing is touched', async () => {
    const { u } = await legacy();
    const before = await mfaOf(u.id);
    expect(await resealAll(db, dev(), { apply: true })).toMatchObject({ applied: false, upToDate: true });
    expect(await mfaOf(u.id)).toBe(before);
  });

  it('is all-or-nothing: one row that cannot be opened stops everything, and nothing is written', async () => {
    const { u } = await legacy();
    const orphan = await user('orphan@example.com', sealSecret('LOST', prod({ MFA_ENCRYPTION_KEY: KEY_B }))); // sealed under a key that is no longer configured
    const before = [await mfaOf(u.id), await mfaOf(orphan.id)];
    const report = await resealAll(db, prod(KEYS), { apply: true });
    expect(report).toMatchObject({ applied: false, safeToApply: false });
    expect(report.columns[0]).toMatchObject({ needResealing: 2, unreadable: 1, resealed: 0 });
    expect([await mfaOf(u.id), await mfaOf(orphan.id)]).toEqual(before);
  });

  it('a key rotation: seal under A, rotate to B with A as previous, reseal, then drop A', async () => {
    const u = await user('rot@example.com', sealSecret('SEED', prod({ MFA_ENCRYPTION_KEY: KEY_A })));
    const rotated = prod({ MFA_ENCRYPTION_KEY: KEY_B, MFA_ENCRYPTION_KEY_PREVIOUS: KEY_A, INTEGRATIONS_ENCRYPTION_KEY: KEY_I });
    expect((await resealAll(db, rotated)).columns[0].needResealing).toBe(1);
    await resealAll(db, rotated, { apply: true });
    const afterDroppingA = prod({ MFA_ENCRYPTION_KEY: KEY_B, INTEGRATIONS_ENCRYPTION_KEY: KEY_I });
    expect(openSecret(await mfaOf(u.id), afterDroppingA)).toBe('SEED');
  });

  it('the report holds counts only: no plaintext, no ciphertext, no e-mail address', async () => {
    const { u } = await legacy();
    const text = JSON.stringify(await resealAll(db, prod(KEYS), { apply: true }));
    for (const secret of ['TOTP-LEGACY', 'SIGNING-LEGACY', 'CRM-TOKEN', 'legacy@example.com', await mfaOf(u.id)]) expect(text).not.toContain(secret);
  });
});
