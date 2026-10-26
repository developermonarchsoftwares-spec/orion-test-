/**
 * Jest setup for the E2E specs (runs before any application module is loaded).
 *
 * - Explicit TEST-ONLY secrets: the application has no built-in secrets any more, and the specs sign their own tokens with the
 *   same values (helpers/test-secrets.ts). They are not real credentials and are never printed.
 * - The database is hermetic (an in-memory PGlite, see helpers/pglite-db.ts). DATABASE_URL is forced to an address that cannot
 *   connect, so even a misconfigured run can never reach a real database (Neon / production), whatever .env says.
 * - Payment secrets are test-only values, so the webhook and verification paths can be exercised without any provider.
 */
import { TEST_SECRETS } from './helpers/test-secrets';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = TEST_SECRETS.jwtAccess;
process.env.JWT_REFRESH_SECRET = TEST_SECRETS.jwtRefresh;
process.env.DATABASE_URL = 'postgresql://e2e:e2e@127.0.0.1:1/never_connects';
// Sign-up verification codes are tested by their own suites (which switch this on). The many existing suites that create accounts
// through POST /auth/register directly are not about sign-up and keep registering without a mailbox. Ignored in production.
process.env.REQUIRE_REGISTRATION_OTP = 'false';
// A developer's own .env may enable real Razorpay orders (RAZORPAY_API_MODE=live). The suites must never reach the network, so the mode is
// pinned off here exactly like DATABASE_URL; the live-mode behaviour has its own suite that injects a fake gateway.
process.env.RAZORPAY_API_MODE = 'off';
process.env.RAZORPAY_KEY_ID = TEST_SECRETS.razorpayKeyId;
process.env.RAZORPAY_KEY_SECRET = TEST_SECRETS.razorpayKeySecret;
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRETS.razorpayWebhookSecret;
// S-09 is enabled in production (THROTTLE_TTL is milliseconds in @nestjs/throttler v6). The E2E suites
// drive hundreds of sequential requests through one process, which legitimately exceeds a real per-minute
// limit, so the test environment raises the ceiling. Production uses its own THROTTLE_* values.
// The cron routes (GET /cron/:job) answer 503 "not configured" without a secret of 32+ characters. With one set they answer 401 to anything
// without it, which is what the API-contract sweep (every route, hostile requests, no server error) expects of an unauthenticated caller.
process.env.CRON_SECRET = 'e2e-only-cron-secret-0123456789abcdef-not-used-anywhere-else';
process.env.THROTTLE_TTL = process.env.THROTTLE_TTL || '60000';
process.env.THROTTLE_LIMIT = process.env.THROTTLE_LIMIT || '1000000';
