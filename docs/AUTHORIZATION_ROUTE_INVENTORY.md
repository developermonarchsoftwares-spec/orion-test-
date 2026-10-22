# Orion authorization route inventory (Phase 5)

**Date:** 2026-10-10 (extended in Phase 7 with rate-limit and validation columns) · **Source:** every `@Get/@Post/@Put/@Patch/@Delete` handler in `apps/api/src/**/*.controller.ts`, extracted programmatically (201 handlers; the count equals a separate grep of the decorators), cross-checked against the running application by `apps/api/test/authorization.e2e-spec.ts`, which discovers routes from live metadata and fails if the set of public routes changes.

**Scope and limits.** This covers the NestJS API completely. The web gateway (`ownus/src/app/api/v1/[...path]/route.ts`) is a second backend (SG-06): its 62 natively handled paths were enumerated and checked against `routePolicy` (only `auth/logout` has no gateway gate, and it verifies the token itself), but its handlers were sampled, not reviewed line by line, and have no per-route object-level tests. Owner-scoping mechanisms below come from reading the service code; "Test coverage" lists only suites that exist and what they exercise.

**Rate limiting (Phase 7).** Every route is covered by the global per-address limiter (100 requests per minute, `THROTTLE_*`) and, outside tests, by the traffic module (address burst and hourly limits, per-user and per-plan limits, concurrency cap, automatic blocks, scanner detection, URL length cap). "Route limit" is an additional, stricter per-route limit set with `@Throttle`; "global only" means no stricter limit. Health routes are exempt. The limiter is in-process: with several API instances each keeps its own counters (see the test plan, section 6).

**Input validation.** The global validation pipe (whitelist and forbidNonWhitelisted) applies to every body or query typed as a DTO class. "inline object" means the handler types the body as an inline object, which the pipe cannot check: those handlers validate in the service or are administrator-only (see the gap report, P7-12). "raw" query values are not validated by the pipe; the pagination ones are bounded by `boundedPage` / `boundedWindow` (Phase 7). A request-level guard additionally rejects NUL bytes, `__proto__` keys and absurd nesting on every route.

Authentication: **Public** = `@Public()`; **JWT** = global default-deny guard (persisted status checked every request); **Role** = `RolesGuard` against the persisted role. A route with JWT and no role is open to any signed-in customer, so its resource-level mechanism is what protects other customers.

## app

Owner: n/a · Mechanism: public root · Sensitive data: none · Coverage: authorization (public surface)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/` | Public | - | global only | - | - |

## auth/admin-auth

Owner: n/a (admin sign-in) · Mechanism: persisted ADMIN/SUPER_ADMIN account required before a code is issued or redeemed · Sensitive data: admin session token · Coverage: admin-auth, auth-hardening

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| POST | `/admin/auth/send-otp` | Public | - | global only | body: inline object (not validated by the pipe) | P7-12: inline body type, shape checked in the handler or service only; non-string email or code is not rejected by the pipe (P7-12) |
| POST | `/admin/auth/verify-otp` | Public | - | 5/300s | body: inline object (not validated by the pipe) | P7-12: inline body type, shape checked in the handler or service only; non-string email or code is not rejected by the pipe (P7-12) |
| POST | `/admin/auth/logout` | Public | - | global only | - | - |
| GET | `/admin/template/csv` | Public | - | global only | - | - |

## auth/auth

Owner: caller (token sub) · Mechanism: identity from verified token; refresh token family and sessions filtered by user id in the WHERE · Sensitive data: own profile, sessions, MFA state · Coverage: auth e2e suites, auth-identity, auth-hardening, authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/auth/me` | JWT | any signed-in customer | global only | - | - |
| POST | `/auth/change-password` | JWT | any signed-in customer | global only | body: DTO ChangePasswordDto | - |
| POST | `/auth/send-otp` | Public | - | 6/60s + DB limits | body: DTO SendOtpDto | Sign-up e-mail code (see `EMAIL_OTP_VERIFICATION.md`); same answer for known and unknown addresses |
| POST | `/auth/verify-otp` | Public | - | 12/60s + 5 tries per code | body: DTO VerifyOtpDto | Returns a one-time proof, never a session |
| POST | `/auth/register` | Public | - | 10/60s | body: DTO RegisterDto (now requires `verificationToken`) | - |
| POST | `/auth/login` | Public | - | 10/60s | body: DTO LoginDto | - |
| POST | `/auth/refresh` | Public | - | 30/60s | body: DTO RefreshTokenDto | - |
| POST | `/auth/logout` | JWT | any signed-in customer | global only | body: inline object (not validated by the pipe) | P7-12: inline body type, shape checked in the handler or service only |
| POST | `/auth/forgot-password` | Public | - | 5/60s | body: DTO ForgotPasswordDto | - |
| POST | `/auth/reset-password` | Public | - | 5/60s | body: DTO ResetPasswordDto | - |
| POST | `/auth/verify-email` | Public | - | 10/60s | body: DTO VerifyEmailDto | - |
| POST | `/auth/resend-verification` | Public | - | 3/60s | body: DTO ResendVerificationDto | - |
| POST | `/auth/mfa/login` | Public | - | 5/60s | body: DTO MfaLoginDto | - |
| GET | `/auth/mfa/status` | JWT | any signed-in customer | global only | - | - |
| POST | `/auth/mfa/setup` | JWT | any signed-in customer | global only | - | - |
| POST | `/auth/mfa/enable` | JWT | any signed-in customer | 5/60s | body: DTO MfaCodeDto | - |
| POST | `/auth/mfa/disable` | JWT | any signed-in customer | 5/60s | body: DTO DisableMfaDto | - |
| POST | `/auth/mfa/recovery-codes` | JWT | any signed-in customer | 5/60s | body: DTO MfaCodeDto | - |
| GET | `/auth/sessions` | JWT | any signed-in customer | global only | - | - |
| POST | `/auth/sessions/revoke-all` | JWT | any signed-in customer | global only | - | - |
| DELETE | `/auth/sessions/:id` | JWT | any signed-in customer | global only | path: id (string) | - |

## modules/business/business

