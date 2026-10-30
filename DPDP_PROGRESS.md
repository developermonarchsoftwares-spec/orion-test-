# DPDP Act (India) compliance: progress log

**Branch:** `compliance/dpdp` (local only, not pushed) · **Started:** 2026-10-30 · **Status:** engineering work done for items 1 to 9; **nothing here has had legal review** and the product is not "DPDP compliant" until the items in sections 5 and 6 are closed.

All copy is a working draft written from what the code does. Everything marked `LEGAL REVIEW` in the UI (visible amber boxes controlled by `LEGAL_REVIEW_PENDING` in `ownus/src/lib/compliance.ts`) and in this file needs a lawyer. Statements about the law below are our reading, not advice.

## 1. Audit: what personal data Orion handles (verified in the code)

### 1.1 Collection points
| Where | Data | Code |
|---|---|---|
| Sign-up (e-mail code, then account) | name, e-mail, organisation, password (bcrypt hash), IP + user agent on the code challenge | `ownus/src/app/(auth)/register/page.tsx`, `apps/api/src/auth/*`, `email_otp_challenges` |
| Sign-in | e-mail, password; IP + user agent stored with refresh tokens and audit logs | `apps/api/src/auth/*`, `refresh_tokens`, `audit_logs` |
| Google / Microsoft sign-in | name, e-mail, avatar, provider id | `apps/api/src/modules/oauth`, gateway `route.ts` |
| Forgot / reset password | e-mail | `auth.controller.ts` |
| Settings and profile | phone, organisation, avatar, notification and app preferences, MFA secret (sealed) | `ownus/src/app/(app)/settings`, `users` |
| Payments | order, invoice and Razorpay payment ids (no card data) | `apps/api/src/modules/payment`, `payment_orders`, `invoices` |
| Using the product | searches, saved leads / searches, unlocks, exports, credits ledger | `saved_*`, `lead_unlocks`, `person_unlocks`, `export_jobs`, `credit_transactions` |
| Consent and privacy requests | consent ledger with IP + user agent; privacy and data-subject requests | `consent_records`, `privacy_requests`, `data_subject_requests` |
| Integrations and API keys | webhook URLs, sealed credentials, key prefixes | `integrations`, `api_keys` |
| Server-side traffic records | IP addresses for rate limiting and traffic control | `modules/traffic`, rate-limit tables |
| **Third parties in the directory (not customers)** | names, job titles, employers, work e-mails, phones, LinkedIn URLs of decision makers and company contacts, from public registries, company sites, admin imports and the scraper | `modules/people`, `modules/business`, `modules/import`, `modules/pipeline/scraper`, `person_contacts`, `business_contacts` |

### 1.2 Trackers and scripts (precise search, 2026-10-30)
- **No analytics, advertising, pixel or session-replay code is present** in `ownus/src` or `apps/api/src` (searched for gtag/GTM, Facebook, Hotjar, Clarity, Mixpanel, Segment, PostHog, Sentry SDK, Plausible, Vercel analytics, Intercom, HubSpot, LinkedIn insight, Datadog and similar). Fonts come from `next/font` (self-hosted at build).
- The only browser-loaded third-party scripts are **Cloudflare Turnstile** (sign-in and sign-up, `components/auth/turnstile.tsx`) and **Razorpay checkout** (payment step, `lib/razorpay-checkout.ts`). Both are essential (security, payment) and are not gated.
- Server-side only: optional **Sentry-compatible error reporting** when `SENTRY_DSN` is set (`common/observability/error-tracker.ts`, with scrubbing).
- **Before this work the consent banner stored a choice that nothing read** (`analyticsAllowed()` was never called).

### 1.3 Third-party services that receive personal data
Razorpay (payments), Cloudflare Turnstile (bot check), Resend (e-mail), Google and Microsoft (optional SSO), Cloudflare R2 / S3-compatible storage (uploads, exports), Vercel and the database host (hosting; **production database host is still undecided**, Neon is being removed), optional Sentry-compatible error tracking. Listed in `THIRD_PARTIES` in `compliance.ts` and in the Privacy Notice.

