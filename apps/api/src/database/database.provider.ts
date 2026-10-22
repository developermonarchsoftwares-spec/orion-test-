import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { verifiedConnection } from './tls';
import { apiEndpoint, apiMaxConnections } from './connection-endpoint';
import { databasePoolSettings } from './pool-settings';
import { instrumentPool } from '../common/observability/db-instrumentation';
import { DRIZZLE_DATABASE, PG_POOL } from './database.constants';

export type DrizzleDb = NodePgDatabase<typeof schema>;

export const databaseProviders: Provider[] = [
  {
    provide: PG_POOL,
    inject: [ConfigService],
    useFactory: (configService: ConfigService): Pool => {
      const databaseUrl = configService.get<string>('database.url');
      const maxConnections = apiMaxConnections(configService.get<number>('database.maxConnections', 20));
      const idleTimeoutMillis = configService.get<number>('database.idleTimeoutMs', 30000);

      const pool = new Pool({
        // TLS is always verified for a remote database; the URL's own sslmode cannot weaken it (see ./tls)
        ...(databaseUrl ? verifiedConnection(apiEndpoint(databaseUrl)) : { connectionString: databaseUrl }),
        max: maxConnections,
        idleTimeoutMillis,
        connectionTimeoutMillis: 15000,
        // server-side limits on every pooled connection (statement, idle-in-transaction, lock wait): see ./pool-settings
        ...databasePoolSettings(),
      });

      pool.on('error', (err) => {
        // Log unexpected error on idle client
        console.error('Unexpected error on idle PostgreSQL client', err);
      });

      return instrumentPool(pool);
    },
  },
  {
    provide: DRIZZLE_DATABASE,
    inject: [PG_POOL],
    useFactory: (pool: Pool): DrizzleDb => {
      // S-20: statement logging prints bound parameters (e-mails, password hashes, OTP rows) to stdout.
      // It is OFF unless explicitly opted in with DB_LOG_QUERIES=true, so production logs never carry PII
      // even when NODE_ENV is misconfigured.
      return drizzle(pool, { schema, logger: process.env.DB_LOG_QUERIES === 'true' });
    },
  },
];
