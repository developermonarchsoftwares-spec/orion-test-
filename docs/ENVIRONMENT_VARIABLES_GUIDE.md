# Orion Enterprise Platform — Production Environment Variables Guide

This document provides a comprehensive, production-grade reference of all environment variables required to run the Orion Platform, including the Next.js Frontend, NestJS Backend, PostgreSQL Database, Redis Caching, Typesense Search, Object Storage, Razorpay Payment Gateway, OAuth SSO, and Transactional Email services.

---

## Table of Contents
1. [Core Application & Routing](#1-core-application--routing)
2. [Database (PostgreSQL & Drizzle ORM)](#2-database-postgresql--drizzle-orm)
3. [Security & JWT Authentication](#3-security--jwt-authentication)
4. [Search Engine (Typesense)](#4-search-engine-typesense)
5. [Cache & Queues (Redis & BullMQ)](#5-cache--queues-redis--bullmq)
6. [Object Storage (Cloudflare R2 / AWS S3)](#6-object-storage-cloudflare-r2--aws-s3)
7. [Payment Gateway (Razorpay)](#7-payment-gateway-razorpay)
8. [Enterprise Single Sign-On (OAuth 2.0)](#8-enterprise-single-sign-on-oauth-20)
9. [Transactional Email & Real OTP Delivery (SMTP / Resend)](#9-transactional-email--real-otp-delivery-smtp--resend)
10. [How to Configure in Vercel & Production Hosts](#10-how-to-configure-in-vercel--production-hosts)

---

## 1. Core Application & Routing

These variables configure application runtime mode, ports, base URLs, and CORS security headers.

| Variable Name | Required | Default / Example | Purpose |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | **Yes** | `production` | Enables production optimizations, minification, and security flags. |
| `PORT` | **Yes** | `4000` | Local port for the backend server process. |
| `API_PREFIX` | **Yes** | `/api/v1` | URL path prefix for all REST API endpoints. |
| `APP_NAME` | No | `Orion Lead Intelligence Platform` | Brand display name used in system logs and OpenAPI docs. |
| `APP_URL` | **Yes** | `https://orion-api-snowy.vercel.app` | Canonical backend API domain. |
| `CORS_ORIGINS` | **Yes** | `https://orion-api-snowy.vercel.app` | Comma-separated allowed frontend origins for CORS browser security. |
| `NEXT_PUBLIC_API_URL` | **Yes** | `https://orion-api-snowy.vercel.app/api/v1` | Public API endpoint used by client-side React components. |
| `NEXT_PUBLIC_APP_URL` | **Yes** | `https://orion-api-snowy.vercel.app` | Public web application domain. |
| `BACKEND_API_URL` | No | `http://127.0.0.1:4000/api/v1` | Upstream NestJS API target used by Next.js serverless proxy route. In production, set to your separate NestJS backend deployment (e.g., Render/Railway/VPS URL). Must NOT match the frontend domain to avoid circular proxy loops. |
| `LOG_LEVEL` | No | `info` | Logger verbosity (`error`, `warn`, `info`, `debug`). |

---

## 2. Database (PostgreSQL & Drizzle ORM)

Orion relies on PostgreSQL 15+ for relational persistence, user accounts, audit logs, and transaction ledgers. Compatible with **Neon.tech**, **Supabase**, **AWS RDS**, or self-hosted PostgreSQL.

| Variable Name | Required | Example Value | Description |
| :--- | :---: | :--- | :--- |
| `DATABASE_URL` | **Yes** | `postgresql://user:pass@ep-cool.neon.tech/orion_db?sslmode=require` | Connection string pooling queries via pgBouncer/Neon. |
| `DB_SSL` | **Yes** | `true` | Requires SSL/TLS encryption for all database connections. |
| `DB_MAX_CONNECTIONS` | No | `20` | Maximum number of concurrent connections in the connection pool. |
| `DB_IDLE_TIMEOUT_MS` | No | `30000` | Time in milliseconds before an idle connection is released. |

---

## 3. Security & JWT Authentication

Stateless authentication for customer subscribers and corporate administrators.

| Variable Name | Required | Format / Generation | Description |
| :--- | :---: | :--- | :--- |
| `JWT_ACCESS_SECRET` | **Yes** | 64-char random hex string | Secret used to sign short-lived access tokens (15m). |
| `JWT_REFRESH_SECRET` | **Yes** | 64-char random hex string | Secret used to sign persistent refresh tokens (7d). |
| `JWT_ACCESS_EXPIRES_IN` | No | `15m` | Lifetime of the bearer access token. |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Lifetime of the refresh token. |
| `JWT_ISSUER` | No | `orion-api` | JWT token issuer claim (`iss`). |
| `JWT_AUDIENCE` | No | `orion-client` | JWT token audience claim (`aud`). |

> **Security Tip**: Generate secure secrets on your terminal using:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## 4. Search Engine (Typesense)

Powers real-time, sub-50ms search, autocomplete, geo-distance radius, and multi-facet filtering across 1.2M+ business records.

| Variable Name | Required | Example (Typesense Cloud) | Description |
| :--- | :---: | :--- | :--- |
| `TYPESENSE_NODES` | **Yes** | `xxx-1.a1.typesense.net` | Hostname of your cluster (without protocol or port). |
| `TYPESENSE_PORT` | **Yes** | `443` | `443` for Cloud HTTPS, `8108` for local self-hosted. |
| `TYPESENSE_PROTOCOL` | **Yes** | `https` | Protocol scheme (`https` or `http`). |
| `TYPESENSE_API_KEY` | **Yes** | `xyz123_master_admin_key` | Master API Key with full read/write schema permissions. |
| `TYPESENSE_CONNECTION_TIMEOUT_SECONDS` | No | `5` | Client socket timeout limit. |

---

## 5. Background Queues & Storage (Neon PostgreSQL)

All background jobs, queues, and admin OTPs are handled natively via **Neon PostgreSQL** transactional tables (`queue_jobs` and `admin_otps`). No Redis or Upstash instance is required.

---

## 6. Object Storage (Cloudflare R2 / AWS S3)

Used to store uploaded CSV/Excel import batches, data exports, company logos, and generated invoices.

| Variable Name | Required | Example (Cloudflare R2) | Description |
| :--- | :---: | :--- | :--- |
| `STORAGE_PROVIDER` | **Yes** | `r2` | Storage driver: `r2`, `s3`, or `minio`. |
| `STORAGE_BUCKET` | **Yes** | `orion-production-assets` | Target bucket name. |
| `STORAGE_REGION` | **Yes** | `auto` | Bucket region (`auto` for R2, `us-east-1` for S3). |
| `STORAGE_ENDPOINT` | **Yes** | `https://<account_id>.r2.cloudflarestorage.com` | S3-compatible API endpoint URL. |
| `STORAGE_ACCESS_KEY` | **Yes** | `0123456789abcdef...` | S3 Access Key ID. |
| `STORAGE_SECRET_KEY` | **Yes** | `abcdef0123456789...` | S3 Secret Access Key. |
| `STORAGE_FORCE_PATH_STYLE` | No | `false` | Path-style URL addressing toggle. |
| `STORAGE_PUBLIC_URL_PREFIX` | No | `https://assets.yourdomain.com` | Public CDN URL for serving stored assets. |

---

## 7. Payment Gateway (Razorpay)

Powers platform credit purchases, subscription plans, and automatic GST compliant invoice generation.

| Variable Name | Required | Source | Description |
| :--- | :---: | :--- | :--- |
| `RAZORPAY_KEY_ID` | **Yes** | Razorpay Dashboard ➔ API Keys | Public identifier (`rzp_live_...` or `rzp_test_...`). |
| `RAZORPAY_KEY_SECRET` | **Yes** | Razorpay Dashboard ➔ API Keys | Secret key used for backend order creation and signature checks. |
| `RAZORPAY_WEBHOOK_SECRET`| **Yes** | Razorpay Dashboard ➔ Webhooks | HMAC secret to verify automated payment settlement webhooks. |

---

## 8. Enterprise Single Sign-On (OAuth 2.0)

Enables users to sign up and sign in using Google and Microsoft 365 accounts with automated account linking.

### Google OAuth:
| Variable Name | Required | Description |
| :--- | :---: | :--- |
| `GOOGLE_CLIENT_ID` | Optional | Google OAuth 2.0 Client ID from Google Cloud Console. |
| `GOOGLE_CLIENT_SECRET` | Optional | Google OAuth Client Secret. |
| `GOOGLE_CALLBACK_URL` | Optional | `https://orion-api-snowy.vercel.app/api/v1/auth/google/callback` |

### Microsoft Azure AD OAuth:
| Variable Name | Required | Description |
| :--- | :---: | :--- |
| `MICROSOFT_CLIENT_ID` | Optional | Application (Client) ID from Azure Portal. |
| `MICROSOFT_CLIENT_SECRET` | Optional | Client Secret Value generated in Certificates & Secrets. |
| `MICROSOFT_TENANT_ID` | Optional | `common` (for any Microsoft personal/work account) or Directory ID. |
| `MICROSOFT_CALLBACK_URL` | Optional | `https://orion-api-snowy.vercel.app/api/v1/auth/microsoft/callback` |

---

## 9. Transactional Email & Real OTP Delivery (SMTP / Resend)

Essential for dispatching real 6-digit verification codes to administrator emails and sending customer password resets and invoice receipts.

| Variable Name | Required | Recommended Provider | Description |
| :--- | :---: | :--- | :--- |
| `RESEND_API_KEY` | Recommended | [Resend.com](https://resend.com) | Dedicated API Key (`re_...`) for modern HTTP email dispatch. |
| `SMTP_HOST` | If using SMTP | `smtp.resend.com` or custom | SMTP outbound mail server hostname. |
| `SMTP_PORT` | If using SMTP | `465` (SSL) or `587` (TLS) | Standard SMTP submission port. |
| `SMTP_SECURE` | If using SMTP | `true` | Enable TLS/SSL wrapper. |
| `SMTP_USER` | If using SMTP | Username / `resend` | SMTP authentication user. |
| `SMTP_PASS` | If using SMTP | Password / API Key | SMTP authentication password or app token. |
| `SMTP_FROM` | **Yes** | `"Monarch Security" <security@yourdomain.com>` | Sender identity displayed in recipient inboxes. |

---

## 10. How to Configure in Vercel & Production Hosts

### Adding to Vercel (Recommended)
1. Go to your **Vercel Dashboard** ➔ Select project **`orion-api`**.
2. Navigate to **Settings** ➔ **Environment Variables**.
3. Add the required variables from the list above.
4. Select all environments: **Production**, **Preview**, and **Development**.
5. Trigger a redeploy (or push a commit to `main`) to activate the new values immediately.

---

## Summary of Recommended Free-Tier Stack

| Service Component | Recommended Provider | Free Tier Allowance |
| :--- | :--- | :--- |
| **PostgreSQL Database** | [Neon.tech](https://neon.tech) | 0.5 GB storage, serverless compute |
| **Redis Cache** | [Upstash.com](https://upstash.com) | 10,000 commands/day, serverless |
| **Search Engine** | [Typesense Cloud](https://cloud.typesense.org) | Free trial / Self-host on $5 VPS |
| **Object Storage** | [Cloudflare R2](https://cloudflare.com) | 10 GB free, $0 egress fees |
| **Transactional Email** | [Resend.com](https://resend.com) | 3,000 emails/month free |
| **Payment Gateway** | [Razorpay](https://razorpay.com) | Free sandbox testing |
| **Web & API Hosting** | [Vercel](https://vercel.com) | Unlimited deployments |

### Database limits (added in Phase 27)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_STATEMENT_TIMEOUT_MS` | No | `60000` | The server cancels a statement that runs longer. `0` switches it off. |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | No | `60000` | The server closes a connection whose transaction sits idle longer (a stalled request holding locks). `0` switches it off. |
| `DB_LOCK_TIMEOUT_MS` | No | `5000` | The server gives up waiting for a row or table lock after this long (changed from 30000 in Phase 29: every waiter holds a pooled connection). The caller gets a retryable 503. `0` switches it off. |

### Recovery and encryption (added in Phase 30)

| Variable | Required | Default | Description |
|---|---|---|---|
| `RESTORE_MODE` | No | unset | `true` starts the API with no queue worker, scheduled export, webhook delivery, credit rollover, retention or token clean-up. Use it for the first start after restoring a database; remove it afterwards. |
| `MFA_ENCRYPTION_KEY` | **Required in production** (the API will not start without it), at least 32 characters | none; outside production a development-only key is used and a warning is logged | Encrypts stored MFA secrets. New data is written as `v2.<key id>...` under this key and never under a key derived from `JWT_ACCESS_SECRET`; rows written earlier (`v1`) still open until they are resealed. Keep it in the secret store, escrowed apart from backups; never store it in a backup. |
| `INTEGRATIONS_ENCRYPTION_KEY` | **Required in production**, at least 32 characters | as above | Same, for webhook signing secrets and CRM credentials. |
| `MFA_ENCRYPTION_KEY_PREVIOUS`, `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` | No | unset | Old keys (comma separated), only while rotating. Rotation: set the new key and the old one here, deploy, run `npm run db:reseal-secrets` (dry run) and then `-- --apply` with `RESEAL_CONFIRM_DATABASE=<database name>`, check it reports up to date, then remove the old key. **Run the reseal before changing `JWT_ACCESS_SECRET`** if any row is still in the old format, or those rows become unreadable. |
| `TURNSTILE_SECRET_KEY` (and the web's `NEXT_PUBLIC_TURNSTILE_SITE_KEY`) | **Required in production** | none | Bot protection on sign-in, sign-up code, and forgot-password. Set both keys together: a production web build stops if only one is set. With no secret in production the API will not start and the gateway refuses the request (fails closed). |
| `ALLOW_NO_CAPTCHA` | No | unset | `true` records the decision to run production without bot protection: the API starts, requests pass unchecked, and a warning is logged. Never set it to hide a missing key. |

### Sign-up e-mail verification code (see `EMAIL_OTP_VERIFICATION.md`)

Apply to the API **and** the web gateway; set the same values on both.

| Variable | Required | Default | Description |
|---|---|---|---|
| `REQUIRE_REGISTRATION_OTP` | No | on | New accounts need a 6-digit code e-mailed to the address typed. **Always on in production: this setting is ignored there.** Outside production `false` switches it off (local development without a mail relay). |
| `EMAIL_OTP_SECRET` | No | derived from `JWT_ACCESS_SECRET` | Key for hashing codes. Must be identical on the API and the gateway. Changing it invalidates codes in flight (users request a new one). |
| `APP_NAME` | No | `Orion` | Name shown in the code e-mail. |
| `MAIL_TRANSPORT`, `MAIL_WEBHOOK_URL`, `MAIL_WEBHOOK_TOKEN` | Yes in production (API) | none | How the API sends the code (`webhook` posts `{to, subject, text, html, sensitive}`). In production without a transport nobody can register. The development `log` transport never prints a code. There is no SMTP client: point the relay at Gmail/SMTP if that is your provider. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Yes in production (web) | none | How the gateway sends the code when it answers sign-up itself. |

The migration `0026_email_otp_challenges` must be applied before this is deployed; until then the code routes answer 503 and registration is refused.