Owner: shared record · Mechanism: public detail only for PUBLISHED; draft is 404 for users, visible to admin · Sensitive data: masked company profile · Coverage: security-hardening (draft = 404)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/businesses/:id` | Public | - | global only | path: id (string) | - |
| GET | `/businesses/:id/related` | Public | - | global only | query: raw limit:number; path: id (string) | - |

## modules/credit/credit

Owner: caller (token sub) · Mechanism: wallet and ledger read by token user id; admin adjust is role-gated and takes the target user from the body · Sensitive data: own balance and ledger · Coverage: access-model, credit-wallet, authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/credit/wallet` | JWT | any signed-in customer | global only | - | - |
| GET | `/credit/transactions` | JWT | any signed-in customer | global only | query: raw page; raw limit | page and limit bounded in Phase 7 (was SG-20) |
| GET | `/credit/packages` | Public | - | global only | - | - |
| GET | `/credit/config` | Public | - | global only | - | - |
| GET | `/credit/admin/packages` | JWT | SUPER_ADMIN, ADMIN | global only | - | - |
| POST | `/credit/admin/packages` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO CreateCreditPackageDto | - |
| PUT | `/credit/admin/packages/:id` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO UpdateCreditPackageDto; path: id (string) | - |
| DELETE | `/credit/admin/packages/:id` | JWT | SUPER_ADMIN, ADMIN | global only | path: id (string) | - |
| PUT | `/credit/admin/config` | JWT | SUPER_ADMIN, ADMIN | global only | body: inline object (not validated by the pipe) | any admin may set any config key (P3, role-gated); P7-12: inline body type, shape checked in the handler or service only |
| POST | `/credit/admin/adjust` | JWT | SUPER_ADMIN, ADMIN | 30/60s | body: DTO AdminAdjustCreditsDto | SG-22: one admin, no second approval (P3) |

## modules/dashboard/dashboard

Owner: caller (token sub) · Mechanism: aggregates by token user id · Sensitive data: own summary · Coverage: authorization sweep (anonymous only)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/dashboard/summary` | JWT | any signed-in customer | global only | - | - |

## modules/discover/discover

Owner: shared record + caller unlock state · Mechanism: only PUBLISHED companies; contact values masked unless the caller unlocked them · Sensitive data: masked or unlocked contacts · Coverage: lead-discovery-unlock, security-hardening, authorization (shared vs private)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/discover/search` | Public | - | 60/60s | query: DTO DiscoverSearchQueryDto | - |
| GET | `/discover/businesses/:slug` | Public | - | global only | path: slug (string) | - |
| GET | `/discover/businesses/:slug/related` | Public | - | global only | query: raw limit:number; path: slug (string) | - |
| GET | `/discover/suggestions` | Public | - | 120/60s | query: DTO DiscoverSuggestionsDto | - |

## modules/export/export

Owner: caller (token sub) · Mechanism: jobs, files, schedules selected by id AND user id; admin audit is role-gated · Sensitive data: own exported rows · Coverage: import-export, authorization (A vs B)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/exports/datasets` | JWT | any signed-in customer | global only | - | - |
| POST | `/exports` | JWT | any signed-in customer | 10/60s | body: DTO CreateExportDto | - |
| GET | `/exports/history` | JWT | any signed-in customer | global only | query: raw limit | - |
| GET | `/exports/schedules` | JWT | any signed-in customer | global only | - | - |
| POST | `/exports/schedules` | JWT | any signed-in customer | global only | body: DTO CreateScheduleDto | - |
| PATCH | `/exports/schedules/:id` | JWT | any signed-in customer | global only | body: DTO UpdateScheduleDto; path: id (string) | - |
| DELETE | `/exports/schedules/:id` | JWT | any signed-in customer | global only | path: id (string) | - |
| GET | `/exports/admin/audit` | JWT | SUPER_ADMIN, ADMIN | global only | query: DTO ExportAuditQueryDto | - |
| GET | `/exports/:id/download` | JWT | any signed-in customer | 30/60s | path: id (string) | SG-13: ignores unpublish state (P2) |

## modules/health/health

Owner: n/a · Mechanism: public; details only with an admin bearer token · Sensitive data: status, latency · Coverage: health-probes

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/health` | Public | - | exempt | - | - |
| GET | `/health/live` | Public | - | exempt | - | - |
| GET | `/health/ready` | Public | - | exempt | - | - |
| GET | `/health/:dependency` | Public | - | exempt | path: dependency (string) | - |

## modules/import/controllers/admin-import

Owner: role only · Mechanism: ADMIN/SUPER_ADMIN guard · Sensitive data: import batches and records · Coverage: admin-import-pipeline, authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/admin/import/template` | Public | - | global only | - | - |
| POST | `/admin/import/preview` | JWT | SUPER_ADMIN, ADMIN | global only | body: inline object (not validated by the pipe) | P7-12: inline body type, shape checked in the handler or service only |
| POST | `/admin/import/submit` | JWT | SUPER_ADMIN, ADMIN | 10/60s | body: inline object (not validated by the pipe) | P7-12: inline body type, shape checked in the handler or service only |
| POST | `/admin/import/csv/preview` | JWT | SUPER_ADMIN, ADMIN | global only | body: inline object (not validated by the pipe) | P7-12: inline body type, shape checked in the handler or service only |
| POST | `/admin/import/csv/submit` | JWT | SUPER_ADMIN, ADMIN | 10/60s | body: inline object (not validated by the pipe) | P7-12: inline body type, shape checked in the handler or service only |
| POST | `/admin/import/publish-batch/:batchId` | JWT | SUPER_ADMIN, ADMIN | global only | path: batchId (string) | - |
| GET | `/admin/import/batches` | JWT | SUPER_ADMIN, ADMIN | global only | query: raw limit; raw offset | - |
| GET | `/admin/import/stats` | JWT | SUPER_ADMIN, ADMIN | global only | - | - |

## modules/import/controllers/import-operations

Owner: role only · Mechanism: ADMIN/SUPER_ADMIN guard · Sensitive data: batch reports, failed rows · Coverage: authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/admin/import/operations/batches` | JWT | SUPER_ADMIN, ADMIN | global only | query: DTO OpsBatchesQueryDto | - |
| GET | `/admin/import/operations/batches/:batchId` | JWT | SUPER_ADMIN, ADMIN | global only | query: DTO OpsRecordsQueryDto; path: batchId (UUID pipe) | - |
| POST | `/admin/import/operations/batches/:batchId/reprocess-people` | JWT | SUPER_ADMIN, ADMIN | global only | path: batchId (UUID pipe) | - |

