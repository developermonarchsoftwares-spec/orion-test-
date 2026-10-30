/**
 * Rewrites stored secrets (MFA seeds, integration credentials and signing secrets) under the current explicit encryption keys.
 *
 *   npm run db:reseal-secrets                 DRY RUN: counts how many rows are in the old format or under a previous key. Writes nothing.
 *   npm run db:reseal-secrets -- --apply      writes, in one transaction, and only if every such row can be opened
 *
 * Applying needs RESEAL_CONFIRM_DATABASE set to the exact name of the target database, so a wrong DATABASE_URL cannot be changed by accident.
 * Take a backup first (npm run db:backup for the local database): the old ciphertext is replaced, and a lost key cannot be recovered.
 * Order for a key rotation: set the new key and the old one as *_PREVIOUS, deploy, run this, check it reports up to date, THEN remove the old key.
 * It prints counts only, never a secret, a user or a ciphertext.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { resealAll } from '../src/auth/services/reseal-secrets';
import { describeTarget, parseDbTarget } from '../src/database/db-guard';
import * as schema from '../src/database/schema';
import { verifiedConnection } from '../src/database/tls';

async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  const target = parseDbTarget(url);
  console.log(`Target: ${describeTarget(target)}`);
  if (apply && process.env.RESEAL_CONFIRM_DATABASE !== target.database) {
    console.error(`Refusing to write: set RESEAL_CONFIRM_DATABASE=${target.database} to confirm this is the database you mean.`);
    process.exit(2);
  }

  const pool = new Pool({ ...verifiedConnection(url as string) });
  try {
    const report = await resealAll(drizzle(pool, { schema }), process.env, { apply });
    for (const c of report.columns) {
      console.log(`${c.table.padEnd(34)} rows ${String(c.rows).padStart(6)}  need resealing ${String(c.needResealing).padStart(6)}  unreadable ${String(c.unreadable).padStart(4)}  written ${String(c.resealed).padStart(6)}`);
    }
    if (!report.safeToApply) {
      console.error('\nSome rows cannot be opened with any configured key (set the old key in the *_PREVIOUS variable). Nothing was written.');
      process.exit(1);
    }
    if (report.upToDate) console.log('\nEverything is already under the current key.');
    else if (report.applied) console.log('\nDone. Run again to confirm it now reports up to date.');
    else console.log('\nDry run: nothing was written. Re-run with --apply (and RESEAL_CONFIRM_DATABASE) to rewrite these rows.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`Failed: ${(e as Error)?.name ?? 'Error'}`);
  process.exit(1);
});
