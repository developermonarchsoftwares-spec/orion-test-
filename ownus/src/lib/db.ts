import { Pool, type PoolConfig } from 'pg';

let pool: Pool | null = null;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * Pool settings for the gateway's direct database access.
 *   - The server certificate is always verified for a remote database; only a local database may run without TLS. The connection
 *     string's own sslmode is removed, because pg lets it override the explicit setting (for example sslmode=no-verify).
 *   - GATEWAY_DATABASE_URL, when set, takes precedence over DATABASE_URL so the gateway can run with its own least-privilege role
 *     without any code change. It falls back to DATABASE_URL for existing deployments.
 *   - Statements are bounded so a stuck query cannot hold a request open indefinitely.
 */
export function buildPoolConfig(env: Record<string, string | undefined> = process.env): PoolConfig | null {
  let dbUrl = (env.GATEWAY_DATABASE_URL || env.DATABASE_URL)?.trim();
  if (!dbUrl) return null;
  if (dbUrl.includes('-pooler.')) {
    dbUrl = dbUrl.replace('-pooler.', '.');
  }
  let connectionString = dbUrl;
  try {
    const parsed = new URL(dbUrl);
    for (const key of ['sslmode', 'ssl', 'uselibpqcompat']) parsed.searchParams.delete(key);
    connectionString = parsed.toString();
  } catch {
    // left for the driver to reject; TLS stays verified
  }
  return {
    connectionString,
    ssl: isLocalDatabaseUrl(dbUrl) ? false : { rejectUnauthorized: true },
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000, // a suspended Neon compute needs a few seconds to wake
    statement_timeout: 20000,
  };
}

export function getDbPool(): Pool | null {
  const config = buildPoolConfig();
  if (!config) return null;
  if (!pool) {
    pool = new Pool(config);
    pool.on('error', (err) => {
      console.error('[Database Pool Error]', err.message);
    });
  }
  return pool;
}

export async function queryDb<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const p = getDbPool();
  if (!p) return [];
  try {
    const res = await p.query(text, params);
    return res.rows;
  } catch (err) {
    logDbError(err);
    return [];
  }
}

/** What identifies a failed statement, without its values: the server error code, table, column and constraint. A driver error also carries the offending row values (`detail`), which are customer data. */
function logDbError(err: unknown) {
  const e = err as { code?: string; table?: string; column?: string; constraint?: string; routine?: string } | null;
  console.error('[Database Query Error]', { code: e?.code, table: e?.table, column: e?.column, constraint: e?.constraint, routine: e?.routine });
}

/** A write that failed. `queryDb` answers [] for every failure, so a handler could not tell "nothing matched" from "the database refused it" and reported success. */
export class DbWriteError extends Error {
  readonly code: string | undefined;
  constructor(code?: string) {
    super('Database write failed');
    this.name = 'DbWriteError';
    this.code = code;
  }
}

/** Like `queryDb`, but a failure is thrown (as a `DbWriteError` carrying only the server error code) instead of being turned into an empty result. With no database configured it behaves like `queryDb`. */
export async function queryDbStrict<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const p = getDbPool();
  if (!p) return [];
  try {
    const res = await p.query(text, params);
    return res.rows;
  } catch (err) {
    logDbError(err);
    throw new DbWriteError((err as { code?: string } | null)?.code);
  }
}
