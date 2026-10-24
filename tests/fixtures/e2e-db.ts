/**
 * Test hygiene for the disposable `orion_e2e` database (never `orion_db`).
 *
 * Sign-up is rate limited per network address (20 codes per hour), and every browser test signs up its own user from the same address, so a
 * full run, or two runs within an hour, would hit the limit for reasons that have nothing to do with what is being tested. The product limit
 * stays as it is; the tests instead clear finished challenges from the scratch database before they request a new code. Codes younger than
 * 20 seconds are kept, so a code that is still being used is never removed.
 */
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config({ path: path.resolve(__dirname, '..', '..', 'apps', 'api', '.env') });

export const E2E_DATABASE = 'orion_e2e';

function e2eConnectionString(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set in apps/api/.env (it supplies the local server credentials).');
  const url = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) throw new Error('The browser tests only touch a local database server.');
  url.pathname = `/${E2E_DATABASE}`; // the database name is always forced here: this helper cannot reach orion_db
  return url.toString();
}

/** Removes sign-up code challenges older than 20 seconds from orion_e2e so the per-address hourly limit never accumulates across tests. */
export async function clearOldOtpChallenges(): Promise<number> {
  const client = new Client({ connectionString: e2eConnectionString() });
  await client.connect();
  try {
    const res = await client.query(`DELETE FROM email_otp_challenges WHERE created_at < now() - interval '20 seconds'`);
    return res.rowCount ?? 0;
  } finally {
    await client.end();
  }
}