## modules/import/controllers/import-recovery

Owner: role only · Mechanism: ADMIN/SUPER_ADMIN guard · Sensitive data: batch recovery · Coverage: authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/admin/import/operations/batches/:batchId/report` | JWT | SUPER_ADMIN, ADMIN | global only | path: batchId (UUID pipe) | - |
| GET | `/admin/import/operations/batches/:batchId/report.csv` | JWT | SUPER_ADMIN, ADMIN | global only | path: batchId (UUID pipe) | - |
| GET | `/admin/import/operations/batches/:batchId/failed.csv` | JWT | SUPER_ADMIN, ADMIN | global only | path: batchId (UUID pipe) | - |
| POST | `/admin/import/operations/batches/:batchId/retry-failed` | JWT | SUPER_ADMIN, ADMIN | global only | path: batchId (UUID pipe) | - |
| PATCH | `/admin/import/operations/records/:recordId` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO CorrectRecordDto; path: recordId (UUID pipe) | - |

## modules/integrations/integration-callback

Owner: integration · Mechanism: public, authenticated by HMAC signature and timestamp, not by session · Sensitive data: delivery acknowledgements · Coverage: integrations e2e

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| POST | `/integrations/callbacks/:integrationId` | Public | - | 120/60s | path: integrationId (string) | - |

## modules/integrations/integrations

Owner: caller (token sub) · Mechanism: getOwned(userId, id) with UUID check; deliveries scoped to the owned integration · Sensitive data: own integrations, secrets (masked), deliveries · Coverage: integrations e2e, authorization (A vs B)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/integrations/events` | JWT | any signed-in customer | global only | - | - |
| GET | `/integrations/admin/health` | JWT | SUPER_ADMIN, ADMIN | global only | - | - |
| GET | `/integrations` | JWT | any signed-in customer | global only | - | - |
| POST | `/integrations` | JWT | any signed-in customer | 20/60s | body: DTO CreateIntegrationDto | - |
| GET | `/integrations/:id` | JWT | any signed-in customer | global only | path: id (string) | - |
| PATCH | `/integrations/:id` | JWT | any signed-in customer | global only | body: DTO UpdateIntegrationDto; path: id (string) | - |
| DELETE | `/integrations/:id` | JWT | any signed-in customer | global only | path: id (string) | - |
| POST | `/integrations/:id/rotate-secret` | JWT | any signed-in customer | global only | path: id (string) | - |
| POST | `/integrations/:id/test` | JWT | any signed-in customer | 10/60s | path: id (string) | - |
| GET | `/integrations/:id/deliveries` | JWT | any signed-in customer | global only | query: DTO DeliveriesQueryDto; path: id (string) | - |
| POST | `/integrations/:id/deliveries/:deliveryId/redeliver` | JWT | any signed-in customer | global only | path: id (string); deliveryId (string) | - |
| POST | `/integrations/:id/sync` | JWT | any signed-in customer | 6/60s | body: DTO SyncDto; path: id (string) | - |
| POST | `/integrations/:id/validate` | JWT | any signed-in customer | 10/60s | body: DTO ValidateDto; path: id (string) | - |

## modules/monitoring/monitoring

Owner: role only · Mechanism: ADMIN guard; dashboard page is a shell; metrics need a token or admin · Sensitive data: operational metrics, traces · Coverage: monitoring e2e, authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/monitoring/dashboard` | Public | - | global only | - | public HTML shell only |
| GET | `/monitoring/overview` | JWT | ...ADMINS | global only | query: raw fresh:string | - |
| GET | `/monitoring/database` | JWT | ...ADMINS | global only | query: raw fresh:string | - |
| GET | `/monitoring/queues` | JWT | ...ADMINS | global only | query: raw fresh:string | - |
| GET | `/monitoring/search` | JWT | ...ADMINS | global only | query: raw fresh:string | - |
| GET | `/monitoring/alerts` | JWT | ...ADMINS | global only | - | - |
| GET | `/monitoring/errors` | JWT | ...ADMINS | global only | query: raw limit | - |
| POST | `/monitoring/test-error` | JWT | ...ADMINS | global only | - | - |
| GET | `/monitoring/traces` | JWT | ...ADMINS | global only | query: raw limit; raw minMs | - |
| GET | `/monitoring/traces/:traceId` | JWT | ...ADMINS | global only | path: traceId (string) | - |
| GET | `/cron/:job` | Public | - | global only | - | public route; Vercel Cron; needs `Bearer CRON_SECRET` (32+ chars), else 401 (503 when unset) |
| GET | `/metrics` | Public | - | global only | - | public route; needs METRICS_TOKEN or an admin bearer token, else 401 |

## modules/oauth/oauth

Owner: caller (link/unlink) or none (sign-in) · Mechanism: signed single-use state; link flows use the authenticated user id · Sensitive data: provider links · Coverage: oauth e2e

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/auth/google` | Public | - | global only | - | - |
| GET | `/auth/google/callback` | Public | - | 20/60s | query: raw code:string; raw state:string; raw error:string | - |
| GET | `/auth/microsoft` | Public | - | global only | - | - |
| GET | `/auth/microsoft/callback` | Public | - | 20/60s | query: raw code:string; raw state:string; raw error:string | - |
| POST | `/auth/oauth/token` | Public | - | 20/60s | body: inline object (not validated by the pipe) | P7-12: inline body type, shape checked in the handler or service only |
| POST | `/auth/link-provider` | JWT | any signed-in customer | global only | body: inline object (not validated by the pipe) | P7-12: inline body type, shape checked in the handler or service only |
| POST | `/auth/unlink-provider` | JWT | any signed-in customer | global only | body: inline object (not validated by the pipe) | P7-12: inline body type, shape checked in the handler or service only |

## modules/payment/billing

