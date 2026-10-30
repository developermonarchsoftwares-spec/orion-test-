import * as Joi from 'joi';
import { isPlaceholderSecret } from './secrets';
import { parseCorsOrigins } from './cors';

export const environmentValidationSchema = Joi.object({
  // App
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'provision')
    .empty('')
    .default('development'),
  PORT: Joi.number().empty('').default(4000),
  API_PREFIX: Joi.string().empty('').default('/api/v1'),
  APP_NAME: Joi.string().empty('').default('Orion Lead Intelligence Platform API'),
  APP_URL: Joi.string().uri().empty('').default('http://localhost:4000'),
  // production: exact https origins only (no wildcard, no localhost, no http); unset means no cross-origin browser access
  CORS_ORIGINS: Joi.string().empty('').when('NODE_ENV', { is: 'production', then: Joi.string().custom((value: string, helpers) => { const r = parseCorsOrigins(value, true); return r.problems.length ? helpers.message({ custom: `CORS_ORIGINS is unsafe for production: ${r.problems.join('; ')}` } as any) : value; }, 'safe CORS origins'), otherwise: Joi.string().default('http://localhost:3000,http://127.0.0.1:3000') }),

  // PostgreSQL
  DATABASE_URL: Joi.string().empty('').when('NODE_ENV', { is: 'production', then: Joi.string().required(), otherwise: Joi.string().default('postgresql://postgres:postgres@localhost:5432/orion_db') }),
  DB_MAX_CONNECTIONS: Joi.number().empty('').default(20),
  DB_IDLE_TIMEOUT_MS: Joi.number().empty('').default(30000),



  // Search Provider
  SEARCH_PROVIDER: Joi.string().valid('postgres', 'typesense').empty('').default('postgres'),

  // Typesense
  TYPESENSE_NODES: Joi.string().empty('').default('localhost'),
  TYPESENSE_PORT: Joi.number().empty('').default(8108),
  TYPESENSE_PROTOCOL: Joi.string().valid('http', 'https').empty('').default('http'),
  // required in production when Typesense is the search provider; the local-development value is rejected there
  TYPESENSE_API_KEY: Joi.string().empty('').optional().when('SEARCH_PROVIDER', { is: 'typesense', then: Joi.when('NODE_ENV', { is: 'production', then: Joi.string().required().invalid('xyz123_orion_typesense_master_key') }) }),
  TYPESENSE_CONNECTION_TIMEOUT_SECONDS: Joi.number().empty('').default(5),

  // JWT
  // No built-in default: in production the secret is required (and the app will not start without it); elsewhere a random one is generated
  JWT_ACCESS_SECRET: Joi.string().empty('').when('NODE_ENV', { is: 'production', then: Joi.string().min(16).custom((value: string, helpers) => (isPlaceholderSecret(value) ? helpers.error('any.invalid') : value), 'example or placeholder value').required(), otherwise: Joi.string().optional() }),
  JWT_ACCESS_EXPIRES_IN: Joi.string().empty('').default('15m'),
  JWT_REFRESH_SECRET: Joi.string().empty('').when('NODE_ENV', { is: 'production', then: Joi.string().min(16).custom((value: string, helpers) => (isPlaceholderSecret(value) ? helpers.error('any.invalid') : value), 'example or placeholder value').required(), otherwise: Joi.string().optional() }),
  JWT_REFRESH_EXPIRES_IN: Joi.string().empty('').default('7d'),
  JWT_ISSUER: Joi.string().empty('').default('orion-api'),
  JWT_AUDIENCE: Joi.string().empty('').default('orion-client'),

  // Encryption keys for secrets stored at rest (MFA seeds, integration credentials). Required in production: new data is never sealed with a key
  // derived from the JWT secret or a constant there (see auth/services/secret-box.util.ts). The PREVIOUS variables list old keys during a rotation.
  MFA_ENCRYPTION_KEY: Joi.string().empty('').min(32).custom((value: string, helpers) => (isPlaceholderSecret(value) ? helpers.error('any.invalid') : value), 'example or placeholder value').when('NODE_ENV', { is: 'production', then: Joi.required() }),
  INTEGRATIONS_ENCRYPTION_KEY: Joi.string().empty('').min(32).custom((value: string, helpers) => (isPlaceholderSecret(value) ? helpers.error('any.invalid') : value), 'example or placeholder value').when('NODE_ENV', { is: 'production', then: Joi.required() }),
  MFA_ENCRYPTION_KEY_PREVIOUS: Joi.string().empty('').optional(),
  INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS: Joi.string().empty('').optional(),

  // Bot protection (Cloudflare Turnstile). Required in production: without the secret the check is silently skipped. A deployment that
  // knowingly runs without it must say so with ALLOW_NO_CAPTCHA=true (the API then starts and logs a warning on every sign-in request).
  TURNSTILE_SECRET_KEY: Joi.string().empty('').when('NODE_ENV', { is: 'production', then: Joi.when('ALLOW_NO_CAPTCHA', { is: Joi.valid('true').required(), then: Joi.optional(), otherwise: Joi.required() }) }),
  ALLOW_NO_CAPTCHA: Joi.string().valid('true', 'false').empty('').optional(),

  // Storage
  STORAGE_PROVIDER: Joi.string().valid('s3', 'r2', 'minio', 'local').empty('').default('minio'),
  STORAGE_BUCKET: Joi.string().empty('').default('orion-assets'),
  STORAGE_REGION: Joi.string().empty('').default('us-east-1'),
  STORAGE_ENDPOINT: Joi.string().allow('').optional(),
  // the local-development MinIO value is refused in production; a missing value just leaves storage unconfigured there
  STORAGE_ACCESS_KEY: Joi.string().allow('').optional().when('NODE_ENV', { is: 'production', then: Joi.string().allow('').invalid('minioadmin') }),
  STORAGE_SECRET_KEY: Joi.string().allow('').optional().when('NODE_ENV', { is: 'production', then: Joi.string().allow('').invalid('minioadmin') }),
  STORAGE_FORCE_PATH_STYLE: Joi.boolean().empty('').default(true),
  STORAGE_PUBLIC_URL_PREFIX: Joi.string().allow('').optional(),

  // Throttler
  THROTTLE_TTL: Joi.number().empty('').default(60000), // milliseconds (@nestjs/throttler v6)
  THROTTLE_LIMIT: Joi.number().empty('').default(100),

  // Logging
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly').empty('').default('info'),

  // OAuth (Sprint 16)
  GOOGLE_CLIENT_ID: Joi.string().allow('').optional(),
  GOOGLE_CLIENT_SECRET: Joi.string().allow('').optional(),
  GOOGLE_CALLBACK_URL: Joi.string().allow('').optional(),
  MICROSOFT_CLIENT_ID: Joi.string().allow('').optional(),
  MICROSOFT_CLIENT_SECRET: Joi.string().allow('').optional(),
  MICROSOFT_TENANT_ID: Joi.string().allow('').optional(),
  MICROSOFT_CALLBACK_URL: Joi.string().allow('').optional(),
});
