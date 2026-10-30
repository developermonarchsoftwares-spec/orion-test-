# Orion test report

**Date:** 2026-10-29 · **Code:** branch `orion-test-snapshot` at `b163bc1` (synced with `orion-test/main`) · **Machine:** Windows 11, Node 24.13, `core.autocrlf=true`, local PostgreSQL available, Docker not running · **Changes made to code, workflow or architecture:** none (only this report and `PRODUCT_ANALYSIS.md` were added).

## 1. How "Cloudflare" was used
Cloudflare does not run product tests, so the agreed approach was: run every suite locally and use the Cloudflare tools only to inspect the account (read-only). Nothing was deployed or created.

| Cloudflare resource | Result |
|---|---|
| Workers | 0 (Orion is not deployed on Cloudflare) |
| D1 databases | 0 |
| KV namespaces | 0 |
| Hyperdrive configs | 0 |
| R2 buckets | 2: `orion` (created 2026-09-12), `automation` (2026-10-16) |

The `orion` R2 bucket is the likely object-storage target. Its contents, access policy and lifecycle rules were not inspected. The deployment target in the repo is Vercel (`vercel.json`), so no live Cloudflare URL exists to test.

## 2. Results

| Check | Result |
|---|---|
| Typecheck, API (`tsc --noEmit`) | PASS |
| Typecheck, web | PASS |
| API unit | PASS: 62 suites, 1,120 / 1,120 tests |
| API integration | 979 passed, 13 skipped, **8 failed** (all in `people-handoff`; see 3.1) |
| API security | PASS: 9 / 9 |
| API performance | PASS: 3 / 3 |
| API e2e | PASS: 49 suites, 746 passed, 16 skipped, 3 todo, 0 failed (2 suites skipped) |
| Web unit | 357 / 358 passed, **1 failed** (see 3.2) |
| Secret scan (working tree) | PASS: 0 findings |
| Migration journal check | PASS: 28 entries consistent |
| `npm audit --omit=dev` | **3 high-severity advisories** (see 3.3) |

Totals actually executed: about 3,230 tests; 9 failures, none reproduced as a real defect (below).

## 3. Failures and findings

### 3.1 Integration: 8 failures in `people-handoff.integration.spec.ts`
Symptoms: `Exceeded timeout of 5000 ms` and `read ECONNRESET`, during a 621 s run. **Re-run alone, the suite passes 16 / 16.** Classification: load-related flakiness (database connections and 5 s timeouts under a long sequential run), not a logic defect. Risk: it can turn CI red intermittently. Not fixed (no code changes requested).

### 3.2 Web: `gateway-contract.test.ts` "customer-facing writes to the users table are strict"
The test asserts that source text contains multi-line snippets with `\n`. The gateway file in this Windows checkout has CRLF line endings (`core.autocrlf=true`), so the match fails. The strict-write calls exist in the code (`queryDbStrict` for the register insert at `route.ts:1749` and the profile update at `route.ts:2255`). Classification: environment-specific test fragility; it would pass on Linux/CI. Any contributor on Windows hits it.

### 3.3 Dependency advisories (production dependencies)
| Package | Advisory | Fix |
|---|---|---|
| `multer` 2.0.0 - 2.4.0 (via `@nestjs/platform-express`) | Denial of service via pending async `fileFilter` after request teardown (GHSA-q7qp-rjg7-q26m) | `npm audit fix` (non-breaking) |
| `zod` < 4.6.6 | Memory exhaustion on oversized constrained collections (GHSA-mrhx-c7xc-m3w5) | `npm audit fix --force` to 4.6.7 (breaking) |

The project's earlier report listed 0 high findings, so these are new since then. File upload endpoints (imports, avatars) make the `multer` one relevant.

### 3.4 Environment notes (not product defects)
- The default Node heap (about 2 GB) was exhausted when running the full e2e suite once; with `NODE_OPTIONS=--max-old-space-size=6144` it passes. A developer or CI runner with little memory will see an out-of-memory crash.
- The `/health` probe reports `storage: down` during e2e because Docker/MinIO is not running; tests expecting this pass.

## 4. Not tested (be explicit)
- **Playwright browser suite** (`npm run test:browser`, the `tests/` folder): not run. No sign-in, search, unlock, credit purchase or export was exercised through a browser.
- **Real payments:** no Razorpay test-mode order or webhook against the provider.
- **Docker images, load test (`test:load`), staging suite (`test:e2e:staging`), real-PostgreSQL concurrency suite** (opt-in): not run.
- **Cloudflare R2:** only the bucket's existence was checked; no upload/download, permission or lifecycle test.
- **Email delivery (Resend), Turnstile CAPTCHA, Google/Microsoft OAuth** with real providers: not tested; they were covered only by the mocked suites above.
- **Vercel deployment:** not checked; the Vercel tools were unavailable in this session.
- Web lint was not run (previously documented as 352 errors).

## 5. Verdict
The automated backend suites are healthy: no genuine functional failure was found across about 3,200 tests, and typecheck, secret scan and migration checks pass. Three things need attention: the new high-severity `multer` / `zod` advisories, two flaky or fragile tests (3.1, 3.2) that make CI unreliable, and the large untested area in section 4. Passing unit, integration and e2e tests does not show the product works for a real user end to end; that needs the browser suite and a provider-backed staging run, which have not been done.
