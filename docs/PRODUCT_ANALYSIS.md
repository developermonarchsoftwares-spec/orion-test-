# Orion: product analysis (potential and flaws)

**Date:** 2026-10-29 · **Scope:** branch `orion-test-snapshot` at `b163bc1` (synced with `orion-test/main`) · **Method:** read-only review of the repository, its 113 documents, the schema, migrations, CI and deployment config. **No code, workflow or architecture was changed. Tests, builds and the app were not run for this analysis**; test counts below are quoted from the project's own documents (dated 2026-10-12 to 2026-10-17) and are not re-verified. Anything marked *(doc)* comes from a project document, *(code)* from source I read, *(inferred)* is my judgement.

---

## 1. What the product is

Orion is a **B2B lead-intelligence platform for the Indian market** (prices are in INR, Razorpay billing). Customers search a database of verified businesses and their **decision makers**, spend **credits** to unlock contact details (email, phone, mobile), save leads, run saved searches and export CSVs. Admins import and review data, moderate it and publish it.

**Core loop:** Discover (search/filter) → open company or person card → unlock contact with credits → save / export → buy more credits.

| Package | Price (INR) | Credits |
|---|---|---|
| Free | 0 | 5 per day (resets daily) |
| Starter | 99 | 100, never expire |
| Growth | 299 | 350 |
| Agency | 999 | 1,500 |
| Enterprise | custom | custom, team workspace, API *(seed migration 0003)* |

Effective price per credit is about ₹0.99 (Starter), ₹0.85 (Growth) and ₹0.67 (Agency).

### Shape of the system
| Part | Tech | Role |
|---|---|---|
| `apps/api` | NestJS, Drizzle ORM, PostgreSQL | 25 modules: auth, business, people, credit, payment, export, import, search, saved-leads/searches, unlock, privacy, integrations, queue, cron, monitoring, pipeline/scraper |
| `ownus` | Next.js 16 | Customer app (discover, leads, credits, saved searches, settings), marketing pages, admin console (`/admin`, `/admin/monarch`) |
| `ownus/src/app/api/v1/[...path]/route.ts` | one catch-all route | **4,561-line "gateway"** that proxies to the API and also implements native handlers |
| `packages/shared` | TS | shared types |
| Data layer | 27 schema files, 27 migrations (0000-0026), ~85 tables | |
| Deploy | Vercel "services" (api + web) with 7 daily crons; Docker files exist | |
| Size | ~547 API source files, ~226 web source files, ~272 test files, ~67k lines of TypeScript | |

---

## 2. Real potential (strengths)

1. **A real, differentiated data model, not a CRUD shell.** Company → People → Decision-maker → Contact → Evidence is modelled with provenance, per-contact verification status, confidence scores, freshness, conflict detection, observations, source trust, suppression and classification versioning. Most lead-gen tools hide this; here it is first-class. This is the main moat if the data is good.
2. **Trust-first design.** Customers see only reviewer-approved, published roles; contacts are locked until paid; "hidden" and "missing" return the same 404; evidence is exposed as counts only; contacts are attributed per company and fail closed. A deep-scan test checks responses for forbidden internal keys *(doc: PEOPLE_CUSTOMER_CONTRACT)*. This is exactly what B2B buyers and regulators ask about.
3. **Privacy and compliance are designed in** (rare at this stage): suppression register and trigger, data-subject request table, retention job, data classification, consent/RoPA-style documents, export CSV-injection guard.
4. **Money paths are taken seriously.** Row and advisory locks on wallets and unlocks, verified on real PostgreSQL with mutation testing (removing the locks makes 5 tests fail), idempotent unlocks, credit reconciliation script, server-side package amounts, HMAC-verified raw-body webhook with replay tests *(doc)*.
5. **Unusually deep test and security investment** for the stage: documented 802 unit / 945 integration / 581 e2e / 9 security / 3 perf API tests plus ~258-348 web tests; a secret scanner in CI; actions pinned to commit SHAs; least-privilege workflow token; route-by-route authorization inventory (201 routes). The documentation trail (risk register, traceability matrices, runbooks) is audit-ready.
6. **Sensible unit economics shape.** Prepaid never-expiring credits give cash up front and no churn accounting; the free 5/day tier is a natural acquisition funnel; per-unlock cost is a cleanly metered variable.
7. **Own data acquisition capability.** A TypeScript port of the scraper (source-config driven, SSRF-safe fetcher, robots/terms gate recorded per source, dedupe, normalization) and a CSV/People import pipeline mean the data supply is not outsourced.
8. **Clear expansion paths already scaffolded:** integrations/webhooks, API access (Enterprise), team workspaces, Typesense search provider, S3/R2/MinIO storage, queue and cron workers, AI/enrichment hooks in the pipeline.
9. **Recent velocity is in the right direction:** CAPTCHA (Turnstile), OAuth hardening, rate limits shared across serverless instances, direct Resend mail transport, admin sign-in code delivery.

