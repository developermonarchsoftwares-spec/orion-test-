import { pgTable, varchar, integer, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Shared request counters for rate limiting. On a serverless host every function instance has its own memory, so an in-memory counter
 * lets an attacker spread requests across instances and never reach the limit. One row per limiter key in one place makes the limit the
 * same for every instance. The key is a SHA-256 of the limiter name and the subject (an address or an e-mail), never the raw value.
 * Both the API (throttler storage) and the web gateway's own handlers read and write this table.
 */
export const rateLimitCounters = pgTable(
  'rate_limit_counters',
  {
    key: varchar('key', { length: 96 }).primaryKey(),
    hits: integer('hits').default(0).notNull(),
    resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_rate_limit_counters_reset_at').on(table.resetAt)],
);
