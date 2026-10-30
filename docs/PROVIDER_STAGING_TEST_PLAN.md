# Provider-backed staging test plan

**Date:** 2026-10-29 · **Status:** PLAN ONLY. Nothing in this document has been executed. No payment was created, no email sent, no cloud setting changed, no provider contacted.

## 0. Rules for executing this plan
1. **Approval gate.** Each section below needs the owner's explicit written approval before it runs, naming the environment and the account used. Sections are independent.
2. **Staging only.** Run against a dedicated staging deployment with its own database, its own R2 bucket and its own provider keys. Never against `orion_db`, a production host or a bucket holding customer data. Confirm the target before each run (print the host names, never the secrets).
3. **Synthetic data only.** Test accounts use a mailbox domain you own (for example `uat+NN@<your-test-domain>`), test names and no real customer data.
4. **Test mode only.** Razorpay keys must be `rzp_test_…`. The application already refuses a test key in production and a live key is never used here. Do not enter a real card; use Razorpay's published test cards/UPI.
5. **Credentials.** Keys are put in the staging host's environment by the operator. They are never pasted into chat, committed, or written into test code.
6. **Evidence.** Each case records: command or steps, timestamp, environment name, observed result, and a screenshot or log excerpt with secrets redacted.
7. **Labels.** Results are reported as **MOCKED** (existing automated suites, no provider involved) or **PROVIDER-BACKED** (real provider endpoint in test mode). Only PROVIDER-BACKED results may be cited as provider verification.

## 1. What is mocked today vs what needs a provider

| Capability | Existing automated coverage (MOCKED) | Not covered until provider-backed |
|---|---|---|
| Razorpay order creation | Unit/integration tests with a stubbed client; local mock orders when `RAZORPAY_API_MODE` is not `live` | Real `POST /v1/orders`, the checkout widget, `verify` with a real signature |
| Razorpay webhook | HMAC-SHA256 over raw bytes, fail-closed, replay, concurrent delivery, tampered/re-serialised body (documented in `PRODUCTION_READINESS.md`) | Real Razorpay delivery, headers, retries and event shapes |
| Idempotent crediting | Atomic credit in `payment.service.ts`, tests for double verify and concurrent delivery | Same order arriving through both `verify` and the webhook from the real provider |
| R2 / S3 storage | `FakeStorage` and in-memory stubs; S3 provider unit tests | Real upload/download/signed access/permissions on the `orion` bucket |
| Email | `MAIL_TRANSPORT=webhook` to a local sink; Resend transport unit tests | Delivery through Resend: domain verification (SPF/DKIM), inbox placement, links |
| CAPTCHA (Turnstile) | Mocked `siteverify` in web tests | Real widget + real server verification, including failure and timeout |
| Google / Microsoft OAuth | Mocked provider exchange; simulation refused outside test | Real consent screen, callback URLs, account linking, verified-email rule |

## 2. Razorpay (test mode)

**Preconditions:** staging API with `RAZORPAY_API_MODE=live` and `rzp_test_` key id/secret and a webhook secret set by the operator; webhook endpoint `POST <staging-api>/api/v1/payments/webhook` registered in the Razorpay test dashboard; a staging user with a known credit balance.

| ID | Case | Expected |
|---|---|---|
| RZ-01 | Preflight: the app's own diagnostic (`RazorpayService.diagnose`) reports mode `live-api`, key mode `test`, secret and webhook secret present | No refusals listed |
| RZ-02 | Create order for Starter (₹99) | Real `order_…` id from Razorpay, amount 9900 paise, order persisted/linked to user |
| RZ-03 | Pay with a Razorpay test card/UPI in the checkout; `verify` called by the browser | Signature verifies, wallet credited exactly 100 credits once, invoice created |
| RZ-04 | Webhook `payment.captured` for the same payment arrives after RZ-03 | No second credit (idempotent); ledger has one entry for the payment id |
| RZ-05 | Webhook arrives **before** `verify` | Credited once; later `verify` is a no-op |
| RZ-06 | Resend the same webhook event 5 times, then 5 concurrently | Credits unchanged after the first; all return success without side effects |
| RZ-07 | Invalid signature, missing signature, altered body, re-serialised JSON | Rejected, nothing credited, no information leak |
| RZ-08 | Amount/package tampering in `verify` body (client sends different package) | Credited amount is the server-side package amount |
| RZ-09 | Failed payment (test failure card) | No credit; failure recorded; user sees a clear error |
| RZ-10 | Refund of a captured test payment from the dashboard | Behaviour documented (known gap: no refund policy for unlocked leads); record actual outcome, do not assume |
| RZ-11 | Run `npm run db:reconcile-credits` (read-only) on the staging database after RZ-03..RZ-09 | Zero hard failures; ledger sums match wallets |