---

## 3. Flaws and risks

Severity: **Blocker** (do not launch/charge real users), **High**, **Medium**, **Low**.

### 3.1 Release and process (the biggest issue is not code quality)
| # | Finding | Severity | Evidence |
|---|---|---|---|
| F1 | **Release classification is "BLOCKED" by the project's own assessment.** Open gates: credential rotation (B2), production env verification (B3), live-payment sync (B4), no production DB/API host chosen (B5), no alert ever shown to fire and no production-scale backup/restore (B6). | Blocker | PRODUCTION_READINESS_REPORT s1 *(doc)*. Status of these after the Oct 17 report is unknown to me; the pulled commits do not obviously close them. |
| F2 | **Real credentials were exposed in git history** (database owner credential and JWT signing secrets, in a public repository per the docs). History scan reports 3 distinct values; rotation was "PENDING/UNVERIFIED". My own scan of the current tree found nothing, but history is what matters. Anyone who cloned earlier retains them. | Blocker | SG-02 / SG-02b *(doc)* |
| F3 | **Documentation drifts faster than the code.** The checkpoint is dated Oct 17 and describes a branch/HEAD (`8201ce0`, `chore/neon-removal-prep`) that no longer matches the repo; it contradicts itself in places (the plan file lists its own conflicts, section 1.2). Two "phase" numberings, a Phase 11/12 never defined. | Medium | ORION_REMAINING_WORK_PLAN s1.2 *(doc)* |
| F4 | **Bus factor / provenance of the effort.** Two committer identities, the work was developed in one local tree with large uncommitted drift (144 modified + ~499 untracked files at one point) before being snapshotted. History quality is weak: the current branch started as "Snapshot of ownus working tree". | Medium | git log, plan s1 |

### 3.2 Architecture
| # | Finding | Severity | Evidence |
|---|---|---|---|
| F5 | **A second backend lives inside the web app.** The gateway route is 4,561 lines in a single file with its own native handlers (auth, search, export, etc.), duplicating API logic. It was the source of earlier auth bypasses (falling back to native login on any API error, ignoring MFA) and still has no per-route object-level tests. Any rule changed in the API can silently diverge from the gateway. | High | SG-06, AUTH-01/02, R-006 *(doc)*; file size *(code)* |
| F6 | **Two systems, one database, undefined ownership.** The Orion app and a separate Python pipeline write the same tables (`users`, `businesses`, `credit_transactions`, …). 19 pipeline tables exist in the dev database that the app does not model, plus ~44 out-of-band columns. Migration systems are independent and unaware of each other. A proposal exists (separate `orion_pipeline` schema, published view contract) but is "not approved, not implemented". The Python-to-Node port is partly done (`enrichment`, `entity_resolution`, `freshness`, `verification` still "to do"). | High | TARGET_ARCHITECTURE, PYTHON_TO_NODE_MIGRATION *(doc)* |
| F7 | **Migration journal timestamp trap.** Migrations 0008-0023 carry `when` values in the future (up to Jan 2027). Drizzle skips any migration whose `when` is not greater than the newest applied one, so `drizzle-kit generate` silently produces migrations that never run. Mitigated by a custom guard and `db:migration:new`, but it relies on every contributor using the guarded script. `0003_seed_packages` committed text differs from what was applied (breakpoint). | Medium | CHECKPOINT s4 *(doc)* |
| F8 | **Serverless fit is uncertain.** Vercel "services" for a NestJS API with an in-process queue, workers, TOTP/OTP and rate-limit state, and 7 daily crons (a single `0 2-3` UTC window). Several limits were in-process only (since improved: rate limits now shared across instances). Cold starts, connection pooling and long-running imports/exports on serverless are untested at scale. | Medium | vercel.json *(code)*; PERFORMANCE_RESILIENCE_REVIEW *(doc)* |
| F9 | **Neon removal is half-finished by design.** The pooler rewrite hack in the gateway stays "until production leaves Neon", and no replacement database is chosen. Migration, cutover, rehearsal and backup docs exist; nothing has been run. | High | NEON_REMOVAL_STATUS, B5 *(doc)* |