Owner: caller (token sub) · Mechanism: invoices by id AND user id; refunds role-gated · Sensitive data: own invoices, plan · Coverage: billing e2e, authorization (A vs B)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/billing/subscription` | JWT | any signed-in customer | global only | - | - |
| GET | `/billing/topup/quote` | JWT | any signed-in customer | global only | query: raw credits:string | - |
| GET | `/billing/history` | JWT | any signed-in customer | global only | query: raw page; raw limit | - |
| GET | `/billing/invoices` | JWT | any signed-in customer | global only | - | - |
| GET | `/billing/invoices/:id` | JWT | any signed-in customer | global only | path: id (string) | - |
| GET | `/billing/invoices/:id/html` | JWT | any signed-in customer | global only | path: id (string) | - |
| POST | `/billing/admin/refunds` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO RefundPaymentDto | - |
| GET | `/billing/admin/refunds` | JWT | SUPER_ADMIN, ADMIN | global only | - | - |

## modules/payment/payment

Owner: caller (token sub) · Mechanism: order bound to user, package and amount; webhook by signature · Sensitive data: own payment state · Coverage: billing, security-hardening

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| POST | `/payments/create-order` | JWT | any signed-in customer | 20/60s | body: DTO CreatePaymentOrderDto | - |
| POST | `/payments/verify` | JWT | any signed-in customer | 20/60s | body: DTO VerifyPaymentDto | - |
| POST | `/payments/topup/order` | JWT | any signed-in customer | 20/60s | body: DTO CreateTopUpOrderDto | - |
| POST | `/payments/topup/verify` | JWT | any signed-in customer | 20/60s | body: DTO VerifyTopUpDto | - |
| POST | `/payments/webhook` | Public | - | global only | - | - |
| GET | `/payments/history` | JWT | any signed-in customer | global only | - | - |

## modules/people/ingestion/bundle/people-bundle-import

Owner: role only · Mechanism: ADMIN/SUPER_ADMIN guard · Sensitive data: people import · Coverage: admin-people-import, authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| POST | `/admin/people/import/bundle/validate` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO PeopleBundleImportDto | - |
| POST | `/admin/people/import/bundle` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO PeopleBundleImportDto | - |
| GET | `/admin/people/import/bundle/:bundleImportId` | JWT | SUPER_ADMIN, ADMIN | global only | - | - |

## modules/people/ingestion/people-export-import

Owner: role only · Mechanism: ADMIN/SUPER_ADMIN guard · Sensitive data: people import jobs · Coverage: admin-people-import, authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| POST | `/admin/people/import` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO PeopleExportImportDto | - |
| GET | `/admin/people/import` | JWT | SUPER_ADMIN, ADMIN | global only | query: DTO PeopleImportHistoryQueryDto | - |
| GET | `/admin/people/import/:jobId` | JWT | SUPER_ADMIN, ADMIN | global only | - | - |

## modules/people/metrics/metrics

Owner: role only · Mechanism: ADMIN/SUPER_ADMIN guard · Sensitive data: data-quality metrics · Coverage: authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/internal/people-metrics/overview` | JWT | SUPER_ADMIN, ADMIN | global only | query: DTO MetricsRangeDto | - |
| GET | `/internal/people-metrics/problem-batches` | JWT | SUPER_ADMIN, ADMIN | global only | query: DTO ProblemBatchesQueryDto | - |

## modules/people/people

Owner: shared record + caller unlock state · Mechanism: published/approved only; contact values withheld until the caller unlocks; suppression re-checked in the unlock transaction · Sensitive data: masked or unlocked person contacts · Coverage: people-lifecycle e2e (not re-tested in Phase 5)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/companies/:businessId/people` | JWT | any signed-in customer | global only | query: DTO CompanyPeopleQueryDto; path: businessId (string) | - |
| GET | `/people/taxonomy` | JWT | any signed-in customer | global only | - | - |
| GET | `/people/unlocked` | JWT | any signed-in customer | global only | query: DTO UnlockedPeopleQueryDto | - |
| POST | `/people/export` | JWT | any signed-in customer | global only | body: DTO PeopleExportDto | - |
| GET | `/people/:personId` | JWT | any signed-in customer | global only | path: personId (UUID pipe) | - |
| POST | `/people/:personId/unlock` | JWT | any signed-in customer | global only | path: personId (UUID pipe) | - |

## modules/people/review/people-review

Owner: role only · Mechanism: ADMIN/SUPER_ADMIN (reads also DATA_MANAGER) · Sensitive data: internal review, quarantine, suppression · Coverage: people-lifecycle, authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/internal/people-review/stats` | JWT | SUPER_ADMIN, ADMIN, DATA_MANAGER | global only | - | - |
| GET | `/internal/people-review/queue` | JWT | SUPER_ADMIN, ADMIN, DATA_MANAGER | global only | query: DTO ReviewQueueQueryDto | - |
| GET | `/internal/people-review/triage` | JWT | SUPER_ADMIN, ADMIN, DATA_MANAGER | global only | query: DTO TriageQueryDto | - |
| GET | `/internal/people-review/roles/:id` | JWT | SUPER_ADMIN, ADMIN, DATA_MANAGER | global only | path: id (UUID pipe) | - |
| POST | `/internal/people-review/roles/:id/approve` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO ApproveDto; path: id (UUID pipe) | - |
| PATCH | `/internal/people-review/roles/:id` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO RoleEditDto; path: id (UUID pipe) | - |
| POST | `/internal/people-review/roles/:id/edit-and-approve` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO EditAndApproveDto; path: id (UUID pipe) | - |
| POST | `/internal/people-review/roles/:id/reject` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO ReasonDto; path: id (UUID pipe) | - |
| POST | `/internal/people-review/roles/:id/quarantine` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO ReasonDto; path: id (UUID pipe) | - |
| POST | `/internal/people-review/roles/:id/reopen` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO ReasonDto; path: id (UUID pipe) | - |
| POST | `/internal/people-review/roles/:id/unpublish` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO ReasonDto; path: id (UUID pipe) | - |
| POST | `/internal/people-review/people/:personId/suppress` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO ReasonDto; path: personId (UUID pipe) | - |
| POST | `/internal/people-review/contacts/:id/publish` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO ReasonDto; path: id (UUID pipe) | - |
| POST | `/internal/people-review/contacts/:id/unpublish` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO ReasonDto; path: id (UUID pipe) | - |
| GET | `/internal/people-review/quarantine` | JWT | SUPER_ADMIN, ADMIN, DATA_MANAGER | global only | query: DTO QuarantineQueryDto | - |
| GET | `/internal/people-review/quarantine/:id` | JWT | SUPER_ADMIN, ADMIN, DATA_MANAGER | global only | path: id (UUID pipe) | - |
| POST | `/internal/people-review/quarantine/:id/resolve` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO ReasonDto; path: id (UUID pipe) | - |
| POST | `/internal/people-review/quarantine/:id/retry` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO RetryPatchDto; path: id (UUID pipe) | - |
| POST | `/internal/people-review/quarantine/:id/reject` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO ReasonDto; path: id (UUID pipe) | - |
| POST | `/internal/people-review/quarantine/:id/suppress` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO QuarantineSuppressDto; path: id (UUID pipe) | - |