## 3. Cloudflare R2 (storage)

**Preconditions:** a **separate staging bucket** (do not use the `orion` bucket until its contents and access policy have been reviewed by the owner), API token scoped to that bucket only, `STORAGE_PROVIDER` set for S3-compatible access.

| ID | Case | Expected |
|---|---|---|
| R2-01 | Health: storage probe reports up | `/health` storage `up` |
| R2-02 | Admin import upload (CSV) then read back by the import job | Object stored under the expected key; job processes it |
| R2-03 | Customer CSV export is written and downloaded by the owning user | Download works; content matches |
| R2-04 | Another user requests the first user's export/object | 403/404, never the file |
| R2-05 | Anonymous request to a direct object URL and to a guessed key | Denied (bucket private; no public prefix) |
| R2-06 | Path traversal / odd keys in file names | Rejected or normalised; no write outside prefix |
| R2-07 | Oversized upload and wrong content type | Rejected with a clean error |
| R2-08 | Delete (retention/suppression expiry) removes the object | Object gone; ledger entry written |
| R2-09 | Bucket checks (read-only review by the owner): public access off, CORS minimal, lifecycle rules, token scope | Documented; any change is a separate approved action |

## 4. Email (Resend)

**Preconditions:** staging `MAIL_TRANSPORT=resend`, a verified sending domain, a test mailbox you control. Recipient lists are limited to that mailbox.

| ID | Case | Expected |
|---|---|---|
| EM-01 | Sign-up verification code | Mail arrives; Resend message id is logged (recent change); code works once, expires |
| EM-02 | Password reset | Link points to the **staging** host (not localhost); token single-use |
| EM-03 | Admin console sign-in code | Delivered by the API; wrong/old code refused; resend cooldown applies |
| EM-04 | Notification mail links | Correct host, no tracking of personal data in URLs |
| EM-05 | Authentication of the sending domain (SPF, DKIM, DMARC) via mail headers | Pass |
| EM-06 | Provider failure (invalid key in a throwaway staging copy) | Clear error to the user; no code leaked in logs or response |

## 5. CAPTCHA (Cloudflare Turnstile)

Use Turnstile's published **test site/secret keys** first (they always pass or always fail), then the staging widget.

| ID | Case | Expected |
|---|---|---|
| CP-01 | Sign-in and sign-up with always-pass test keys | Succeed |
| CP-02 | Always-fail test keys | Refused with a clear message; no account created |
| CP-03 | Missing or replayed token | Refused |
| CP-04 | Turnstile unreachable (block the host in a staging network rule) | Behaviour matches the documented fail-closed/open choice; record it |

## 6. OAuth (Google, Microsoft)

**Preconditions:** staging OAuth apps with staging redirect URIs only; a dedicated test Google/Microsoft account.

| ID | Case | Expected |
|---|---|---|
| OA-01 | New-user sign-up with Google | Account created, verified email honoured, session established, logout revokes the API session |
| OA-02 | Existing email/password account signs in with Google | Linking only when the provider reports a verified email; user told why no new code arrives |
| OA-03 | State parameter tampered/expired/replayed (across serverless instances) | Refused |
| OA-04 | Provider returns unverified email | Refused |
| OA-05 | Callback and post-login URLs derive from configuration (not localhost) | Correct staging URLs |
| OA-06 | Microsoft equivalents of OA-01..OA-05 | Same |
| OA-07 | Token appears in the URL fragment only, not in logs/referrer | Verified in browser dev tools and server logs |

## 7. Order of execution and exit criteria
1. R2 (low risk, no money) → 2. Email → 3. CAPTCHA → 4. OAuth → 5. Razorpay.
2. Exit: every case PASS with evidence, or an open defect with reproduction steps. Any money-related FAIL (RZ-03..RZ-08, RZ-11) is a release blocker.
3. After the run, rotate any staging key that was exposed in logs or screenshots.