### 3.3 Product and business
| # | Finding | Severity | Evidence |
|---|---|---|---|
| F10 | **Real payments are not working end to end.** At last check `createOrder` generated a local order id and never called Razorpay's Orders API, orders were not persisted, and refunds/failures/reconciliation were unhandled. So the revenue model is unproven. (The webhook, amount trust and key validation are good.) | Blocker for revenue | PRODUCTION_READINESS s"Payment-flow gaps"; B4 *(doc)*. May have changed after Oct 12. |
| F11 | **No refund or dispute policy for unlocked leads**, and no wallet CHECK constraints or ledger-uniqueness key. The credit reconciliation script found 9 wallets whose ledger did not sum and 57 charges with no unlock row on the dev DB (cause unproven). Money-integrity guarantees depend on application code only. | High | Phase 6 row *(doc)* |
| F12 | **The product's value is its data, and the data supply is unproven.** The People layer was built "without collecting people data" (Phase 1 doc); the customer People page is empty without imports; the scraper "ships no selectors for any specific website" and each source requires a person to review its terms. There is no evidence in the repo of dataset size, coverage, accuracy or freshness metrics from a real customer-visible corpus. | High (commercial) | DECISION_MAKER_INTELLIGENCE, sources.ts *(code/doc)* |
| F13 | **Legal exposure on third-party contact data.** Orion sells personal contact details of named individuals. The documents flag undecided items: lawful basis and removal route for third-party contacts, a disclosure policy for personal/unknown contact values and proprietor PAN, no Record of Processing Activities, no sub-processor list, **data-subject request intake service/route/UI not built** (Phase 11 incomplete), public removal route not started. Under India's DPDP Act and for any EU/UK users this is the largest non-technical risk. | High | PLAN s1.1, s2, s2.2 *(doc)* |
| F14 | **Admin is single-factor.** Admin sign-in is email + one-time code; the admin second factor is "NOT STARTED" and admin authorization originally depended on an `@monarchsoftwares.com` domain filter (now persisted role + status). The admin console can publish data, adjust credits and import. | High | R3, Phase 4 *(doc)* |
| F15 | **Competitive positioning is not documented.** The repo has no market, competitor, ICP or pricing-validation material. Pricing (₹0.67-0.99/credit) looks low relative to global lead tools but there is no cost-of-data analysis (enrichment, verification, storage per unlock) to show margin. | Medium *(inferred)* | absence of docs |
| F16 | **No product analytics or usage metrics**; the web app's analytics tables exist but there is no funnel/KPI definition (activation, unlock-to-purchase conversion, retention). | Medium *(inferred)* | no doc/code seen |