## modules/people/verification/people-verification

Owner: role only · Mechanism: ADMIN/SUPER_ADMIN (reads also DATA_MANAGER) · Sensitive data: internal verification state · Coverage: people-lifecycle, authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/internal/people-verification/roles/:id` | JWT | SUPER_ADMIN, ADMIN, DATA_MANAGER | global only | path: id (UUID pipe) | - |
| POST | `/internal/people-verification/roles/:id/verify` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO VerifyClaimDto; path: id (UUID pipe) | - |
| POST | `/internal/people-verification/roles/:id/dispute` | JWT | SUPER_ADMIN, ADMIN | global only | body: DTO DisputeClaimDto; path: id (UUID pipe) | - |

## modules/privacy/privacy

Owner: caller (token sub) · Mechanism: consents, export, deletion and requests all keyed by token user id; admin list is role-gated · Sensitive data: own consents and requests · Coverage: privacy integration spec; authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/privacy/consents` | JWT | any signed-in customer | global only | - | - |
| PUT | `/privacy/consents` | JWT | any signed-in customer | global only | body: DTO SetConsentDto | - |
| POST | `/privacy/export` | JWT | any signed-in customer | 3/3600s | - | - |
| GET | `/privacy/requests` | JWT | any signed-in customer | global only | - | - |
| POST | `/privacy/delete` | JWT | any signed-in customer | 5/3600s | body: DTO RequestDeletionDto | - |
| DELETE | `/privacy/delete` | JWT | any signed-in customer | global only | - | - |
| GET | `/privacy/admin/requests` | JWT | SUPER_ADMIN, ADMIN | global only | - | - |

## modules/saved-leads/saved-leads

Owner: caller (token sub) · Mechanism: list filtered by user id; update/remove read-then-check owner; bulk delete has user id in WHERE · Sensitive data: own notes, tags, stages · Coverage: access-model, security-hardening

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| POST | `/saved-leads` | JWT | any signed-in customer | global only | body: DTO SaveLeadDto | - |
| GET | `/saved-leads` | JWT | any signed-in customer | global only | query: DTO QuerySavedLeadsDto | - |
| PATCH | `/saved-leads/:id` | JWT | any signed-in customer | global only | body: DTO UpdateSavedLeadDto | SG-21: write by id after owner read (P3) |
| DELETE | `/saved-leads/:id` | JWT | any signed-in customer | global only | - | SG-21: write by id after owner read (P3) |
| POST | `/saved-leads/bulk-save` | JWT | any signed-in customer | 10/60s | body: DTO BulkSaveLeadsDto | SG-21: write by id after owner read (P3) |
| POST | `/saved-leads/bulk-delete` | JWT | any signed-in customer | 10/60s | body: DTO BulkDeleteLeadsDto | SG-21: write by id after owner read (P3) |

## modules/saved-searches/saved-searches

Owner: caller (token sub) · Mechanism: findById then owner check (404 for others); list by user id · Sensitive data: own filters · Coverage: access-model, security-hardening

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| POST | `/saved-searches` | JWT | any signed-in customer | global only | body: DTO CreateSavedSearchDto | - |
| GET | `/saved-searches` | JWT | any signed-in customer | global only | - | - |
| GET | `/saved-searches/:id` | JWT | any signed-in customer | global only | - | SG-21: write by id after owner read (P3) |
| PATCH | `/saved-searches/:id` | JWT | any signed-in customer | global only | body: DTO UpdateSavedSearchDto | SG-21: write by id after owner read (P3) |
| DELETE | `/saved-searches/:id` | JWT | any signed-in customer | global only | - | SG-21: write by id after owner read (P3) |
| POST | `/saved-searches/:id/run` | JWT | any signed-in customer | global only | - | SG-21: write by id after owner read (P3) |

## modules/settings/settings

Owner: caller (token sub) · Mechanism: identity from token; DTOs whitelisted; API keys by id AND user id · Sensitive data: own settings, API key metadata (hash never returned) · Coverage: api-keys, security-hardening, authorization (mass assignment)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/settings` | JWT | any signed-in customer | global only | - | - |
| PATCH | `/settings/company` | JWT | any signed-in customer | global only | body: DTO UpdateCompanyDetailsDto | - |
| PATCH | `/settings/notifications` | JWT | any signed-in customer | global only | body: DTO UpdateNotificationPreferencesDto | - |
| PATCH | `/settings/preferences` | JWT | any signed-in customer | global only | body: DTO UpdateAppPreferencesDto | - |
| PATCH | `/settings/billing` | JWT | any signed-in customer | global only | body: DTO UpdateBillingPreferencesDto | - |
| POST | `/settings/api-keys` | JWT | any signed-in customer | global only | body: DTO CreateApiKeyDto | - |
| GET | `/settings/api-keys` | JWT | any signed-in customer | global only | - | - |
| DELETE | `/settings/api-keys/:id` | JWT | any signed-in customer | global only | - | SG-21: write by id after owner read (P3) |

## modules/traffic/traffic

Owner: role only · Mechanism: ADMIN guard; refuses rules that would lock out the caller · Sensitive data: IP rules, blocks, per-user limits · Coverage: traffic-control, authorization sweep

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/traffic/my-limits` | JWT | any signed-in customer | global only | - | - |
| GET | `/traffic/limits` | JWT | ...ADMINS | global only | - | - |
| GET | `/traffic/stats` | JWT | ...ADMINS | global only | - | - |
| GET | `/traffic/ip-rules` | JWT | ...ADMINS | global only | - | - |
| POST | `/traffic/ip-rules` | JWT | ...ADMINS | global only | body: DTO IpRuleDto | - |
| DELETE | `/traffic/ip-rules/:id` | JWT | ...ADMINS | global only | path: id (string) | - |
| GET | `/traffic/blocks` | JWT | ...ADMINS | global only | query: raw limit | - |
| POST | `/traffic/blocks` | JWT | ...ADMINS | global only | body: DTO BlockDto | - |
| DELETE | `/traffic/blocks/:id` | JWT | ...ADMINS | global only | path: id (string) | - |
| GET | `/traffic/users/:userId/limits` | JWT | ...ADMINS | global only | path: userId (string) | - |
| PUT | `/traffic/users/:userId/limits` | JWT | ...ADMINS | global only | body: DTO UserLimitDto; path: userId (string) | - |
| DELETE | `/traffic/users/:userId/limits` | JWT | ...ADMINS | global only | path: userId (string) | - |

