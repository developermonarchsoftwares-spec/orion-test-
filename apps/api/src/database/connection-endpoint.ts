/**
 * Which Neon endpoint the API pool talks to, and how many connections each instance may open.
 *
 * Neon's pooled endpoint (host contains `-pooler.`, PgBouncer in transaction mode) refuses the server-side limits this pool sends as
 * start-up parameters (statement_timeout, idle_in_transaction_session_timeout, lock_timeout: see ./pool-settings) and does not keep
 * session state between statements. The API therefore uses the direct endpoint, exactly like the migration runner, the seed and the web
 * gateway (ownus/src/lib/db.ts). Set DB_USE_POOLER=true to keep the pooled host (then also set DB_STATEMENT_TIMEOUT_MS=0,
 * DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=0 and DB_LOCK_TIMEOUT_MS=0, and apply those limits as role defaults with ALTER ROLE ... SET).
 */
export function apiEndpoint(url: string, env: NodeJS.ProcessEnv = process.env): string {
  if ((env.DB_USE_POOLER ?? '').trim().toLowerCase() === 'true') return url;
  return url.includes('-pooler.') ? url.replace('-pooler.', '.') : url;
}

/** Default pool size on Vercel: every function instance has its own pool, so 20 per instance would exhaust the database quickly. */
export const SERVERLESS_DEFAULT_MAX_CONNECTIONS = 5;

/** DB_MAX_CONNECTIONS wins when set; on Vercel the default is 5, elsewhere the configured value (20 by default). */
export function apiMaxConnections(configured: number, env: NodeJS.ProcessEnv = process.env): number {
  if ((env.DB_MAX_CONNECTIONS ?? '').trim() !== '') return configured;
  return env.VERCEL ? SERVERLESS_DEFAULT_MAX_CONNECTIONS : configured;
}