### 3.4 Code and quality
| # | Finding | Severity | Evidence |
|---|---|---|---|
| F17 | **Web lint is failing and not in CI:** 352 errors, 450 warnings (290 `no-explicit-any`, `react-hooks/rules-of-hooks` violation, etc.). | Medium | Readiness report s2 *(doc)* |
| F18 | **Oversized files:** gateway route 4,561 lines; admin page 1,566; discover filters 1,429; discover page 1,219; import view 1,200. These resist review and testing. | Medium | wc *(code)* |
| F19 | **Repository hygiene (tracked in git):** `apps/api/before.json`, `before.clean.json`, `after.json`; `ownus/scratch_*.js` (9 files); `scratch/` folders and `showreel*` / `brag-output*` (about 175 tracked files of marketing-video output) sit in the product repo; `.git` is 148 MB. | Low | git ls-files *(code)* |
| F20 | **Runtime inconsistency:** CI Node 22, Dockerfiles Node 20, Vercel 24.x, dev machine 24.11; no `engines` field. Dockerfiles run `npm install` without lockfiles (not reproducible); Docker images have never been built. CI has, per the docs, never run (two defects found by hand), though it has now been pushed to GitHub where it will. | Medium | readiness s3, P19-07 *(doc)* |
| F21 | **Next.js 16 / bcrypt 6 / drizzle 0.45 are recent majors;** the repo carries an `AGENTS.md` warning that Next.js APIs differ from common knowledge. Upgrade risk is real but contained by the test suite. Two moderate audit advisories remain (`@nestjs/swagger`, `js-yaml`). | Low | package.json, audit *(doc)* |

### 3.5 Test coverage gaps (stated by the project itself)
No test, or only partial, for: gateway native handlers over HTTP, Typesense search, object storage, Docker images, the Playwright browser suite (not run in the last assessment), SG-25 password cap and L-7 admin logging (since added), SSRF with real DNS/TLS, CSP nonces, distributed rate limits, alerting, backup/restore at scale. The real-PostgreSQL concurrency suite is opt-in and not in CI, so removing wallet/lead locks would be caught by nothing in CI (R-017).

---

## 4. Overall assessment

| Dimension | Rating | Comment |
|---|---|---|
| Product concept / differentiation | **Strong** | Provenance-backed decision-maker data with paid unlock is a credible niche, and the trust model is better than most competitors' |
| Engineering depth | **Strong, over-extended** | Security, privacy and money-path work is far beyond a typical MVP; effort has gone to hardening before the data and billing basics are live |
| Launch readiness | **Not ready** | Blocked by credential rotation, no production target, unfinished payments, no alerting evidence, privacy-request workflow incomplete |
| Data readiness | **Unknown / weakest link** | Nothing in the repo shows a production-grade, customer-visible dataset |
| Operational maturity | **Low** | Never deployed from this code path, no alert firing proof, no restore drill, CI never observed green |
| Maintainability | **Medium** | Good tests and docs, but a giant duplicated gateway, split ownership with the Python pipeline and documentation drift |

**Real potential:** high, if the data corpus and its freshness are real and the unlock-and-pay loop works end to end. The product's defensibility is the verified, provenance-tracked people data plus the compliance posture; both are mostly built as *infrastructure* but not yet demonstrated as *content*.

---

## 5. Suggested priority order (recommendations only, nothing applied)

1. **Close the operator gates:** rotate every exposed credential and decide history cleanup; choose the production database/API host; set and verify production env values.
2. **Prove one end-to-end paid journey** in a staging environment: register → search → unlock → buy package (real Razorpay test orders) → export, with reconciliation passing.
3. **Make the data real:** a measured corpus (counts, coverage by city/industry, verification rate, freshness) and a published data-quality dashboard for the team.
4. **Finish the privacy workflow** (Phase 11 request intake, public removal route, RoPA, sub-processor list) before selling third-party contacts.
5. **Retire or shrink the gateway's native handlers** so there is one backend of record, and put the real-PostgreSQL concurrency suite into CI.
6. **Decide pipeline ownership** (finish the Python-to-Node port, or adopt the `orion_pipeline` schema proposal), then freeze one migration system.
7. **Housekeeping:** admin second factor, lint to green and gated, align Node versions, build the Docker images from lockfiles, remove scratch/output files from the product repo, and refresh the checkpoint to the real current state.

---

## 6. Limits of this analysis
- No tests, build, app run, load test or database inspection were performed; no live site, Vercel project or GitHub Actions run was examined.
- Many claims about status rely on project documents last updated 2026-10-12/17; the 16 commits pulled afterwards (CAPTCHA, OAuth, Resend, shared rate limits, admin sign-in code) may have closed some items I list as open.
- No customer, revenue, dataset-size or competitor data was available; sections on commercial viability are inference.
- "Product Tracking" was not a tool or document I could find in this environment, so I interpreted the request as a general product-and-codebase analysis.