## 2. What was built
| # | Request | Delivered | Files |
|---|---|---|---|
| 1 | Audit | Section 1 above | this file |
| 2 | Privacy Notice page | `/privacy-notice`: who we are, data, purposes, retention, third parties, cookies/trackers, rights, Grievance Officer, breach, changes. Visible draft banner and a `LEGAL REVIEW` box per section | `ownus/src/app/(marketing)/privacy-notice/page.tsx`, `lib/compliance.ts` |
| 3 | Opt-in consent checkboxes + records | Sign-up now has the Terms box and separate per-purpose boxes (account service required, product updates and marketing optional), all unticked; choices (including refusals) travel **with the sign-up request and are written in the same transaction as the account** (API and gateway; production refuses an account without the account consent). Google / Microsoft sign-ups and older accounts get a blocking consent dialog on first use (`ConsentGate`); withdrawing the account consent schedules the account for closure (D12 to D16) | `components/privacy/consent-checkboxes.tsx`, `consent-gate.tsx`, `lib/consent-gate.ts`, `register/page.tsx`, `apps/api/.../privacy.config.ts` (purpose `ACCOUNT_SERVICE`, `signupConsentRequired`, `parseSignupConsents`), `auth.service.ts`, gateway `lib/signup-consent.ts` |
| 4 | Tracker gating | Registry of non-essential scripts (`TRACKERS`, empty); `TrackerLoader` injects them only with consent and reloads on withdrawal; banner reopens from a footer "Privacy choices" link | `lib/trackers.ts`, `components/privacy/tracker-loader.tsx`, `privacy-choices-button.tsx`, `consent-banner.tsx`, `app/layout.tsx` |
| 5 | Grievance contact | Footer block on every marketing page, Privacy Notice section 8, data-rights page, Privacy Policy section 11 | `components/layout/footer.tsx`, `lib/compliance.ts` |
| 6 | Data-rights request form | Public `/data-rights` form (access, correction, erasure, withdrawal, grievance, nomination; works without an account) -> `POST /api/v1/privacy-requests` (public, rate limited 5/h, Turnstile when configured) -> `data_subject_requests` with reference, 30-day due date, acknowledgement e-mail; admin list `GET /privacy/admin/rights-requests`. **ERASURE** also e-mails a one-time confirmation link (`/data-rights/verify`); once confirmed, the address is suppressed (O7) | `rights-request.{controller,service}.ts`, `dto/rights-request.dto.ts`, `rights-request-form.tsx`, `app/(marketing)/data-rights/page.tsx` |
| 7 | Terms clause | Section 13 "Data Protection (DPDP Act)" with a visible draft marker | `app/(marketing)/terms/page.tsx` |
| 8 | Breach runbook | `BREACH_RUNBOOK.md`: definitions, roles, timeline (CERT-In 6 h, Board without delay, Board detailed report 72 h), containment tied to Orion's secrets, assessment questions, Board initial and detailed templates, user notice template, post-incident steps | `BREACH_RUNBOOK.md` |
| 9 | Security gaps | Section 4 below | this file |

