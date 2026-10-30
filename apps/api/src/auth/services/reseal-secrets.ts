import { eq, isNotNull } from 'drizzle-orm';
import * as schema from '../../database/schema';
import { needsReseal, openSecret, sealSecret, type SecretScope } from './secret-box.util';

/**
 * Rewrites stored secrets under the current explicit encryption key: rows in the old format (key derived from the JWT secret) and rows sealed
 * under a previous key. Run it after setting MFA_ENCRYPTION_KEY / INTEGRATIONS_ENCRYPTION_KEY (and the PREVIOUS variable during a rotation) and BEFORE
 * rotating the JWT secret or removing a previous key.
 *
 * It reports counts only, never a plaintext, a ciphertext or a user. By default it changes nothing. With `apply: true` it writes everything in one
 * transaction, and only if every row that needs resealing could be opened: a row that cannot be opened (its key is gone) stops it with nothing
 * written, so a rotation can never silently lose data.
 */
export type ResealTable = 'users.two_factor_secret' | 'integrations.signing_secret_enc' | 'integrations.credential_enc';

export interface IResealColumn {
  table: ResealTable;
  scope: SecretScope;
  rows: number;
  /** Rows in the old format or under a previous key. */
  needResealing: number;
  /** Rows written (0 unless applied). */
  resealed: number;
  /** Rows that need resealing but cannot be opened with any configured key. */
  unreadable: number;
}

export interface IResealReport {
  applied: boolean;
  columns: IResealColumn[];
  /** Every column is already under the current key. */
  upToDate: boolean;
  /** No row was unreadable; applying is refused unless this is true. */
  safeToApply: boolean;
}

type Db = any; // a Drizzle database or transaction (node-postgres or PGlite)
interface IWrite {
  table: ResealTable;
  id: string;
  sealed: string;
}

const WRITERS: Record<ResealTable, (tx: Db, id: string, sealed: string) => Promise<unknown>> = {
  'users.two_factor_secret': (tx, id, sealed) => tx.update(schema.users).set({ twoFactorSecret: sealed }).where(eq(schema.users.id, id)),
  'integrations.signing_secret_enc': (tx, id, sealed) => tx.update(schema.integrations).set({ signingSecretEnc: sealed }).where(eq(schema.integrations.id, id)),
  'integrations.credential_enc': (tx, id, sealed) => tx.update(schema.integrations).set({ credentialEnc: sealed }).where(eq(schema.integrations.id, id)),
};

export async function resealAll(db: Db, env: NodeJS.ProcessEnv = process.env, opts: { apply?: boolean } = {}): Promise<IResealReport> {
  const columns: IResealColumn[] = [];
  const writes: IWrite[] = [];

  const scan = (table: ResealTable, scope: SecretScope, rows: Array<{ id: string; value: string }>) => {
    const col: IResealColumn = { table, scope, rows: rows.length, needResealing: 0, resealed: 0, unreadable: 0 };
    for (const r of rows) {
      if (!needsReseal(r.value, env, scope)) continue;
      col.needResealing++;
      try {
        writes.push({ table, id: r.id, sealed: sealSecret(openSecret(r.value, env, scope), env, scope) });
      } catch {
        col.unreadable++;
      }
    }
    columns.push(col);
  };

  scan('users.two_factor_secret', 'mfa', await db.select({ id: schema.users.id, value: schema.users.twoFactorSecret }).from(schema.users).where(isNotNull(schema.users.twoFactorSecret)));
  const ints: Array<{ id: string; signing: string; credential: string | null }> = await db
    .select({ id: schema.integrations.id, signing: schema.integrations.signingSecretEnc, credential: schema.integrations.credentialEnc })
    .from(schema.integrations);
  scan('integrations.signing_secret_enc', 'integrations', ints.map((r) => ({ id: r.id, value: r.signing })));
  scan('integrations.credential_enc', 'integrations', ints.filter((r) => r.credential).map((r) => ({ id: r.id, value: r.credential as string })));

  const safeToApply = columns.every((c) => c.unreadable === 0);
  const report: IResealReport = { applied: false, columns, upToDate: columns.every((c) => c.needResealing === 0), safeToApply };

  if (opts.apply === true && safeToApply && writes.length) {
    await db.transaction(async (tx: Db) => {
      for (const w of writes) await WRITERS[w.table](tx, w.id, w.sealed);
    });
    for (const c of columns) c.resealed = c.needResealing;
    report.applied = true;
  }
  return report;
}