## modules/unlock/unlock

Owner: caller (token sub) · Mechanism: unlock, status and history keyed by token user id; ownership never taken from the body · Sensitive data: own unlock records · Coverage: lead-discovery-unlock, authorization (shared vs private)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| POST | `/unlock/business` | JWT | any signed-in customer | 30/60s | body: DTO UnlockBusinessDto | - |
| GET | `/unlock/history` | JWT | any signed-in customer | global only | query: raw page; raw limit | SG-13: ignores unpublish state (P2); page and limit bounded in Phase 7 |
| GET | `/unlock/status/:businessId` | JWT | any signed-in customer | global only | path: businessId (string) | - |

## modules/user/user

Owner: caller (token sub) · Mechanism: profile, settings, password by token user id; DTO whitelist (forbidNonWhitelisted) · Sensitive data: own profile · Coverage: auth e2e, authorization (mass assignment)

| Method | Route | Auth | Role | Route limit | Input validation | Identified weakness |
|---|---|---|---|---|---|---|
| GET | `/user/profile` | JWT | any signed-in customer | global only | - | - |
| GET | `/user/me` | JWT | any signed-in customer | global only | - | - |
| PATCH | `/user/profile` | JWT | any signed-in customer | global only | body: DTO UpdateProfileDto | - |
| POST | `/user/avatar` | JWT | any signed-in customer | global only | body: DTO UploadAvatarDto | - |
| POST | `/user/change-password` | JWT | any signed-in customer | global only | body: DTO ChangePasswordDto | - |
| PATCH | `/user/settings` | JWT | any signed-in customer | global only | body: DTO UpdateUserSettingsDto | AZ-01 fixed: open-ended metadata merge |

## Phase 25: privileged operations inventory (2026-10-12)

Source: the running application's route metadata (212 routes: 39 public, **83 role-restricted**, the rest need a signed-in customer), plus the web gateway's native handlers. Authentication for every row: a valid access token (HS256, issuer and audience checked) **and** an ACTIVE persisted account; for role-restricted routes the role is read from the **database** on every request (`RolesGuard`), never from the token. A token without a session id is accepted only where it predates Phase 25; administrator tokens now carry one and are revoked by logout or a newer sign-in. Roles in the model: SUPER_ADMIN, ADMIN, DATA_MANAGER, MEMBER, USER. **Every one of the 83 privileged routes allows ADMIN and SUPER_ADMIN; seven read-only People-review routes also allow DATA_MANAGER. No route is SUPER_ADMIN-only** (R-035).

