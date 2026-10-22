# Moving the production database to Neon (runbook)

**Decision (2026-10-22):** Neon is the production PostgreSQL. This reverses the earlier goal in `NEON_REMOVAL_STATUS.md` (kept for history). Nothing below has been run: no Neon project was contacted, no data moved, no Vercel variable set.

## What the code already does
| Concern | Behaviour | Where |
|---|---|---|
| TLS | Always verified for a remote host; `sslmode` in the URL is stripped | `apps/api/src/database/tls.ts`, `ownus/src/lib/db.ts` |
| Endpoint | API, migrations, seed and gateway all use the **direct** host. A `-pooler.` host is rewritten to direct, because the pooler (PgBouncer, transaction mode) rejects the start-up limits (`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`) and session state. `DB_USE_POOLER=true` keeps the pooler (then set the three limits to 0 and use `ALTER ROLE ... SET`) | `connection-endpoint.ts` (API), `db.ts` (gateway) |
| Pool size | API: 5 per instance on Vercel unless `DB_MAX_CONNECTIONS` is set (20 elsewhere); gateway: 3 | `connection-endpoint.ts`, `db.ts` |
| Cold start | Neon wakes a suspended compute in a few seconds: API connect timeout 15 s, gateway 10 s | `database.provider.ts`, `db.ts` |
| Migrations | Run from a trusted machine, only against a host named in `MIGRATION_CONFIRM_HOST`; applied `0000`-`0023` frozen | `migrate.ts`, `migration-target.ts` |

Capacity note: direct connections are limited by the Neon compute size (see the Neon console). Instances x `DB_MAX_CONNECTIONS` must stay below it; lower `DB_MAX_CONNECTIONS` before raising traffic.

## Steps (each needs your approval; run them yourself or tell me to)
1. **Rotate first** (open SG-02/02b): new Neon role password, new JWT secrets. Do not reuse anything from Git history.
2. **Create the Neon project/branch** in a region near the Vercel functions. Create a role for the app (and ideally a separate least-privilege one for the gateway: `GATEWAY_DATABASE_URL`).
3. **Back up the source** (`npm run db:backup` in `apps/api`; verified dumps already exist under `C:\Users\kathir\orion-db-backups\`, refresh them).
4. **Rehearse on a Neon branch, not production:** `MIGRATION_CONFIRM_HOST=<direct host> npm run drizzle:migrate`, then `npm run db:audit`. A fresh database builds 66 tables from the 24 migrations; the 19 external pipeline tables are not created and the app does not need them. Run `npm run drizzle:seed` only if the catalogue/packages are wanted (it UPSERTS package prices: Starter 299, Growth 499).
5. **Move the data** (custom-format dump of `orion_db` restored with `pg_restore --no-owner` into the migrated Neon database, or `COPY` the app tables only). Then `npm run db:reconcile-credits` and compare row counts per table with the backup manifest. Known: `import_batches.file_key` is nullable locally but NOT NULL in the schema.
6. **Set Vercel variables** (Production and Preview, Sensitive): `DATABASE_URL` (direct or pooled string, both work), optional `GATEWAY_DATABASE_URL`, new JWT secrets, `CRON_SECRET`. Do not set `DB_USE_POOLER` unless you accept the note above.
7. **Deploy a Preview**, check `/api/v1/health/readiness` (database up), sign in, buy credits in test mode, run one cron route with the secret.
8. **Cut over:** freeze writes on the old database, take a final dump, restore, reconcile, point Production at Neon, promote. Keep the old database read-only until verified.

## Not done / unverified
Nothing has touched Neon. Behaviour against the real pooler/direct endpoints, connection limits under load and the `-pooler.` start-up-parameter claim are unverified until the rehearsal in step 4.