## 3. Decision log
| ID | Decision | Why |
|---|---|---|
| D1 | New `/privacy-notice` page; the existing `/privacy` policy is kept and cross-linked | The policy is GDPR/CCPA-shaped and live; the DPDP notice has different required content. Counsel should merge them eventually |
| D2 | Do **not** bump `POLICY_VERSION` (`2026-10-07`) in web and API | A bump re-asks every visitor, and the Playwright config pre-answers the banner with that version. Bump with the legal sign-off, together with `playwright.config.ts` |
| D3 | ~~Record sign-up consents through `PUT /privacy/consents` after the account exists~~ **Superseded by D12** | The first version could miss a consent if the browser closed between account creation and the call |
| D4 | Rights requests reuse `data_subject_requests` with new `type` values (ACCESS, ERASURE, WITHDRAWAL, GRIEVANCE, NOMINATION; CORRECTION already existed) | No migration (the project's migration journal has a timestamp trap) and one queue for every request. The table has no CHECK constraints (migration 0024). Risk: code that assumes types REMOVAL / SUPPRESSION / CORRECTION / REPORT must ignore the new ones |
| D5 | The requester's e-mail is stored in `contact_email` until the request ends; the audit event holds the reference and type only | Needed to answer; minimised elsewhere |
| D6 | Repeat of an open request returns success with no reference and sends no second e-mail | Avoids enumeration and mail spam; relies on the table's unique index |
| D7 | Turnstile and Razorpay are classed as essential and not gated | Security and payment function; flagged for counsel (section 5) |
| D8 | Extended the `NEXT_PUBLIC_*` allow-list test with the four grievance / fiduciary names | Published by law, public by nature. The guard's secret-name check still applies |
| D9 | Grievance Officer name, address and fiduciary address are deploy-time variables with visible placeholders; the e-mail defaults to the already published `privacy@monarchsoftwares.com` | We must not invent a person. Set the variables before launch |
| D10 | Response periods: acknowledge in 3 working days, respond in 30 days | Matches the existing privacy policy and `REQUEST_DEADLINE_MS`; the DPDP Rules may prescribe otherwise |
| D11 | Existing Playwright sign-up tests updated to tick the new required box (and assert the optional boxes start unticked) | The form now needs two ticks; no assertion was weakened. **Not run** (see section 7) |
| D12 | Sign-up consents are sent in the register request (`consents` object) and inserted in the **same transaction** as the account: API (`AuthService.register`) and gateway (`REGISTER_WITH_PROOF_SQL_CONSENT`, one statement together with spending the e-mail proof) | The account and its consent now exist together or not at all. Only a real boolean `true` counts for the account purpose; optional purposes are stored as sent, refusals included. Source is `signup` |
| D13 | The requirement is on in production and cannot be switched off there; elsewhere `REQUIRE_SIGNUP_CONSENT=false` disables it (set in the shared test setup) | Same pattern as the sign-up code requirement; the 30+ existing suites that register directly keep working, and `signup-consent.e2e-spec.ts` turns it on |
| D14 | Google / Microsoft sign-ups cannot show a checkbox (the account is created inside the provider redirect), so a signed-in **consent gate** asks once, on first use: required unticked account box, optional boxes, no pre-ticks. Settings stays reachable so a person who does not agree can export or delete their data | Server-side blocking of API use without consent was not built (see O3b). **This also asks every older account once**, because none has a record. That is a business and legal call: remove `<ConsentGate />` from `app/(app)/layout.tsx` to switch it off |
| D15 | If the consent state cannot be loaded the gate stays out of the way | A failed lookup must not lock everyone out. The cost is that an outage hides the dialog; it appears again on the next load |
| D16 | Withdrawing `ACCOUNT_SERVICE` (`PrivacyService.setConsent`) inserts the ledger row and a pending `DELETE` request (note `CONSENT_WITHDRAWN`) in one transaction, with the normal 7-day cooling-off and an e-mail. Giving the consent back cancels only a closure that withdrawal started, never one the person requested themselves. Cancelling the deletion by hand leaves the consent withdrawn, so the gate keeps asking | Cancellable closure instead of instant erasure protects against a mis-click. Session is not ended during the 7 days; the gate blocks the app except Settings |
| D17 | An erasure request is applied only after the requester proves control of the address: the e-mailed link carries a one-time secret in the URL **fragment**; the confirmation page needs a click (scanners cannot confirm); the secret is compared with a constant-time check; the link works for 7 days; refusals all answer the same | Without proof, anyone could suppress anyone else's address. On confirmation `ContactSuppressionService.suppress` (reason `REMOVAL`) registers the address and removes company contacts, and expires stored exports that held it |
| D18 | A confirmed erasure that also matches a **person's** work e-mail stays `APPROVED` with the count in `result_summary.peopleMatchedForReview`, and keeps the requester's address; it is `COMPLETED` (address and free text cleared) otherwise | Suppressing a person is a reviewer action with an identity and an audit trail (`PeoplePublishingService.suppressPerson`); calling it from an automated public path would need a system actor and a module dependency that was not safe to add here |

## 4. Security gaps flagged (verified in code; none fixed here)
1. **CAPTCHA is not enforced unless configured, and not everywhere.** `TURNSTILE_SECRET_KEY` unset means the check silently passes (`apps/api/src/auth/captcha/captcha.service.ts`, web `lib/captcha.ts`); `env.validation.ts` does not require it in production, so a deployment missing the key runs with no bot protection and no warning. Where it *is* configured it is verified server-side with Cloudflare (fail-closed when Cloudflare is unreachable), but it is applied only to `send-otp` and `login` (and the new rights form). `forgot-password`, `reset-password`, admin OTP and OAuth have none. The browser widget also depends on `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; if only one of the two keys is set, the forms and the server disagree. **Fix:** require both keys in production, extend to the other public endpoints.
2. **Encryption of stored secrets is fail-open on the key.** `sealSecret` (`apps/api/src/auth/services/secret-box.util.ts`, MFA seeds and integration credentials) derives its AES key from `MFA_ENCRYPTION_KEY`, else `JWT_ACCESS_SECRET`, else a **constant string in the source**. With neither set it still "encrypts", with a key anyone with the code can compute, and never throws. Production refuses a missing `JWT_ACCESS_SECRET`, which limits exposure, but (a) dev/test run on the constant key, and (b) the data is keyed to the JWT secret, so the credential rotation the project already needs would make every stored MFA seed and integration credential unreadable. There is no key id or versioning (`v1` only). **Fix:** refuse to seal without an explicit key, require separate `MFA_ENCRYPTION_KEY` and `INTEGRATIONS_ENCRYPTION_KEY` in production, add key versions, plan re-encryption before rotating.
3. **HTTPS is delegated to the platform and not enforced by the app.** Positive: HSTS is sent in production (web headers and API helmet), `trust proxy` is set in production, the OAuth state cookie is `secure` outside local, and remote database connections verify TLS. Gaps: no HTTP-to-HTTPS redirect or `upgrade-insecure-requests` in the app; both Dockerfiles serve plain HTTP on 3000 and 4000 and rely on a TLS terminator that is not in the repo; `docker-compose.yml`, Typesense (`TYPESENSE_PROTOCOL` defaults to `http`) and MinIO use `http://`; the access and refresh tokens are kept in `localStorage` (`ownus/src/lib/api-client.ts`), readable by any script that runs on the page. Whether production traffic is HTTPS-only depends on Vercel or the final host and **was not verified** (nothing is deployed here). **Fix:** confirm and document the TLS terminator, redirect HTTP, move tokens to httpOnly cookies.
4. Also seen: the footer links `/about`, `/blog`, `/careers`, `/contact`, `/api-docs`, `/integrations` lead to pages that do not exist (404), so there is no working contact page; the unverified-requester rights form relies on a human to check identity; the production secrets exposed in git history (SG-02) are still unrotated according to the project's own documents.

## 5. Needs lawyer review
1. Entire Privacy Notice, the new Terms section 13, the consent texts in `PURPOSES`, the draft banners (`LEGAL_REVIEW_PENDING`) and the `/data-rights` copy.
2. **Directory data about people who are not customers:** lawful basis, whether the "made public by the Data Principal" exclusion applies to each source, how and when those people are told, and the removal route. This is the largest legal exposure in the product.
3. Notice in English **and the 22 Eighth Schedule languages** (not done); layout and "independent of other information" requirement.
4. Whether required consent for the account is the right basis, or the service falls under "legitimate uses", and whether bundling the account consent with sign-up is acceptable.
5. Whether Turnstile (loads before any choice) and Razorpay need their own disclosure or basis; processor contracts with every provider; cross-border transfers and any restricted-country rule.
6. Retention periods (tax and accounting records, import and upload data, directory data) and the DPDP erasure-on-withdrawal duty against the 7-day deletion cool-off.
7. Rights timelines, identity verification, nomination, children's data (Orion is B2B; confirm no verifiable parental consent flow is needed).
8. Significant Data Fiduciary status (DPO, audits, impact assessment), registration as a Consent Manager if relevant, and the Grievance Officer appointment.
9. Breach runbook: "without delay" and 72-hour wording, Board channel, CERT-In applicability, record-keeping period and template text.
10. **Consent gate for existing accounts** (D14): is it right to ask every older customer once, what the dialog must say, and what happens to people who never answer.
11. **Automatic closure on withdrawal** (D16): 7-day cooling-off versus the duty to stop processing on withdrawal, and what must stop immediately (exports, alerts, integrations, API keys: O4b).
12. **Erasure by e-mail proof** (D17, D18): is control of the address enough, who reviews matches against people records, and the wording of the confirmation e-mail and page.

## 6. Open items (engineering and operations)
| ID | Item | Owner |
|---|---|---|
| O1 | Appoint the Grievance Officer; set the grievance and fiduciary variables in the deployment (names listed in `compliance.ts`); flip `LEGAL_REVIEW_PENDING` to false after sign-off | Business + counsel |
| O2 | Admin screen to work the rights queue (only `GET /privacy/admin/rights-requests` exists), identity verification step, outcome e-mails, status page for the requester, and automation that executes an approved ERASURE / WITHDRAWAL / suppression (today a person must do it) | Engineering |
| O3 | ~~Consent inside registration and for OAuth sign-ups~~ **DONE** (D12 to D15). **O3b, still open:** the API does not refuse requests from an account that has no consent on record (the gate is in the web app only); an API-key or direct-API user is not asked. Decide whether to enforce server-side (a guard that checks the ledger) | Engineering + counsel |
| O4 | ~~Withdrawing ACCOUNT_SERVICE starts account closure~~ **DONE** (D16); the settings panel lists the purpose with a confirmation. **O4b, still open:** the session and API keys stay valid during the 7-day waiting period; consider ending API-key use and pausing integrations/exports/scheduled alerts when the consent is withdrawn | Engineering + counsel |
| O5 | `POLICY_VERSION` bump and re-consent after sign-off (web, API and `playwright.config.ts` together) | Engineering |
| O6 | Customer CSV / data uploads: add an explicit per-upload declaration ("I have the right to upload this data") with a stored record; no customer upload screen was found in the app, only the admin import | Engineering + counsel |
| O7 | ~~Rights requests feed the suppression service~~ **DONE for company contacts** (D17, D18). **O7b, still open:** (a) people records are only counted for a reviewer, not suppressed; the reviewer queue does not yet show these requests, and the admin list is API-only (O2); (b) only an ERASURE request suppresses; a CORRECTION that removes a value, and WITHDRAWAL, are handled by people; (c) the same address in a customer account is not erased by this path (the customer deletes the account in Settings); (d) phone and LinkedIn values cannot be requested through the form | Engineering |
| O8 | Fix or remove dead footer links; add a real contact page | Engineering |
| O9 | Close security gaps 1 to 3 in section 4 | Engineering + operator |
| O10 | Rehearse the breach runbook, fill roles and the Board's prescribed channel | Operator |
| O11 | Notice in other languages; plain-language review | Counsel + content |
| O12 | Unrelated modified files in this working tree (dependency upgrades, a test fix, three analysis / test reports) were left uncommitted and are not part of this branch | Owner |

## 7. Verification (2026-10-30, after O3, O4, O7)
| Check | Result |
|---|---|
| `tsc --noEmit` API and web | pass |
| API privacy integration suites (5 suites) | pass, 53 tests (5 rights-request, 12 for O4 and O7 in `dpdp-followup.integration.spec.ts`) |
| API unit suite | pass, 1,120 |
| API integration suite (all) | pass: 1,005 passed, 13 skipped, 0 failed |
| API e2e suite (all) | 749 passed, 16 skipped, 3 todo on the full run, with 2 suites failing: (1) `authorization`: the pinned list of public routes needed the two new public routes; **fixed** by adding them with a comment, and it passes on re-run. (2) `health-probes`: failed once in the full run (the known load-sensitive suite) and passes 20 of 20 in three isolated re-runs. The new `signup-consent.e2e-spec.ts` passes (5). The full e2e suite was **not re-run in one piece after the two fixes** |
| Web unit tests | pass, 388 (22 in `dpdp.test.ts`, 8 in `signup-consent.test.ts` against real migrations on in-memory PostgreSQL) |
| `next build` | pass; `/privacy-notice`, `/data-rights` and `/data-rights/verify` build |
| Secret scan | 0 findings |
| **Playwright browser suite** | **not run.** Existing sign-up tests were edited for the new checkbox (D11); the stack needs an isolated database and an environment I could not verify, so the sign-up flow, the consent dialog and the confirmation page have **not been exercised in a browser** |
| Over HTTP and with real providers | sign-up consent is covered over HTTP on the API only. The rights endpoints over HTTP, the gateway sign-up SQL through the real route (it is tested on in-memory PostgreSQL), real e-mail delivery and Turnstile are **not tested end to end** |
| Docs | `docs/AUTHORIZATION_ROUTE_INVENTORY.md` (generated) was not regenerated for the new routes |