| Area | Operations (routes) | Required role | Enforced in | Sensitive data touched | Audit event | Tests |
|---|---|---|---|---|---|---|
| User, role and admin-account management | **None exist in the API or the gateway.** Roles and account status change only in the database or by the seed script; the first administrator comes from `drizzle:seed` (SUPER_ADMIN, no built-in password) | n/a | n/a | n/a | none (R-034 gap G-2) | `privileged-operations.e2e-spec.ts` pins that no route changes a role, status or permission |
| Administrator sign-in / sign-out | `POST admin/auth/send-otp`, `verify-otp`, `logout` (API and gateway-native) | e-mail on the allowed domain **and** a persisted ADMIN/SUPER_ADMIN, ACTIVE | `admin-auth.controller.ts`; gateway `handleAdminVerifyOtp` | one-time code (HMAC, single use, attempt cap) | `ADMIN_OTP_FAILED`, `ADMIN_OTP_UNAUTHORIZED_DOMAIN`, `ADMIN_LOGIN_SUCCESS`, `ADMIN_LOGOUT` (gateway path added in Phase 25) | `admin-auth.e2e-spec.ts` 13, `admin-session.e2e-spec.ts` 8, gateway HTTP check (outside the repository) |
| Import, validation and publication | `admin/import/*` (21 routes: preview, submit, csv, publish-batch, reports, retry, correct, reprocess-people) | ADMIN / SUPER_ADMIN | `@Roles` + `RolesGuard`; source-trust gate in the publishing service | company records, raw rows | `IMPORT_BATCH_SUBMITTED`, `IMPORT_BATCH_PUBLISH_RUN`, `PUBLISH_REFUSED`, `IMPORT_FAILED_ROWS_RETRIED`, `IMPORT_RECORD_CORRECTED`, `IMPORT_PEOPLE_REPROCESSED` | `provenance-publishing.e2e-spec.ts` 27, `admin-authorization.e2e-spec.ts` |
| Source approval and provenance | `admin/import/sources` (register, `PATCH :id/trust`, release-held, impact, quality) | ADMIN / SUPER_ADMIN | `ImportSourcesController` + `SourceTrustService` | source register | `SOURCE_REGISTERED`, `SOURCE_APPROVED`, `SOURCE_RESTRICTED`, `SOURCE_REVOKED`, `SOURCE_TRUST_RESET`, `SOURCE_HELD_RELEASED` (best-effort row, written after the change, not in its transaction) | `provenance-publishing.e2e-spec.ts`, `privileged-operations.e2e-spec.ts` (customer refused) |
| Duplicate resolution and merging | import review decisions; gateway `admin/duplicates` (native fallback only) | ADMIN / SUPER_ADMIN | review service; gateway route policy | candidate records | `IMPORT_REVIEW_DECISION`, `IMPORT_REVIEW_REFUSED`; the gateway fallback writes none | provenance e2e |
| People review and verification | `internal/people-review/*` (20), `internal/people-verification/*` (3), `internal/people-metrics/*` (2) | ADMIN / SUPER_ADMIN; **DATA_MANAGER read-only on 7 GET routes** | `@Roles` | named individuals' roles and contacts | `PEOPLE_ROLE_*`, `PEOPLE_CONTACT_*`, `PEOPLE_PERSON_SUPPRESSED`, `PEOPLE_CLAIM_*`, `PEOPLE_QUARANTINE_*` | `authorization.e2e-spec.ts`, People integration suites |
| Credits | `POST credit/admin/adjust`, `PUT credit/admin/config`, packages create/update/delete | ADMIN / SUPER_ADMIN | `CreditController`; adjustment is one transaction with row lock | wallets, price list | `CREDIT_ADJUSTMENT` (same transaction), `PRICING_SETTING_UPDATED`, **`CREDIT_PACKAGE_CREATED/UPDATED/DELETED` (added in Phase 25; package changes were unaudited)** | `privileged-operations.e2e-spec.ts` 18, `financial-integrity.e2e-spec.ts` 26, `pg-concurrency` 7 |
| Billing administration | `POST/GET billing/admin/refunds` | ADMIN / SUPER_ADMIN | `BillingController` | payments | `PAYMENT_REFUNDED` | `financial-integrity`, `billing.e2e-spec.ts`, privileged-operations (customer refused, unknown payment changes nothing) |
| Data access and bulk export | `GET exports/admin/audit`; gateway `admin/users`, `admin/transactions`, `admin/activity-logs` (read-only; **`activity-logs` is an audit-read view of the last 50 rows with the actor's e-mail and the event details**) | ADMIN / SUPER_ADMIN | `@Roles`; gateway `requirePersistedAdmin` | customer e-mails, balances, audit rows | none for reads | `authorization.e2e-spec.ts`; gateway policy tests |
| Customer data removal (business records) | gateway `DELETE admin/businesses` (hard delete of a business and its contacts), `POST admin/businesses` (status) | ADMIN / SUPER_ADMIN | gateway `requirePersistedAdmin` | company records | `ADMIN_BUSINESS_DELETE`, `ADMIN_BUSINESS_STATUS_UPDATE`, `ADMIN_BUSINESS_PUBLISH_REFUSED` | publish guard (Phase 22/23) |
| Privacy requests, deletion and suppression | `GET privacy/admin/requests` (read). **Suppression, deletion and retention have no HTTP route for overrides**: `ContactSuppressionService` and the jobs are internal; suppression rows cannot be edited or deleted (database triggers); People suppression is `POST ...people/:id/suppress` (add only) | ADMIN / SUPER_ADMIN | triggers + `@Roles` | digests, requests | `PRIVACY_*`, `CONTACT_SUPPRESSION_*`, `PEOPLE_PERSON_SUPPRESSED`, `RETENTION_JOB_*`, `PRIVACY_DELETE_FAILED` | `retention-lifecycle.integration.spec.ts`, privileged-operations (no route can remove a suppression) |
| Retention, backup, restore | scripts only (`db:retention`, `db:ledger`, `backup.sh`, `restore.sh`); no HTTP route | operator with host access; the scripts refuse non-local databases and need `--apply` + confirmation + a fresh backup | `db-guard.ts` | everything | `RETENTION_JOB_*`, `POST_RESTORE_RECONCILED` | `retention-lifecycle.integration.spec.ts` |
| Security configuration | `traffic/*` (11: IP rules, blocks, per-user limits), `credit/admin/config` | ADMIN / SUPER_ADMIN | `TrafficController` | block lists | `TRAFFIC_IP_RULE_*`, `TRAFFIC_BLOCK_*`, `TRAFFIC_USER_LIMIT_*` | `traffic-control.e2e-spec.ts` |
| Monitoring and diagnostics | `monitoring/*` (9), `integrations/admin/health`, `metrics` (token or administrator) | ADMIN / SUPER_ADMIN | `@Roles` | operational state | none for reads or `test-error` | `security-monitoring.e2e-spec.ts`, `monitoring.e2e-spec.ts` |

Background work (schedulers, queue workers, retention, export schedules, webhook dispatch) runs inside the API process with the application's database role; **no separate restricted service identity exists** and locally that role is the PostgreSQL superuser (decision #8 in the checkpoint: a least-privilege `orion_app` role is drafted, not applied).

## Phase 25: privileged operations inventory (2026-10-12)

Source: the running application's route metadata (212 routes: 39 public, **83 role-restricted**, the rest need a signed-in customer), plus the web gateway's native handlers. Authentication for every row: a valid access token (HS256, issuer and audience checked) **and** an ACTIVE persisted account; for role-restricted routes the role is read from the **database** on every request (`RolesGuard`), never from the token. A token without a session id is accepted only where it predates Phase 25; administrator tokens now carry one and are revoked by logout or a newer sign-in. Roles in the model: SUPER_ADMIN, ADMIN, DATA_MANAGER, MEMBER, USER. **Every one of the 83 privileged routes allows ADMIN and SUPER_ADMIN; seven read-only People-review routes also allow DATA_MANAGER. No route is SUPER_ADMIN-only** (R-035).

| Area | Operations (routes) | Required role | Enforced in | Sensitive data touched | Audit event | Tests |
|---|---|---|---|---|---|---|
| User, role and admin-account management | **None exist in the API or the gateway.** Roles and account status change only in the database or by the seed script; the first administrator comes from `drizzle:seed` (SUPER_ADMIN, no built-in password) | n/a | n/a | n/a | none (R-034 gap G-2) | `privileged-operations.e2e-spec.ts` pins that no route changes a role, status or permission |
| Administrator sign-in / sign-out | `POST admin/auth/send-otp`, `verify-otp`, `logout` (API and gateway-native) | e-mail on the allowed domain **and** a persisted ADMIN/SUPER_ADMIN, ACTIVE | `admin-auth.controller.ts`; gateway `handleAdminVerifyOtp` | one-time code (HMAC, single use, attempt cap) | `ADMIN_OTP_FAILED`, `ADMIN_OTP_UNAUTHORIZED_DOMAIN`, `ADMIN_LOGIN_SUCCESS`, `ADMIN_LOGOUT` (gateway path added in Phase 25) | `admin-auth.e2e-spec.ts` 13, `admin-session.e2e-spec.ts` 8, gateway HTTP check (outside the repository) |
| Import, validation and publication | `admin/import/*` (21 routes: preview, submit, csv, publish-batch, reports, retry, correct, reprocess-people) | ADMIN / SUPER_ADMIN | `@Roles` + `RolesGuard`; source-trust gate in the publishing service | company records, raw rows | `IMPORT_BATCH_SUBMITTED`, `IMPORT_BATCH_PUBLISH_RUN`, `PUBLISH_REFUSED`, `IMPORT_FAILED_ROWS_RETRIED`, `IMPORT_RECORD_CORRECTED`, `IMPORT_PEOPLE_REPROCESSED` | `provenance-publishing.e2e-spec.ts` 27, `admin-authorization.e2e-spec.ts` |
| Source approval and provenance | `admin/import/sources` (register, `PATCH :id/trust`, release-held, impact, quality) | ADMIN / SUPER_ADMIN | `ImportSourcesController` + `SourceTrustService` | source register | `SOURCE_REGISTERED`, `SOURCE_APPROVED`, `SOURCE_RESTRICTED`, `SOURCE_REVOKED`, `SOURCE_TRUST_RESET`, `SOURCE_HELD_RELEASED` (best-effort row, written after the change, not in its transaction) | `provenance-publishing.e2e-spec.ts`, `privileged-operations.e2e-spec.ts` (customer refused) |
| Duplicate resolution and merging | import review decisions; gateway `admin/duplicates` (native fallback only) | ADMIN / SUPER_ADMIN | review service; gateway route policy | candidate records | `IMPORT_REVIEW_DECISION`, `IMPORT_REVIEW_REFUSED`; the gateway fallback writes none | provenance e2e |
| People review and verification | `internal/people-review/*` (20), `internal/people-verification/*` (3), `internal/people-metrics/*` (2) | ADMIN / SUPER_ADMIN; **DATA_MANAGER read-only on 7 GET routes** | `@Roles` | named individuals' roles and contacts | `PEOPLE_ROLE_*`, `PEOPLE_CONTACT_*`, `PEOPLE_PERSON_SUPPRESSED`, `PEOPLE_CLAIM_*`, `PEOPLE_QUARANTINE_*` | `authorization.e2e-spec.ts`, People integration suites |
| Credits | `POST credit/admin/adjust`, `PUT credit/admin/config`, packages create/update/delete | ADMIN / SUPER_ADMIN | `CreditController`; adjustment is one transaction with row lock | wallets, price list | `CREDIT_ADJUSTMENT` (same transaction), `PRICING_SETTING_UPDATED`, **`CREDIT_PACKAGE_CREATED/UPDATED/DELETED` (added in Phase 25; package changes were unaudited)** | `privileged-operations.e2e-spec.ts` 18, `financial-integrity.e2e-spec.ts` 26, `pg-concurrency` 7 |
| Billing administration | `POST/GET billing/admin/refunds` | ADMIN / SUPER_ADMIN | `BillingController` | payments | `PAYMENT_REFUNDED` | `financial-integrity`, `billing.e2e-spec.ts`, privileged-operations (customer refused, unknown payment changes nothing) |
| Data access and bulk export | `GET exports/admin/audit`; gateway `admin/users`, `admin/transactions`, `admin/activity-logs` (read-only; **`activity-logs` is an audit-read view of the last 50 rows with the actor's e-mail and the event details**) | ADMIN / SUPER_ADMIN | `@Roles`; gateway `requirePersistedAdmin` | customer e-mails, balances, audit rows | none for reads | `authorization.e2e-spec.ts`; gateway policy tests |
| Customer data removal (business records) | gateway `DELETE admin/businesses` (hard delete of a business and its contacts), `POST admin/businesses` (status) | ADMIN / SUPER_ADMIN | gateway `requirePersistedAdmin` | company records | `ADMIN_BUSINESS_DELETE`, `ADMIN_BUSINESS_STATUS_UPDATE`, `ADMIN_BUSINESS_PUBLISH_REFUSED` | publish guard (Phase 22/23) |
| Privacy requests, deletion and suppression | `GET privacy/admin/requests` (read). **Suppression, deletion and retention have no HTTP route for overrides**: `ContactSuppressionService` and the jobs are internal; suppression rows cannot be edited or deleted (database triggers); People suppression is `POST ...people/:id/suppress` (add only) | ADMIN / SUPER_ADMIN | triggers + `@Roles` | digests, requests | `PRIVACY_*`, `CONTACT_SUPPRESSION_*`, `PEOPLE_PERSON_SUPPRESSED`, `RETENTION_JOB_*`, `PRIVACY_DELETE_FAILED` | `retention-lifecycle.integration.spec.ts`, privileged-operations (no route can remove a suppression) |
| Retention, backup, restore | scripts only (`db:retention`, `db:ledger`, `backup.sh`, `restore.sh`); no HTTP route | operator with host access; the scripts refuse non-local databases and need `--apply` + confirmation + a fresh backup | `db-guard.ts` | everything | `RETENTION_JOB_*`, `POST_RESTORE_RECONCILED` | `retention-lifecycle.integration.spec.ts` |
| Security configuration | `traffic/*` (11: IP rules, blocks, per-user limits), `credit/admin/config` | ADMIN / SUPER_ADMIN | `TrafficController` | block lists | `TRAFFIC_IP_RULE_*`, `TRAFFIC_BLOCK_*`, `TRAFFIC_USER_LIMIT_*` | `traffic-control.e2e-spec.ts` |
| Monitoring and diagnostics | `monitoring/*` (9), `integrations/admin/health`, `metrics` (token or administrator) | ADMIN / SUPER_ADMIN | `@Roles` | operational state | none for reads or `test-error` | `security-monitoring.e2e-spec.ts`, `monitoring.e2e-spec.ts` |

Background work (schedulers, queue workers, retention, export schedules, webhook dispatch) runs inside the API process with the application's database role; **no separate restricted service identity exists** and locally that role is the PostgreSQL superuser (decision #8 in the checkpoint: a least-privilege `orion_app` role is drafted, not applied).

## Phase 28 note

The request/response contract of each workflow, the validation status of request bodies (all DTO classes except four administrator import routes), the error envelope and the gateway/API split are in `API_CONTRACT_REVIEW.md`. The route list in this file is unchanged by Phase 28: no route was added, removed or re-authorised.
