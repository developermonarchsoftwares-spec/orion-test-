# Orion code security review (2026-10-16)

Scope: the whole repository as of branch `chore/neon-removal-prep` plus the uncommitted Vercel-services work (`apps/api` NestJS API, `ownus`
Next.js web app and gateway, scripts, configuration). Method: automated checks, pattern scans over the source, tracing of every suspicious
hit to its origin, live probes of a local instance, and the existing test suites. This document adds to, and does not replace,
`SECURITY_RISK_REGISTER.md` (R-numbers below refer to it) and `SECURITY_FINAL_REVIEW.md`.

## 1. Summary
| | Count |
|---|---|
| New findings in this review | 3 (1 medium, 1 low, 1 informational) |
| Fixed during this review | 2 (defensive gateway IP fix; `js-yaml` advisory, earlier today) |
| Carried over from the register, still open | the list in section 5 |
| Critical or high findings in the code itself | **0** |
| Highest remaining risks | credentials in Git history (not rotated), tokens in browser storage, inline-script CSP |

Bottom line: no SQL injection, command execution, unsafe deserialization, disabled TLS verification, or missing authentication was found in
the code. The serious open items are about **secrets handling and session storage**, not about exploitable flaws in request handling.

## 2. New findings

### N-01 Access, refresh and admin tokens are stored in `localStorage`  (Medium)
- Where: `ownus/src/lib/api-client.ts:32-42` (access AND refresh token), `ownus/src/app/admin/monarch/page.tsx:302-303` (admin token),
  `ownus/src/lib/admin-fetch.ts`, and several pages that read `orion_access_token` / `orion_admin_token` directly.
- Why it matters: any script that runs in the page can read these values. The refresh token lives 7 days and the admin token 12 hours.
  The production CSP still allows inline scripts (R-019), so one XSS bug anywhere in the site would let an attacker take over an account,
  and an admin account would expose every customer. The gateway already sets an `httpOnly`, `secure`, `sameSite=lax` access cookie, so the
  safer mechanism exists; the page code simply does not rely on it.
- Not in the register until now.
- Fix (recommended, not applied: it changes every sign-in flow and needs regression testing of customer and admin login, refresh and
  logout): keep refresh and admin tokens only in `httpOnly` cookies, keep the short-lived access token in memory, and remove the
  `localStorage` reads. Add an XSS-focused test to the login and admin e2e suites.

### N-02 The gateway forwarded the client's own `X-Forwarded-For` to the API  (Low, fixed defensively)
- Where: `ownus/src/app/api/v1/[...path]/route.ts` (the generic proxy and eight credential-route proxies).
- Why it matters: the API rate-limits per IP and in production trusts one proxy hop (`apps/api/src/main.ts:27`), i.e. it reads the right-most
  `X-Forwarded-For` entry. If nothing in front appends to that header, a client can rotate a fake value on every request and never reach a
  per-IP limit, including the login and one-time-code limits.
- Fix applied: `ownus/src/lib/client-ip.ts`. When Vercel's own `x-vercel-forwarded-for` header is present (the platform overwrites it, a client
  cannot set it) the gateway sends only that address to the API; without it behaviour is unchanged. 5 unit tests; web suite 323/323.
- Still to verify on a real deployment: that the API sees the visitor's address and not the gateway's (check one login attempt in the API log).

### N-03 OAuth token-exchange failures log the provider's response body  (Informational)
- Where: `apps/api/src/modules/oauth/providers/google.provider.ts:113`, `microsoft.provider.ts:114`, gateway `route.ts:245`.
- Error bodies from the provider normally contain only an error code, but they are logged verbatim. Prefer logging the error code only.

## 3. Verified controls (what was checked and found sound)
| Area | Result |
|---|---|
| SQL injection | No string-built SQL. The only `sql.raw()` calls (`people-metrics`, `privacy.service` retention rules, `company-resolver`, `people-contact-attribution`) take constants defined in the same file, never request data. |
| Command / code execution | No `eval`, `new Function`, `child_process` or `vm` in application code. |
| TLS | No `rejectUnauthorized: false`; remote databases always verify the certificate (`database/tls.ts`, gateway `lib/db.ts`). |
| Cookies | All gateway cookies are `httpOnly`, `secure` outside local, `sameSite=lax`, with a lifetime. |
| Cryptography | HMAC-SHA256 with constant-time comparison for payments; `Math.random` only for trace sampling; SHA-1 only for an error fingerprint. |
| Dependencies | `npm audit` 0 in the root and in `ownus`. `js-yaml` pinned to 5.4.3 (resolves R-027). |
| Secrets in the tree | `npm run test:secrets`: 0 findings. None of the Razorpay test keys are in any tracked file. |
| Authentication gate | 201 API routes inventoried; every non-public route refuses anonymous callers; every role-restricted route refuses a customer (e2e `authorization`). Live probes: protected routes 401 on API and gateway. |
| Forged tokens | `alg: none` and wrong-secret tokens rejected (e2e `auth-hardening`; live: gateway 401). |
| Input handling | Malformed JSON, NUL bytes and `__proto__` keys refused; 11 MB body refused; login limited to 2 failures (API) / 10 (gateway). |
| Headers / CORS | CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` set; no CORS origin echo; no source maps, dotfiles or `package.json` served. |
| Payments | Credits only after server-side signature, order-owner, package and amount checks, exactly once. Verified live: two captured test payments credited once each. |
| Swagger | Mounted only outside production. |

## 4. Verification run in this review
| Check | Result |
|---|---|
| API unit / integration / e2e | 1884 / 984 / 731 passed, 0 failed (one integration flake seen once under load, did not reproduce) |
| API security suite | 9/9 |
| Web tests, type check, production build | 323/323, clean, OK |
| Secret scan, working tree / full Git history | 0 / **16 findings** |

## 5. Open items carried over (see the register for owners and detail)
1. **Credentials in Git history (SG-02 / SG-02b, High):** the database owner password and the JWT signing secrets are in history, and the
   branch is now on GitHub. Rotation is an owner action and is still pending. Production refuses publicly known secrets, so deploying with an
   old value stops sign-in.
2. R-019 CSP allows inline scripts; N-01 above makes this more important.
3. R-007 admin sign-in is a single factor plus an e-mailed code; R-035 and R-036 (no least-privilege tier; an admin can credit their own wallet).
4. R-014 rate limits are per process, so they are weaker with more than one API instance (and on Vercel Functions).
5. R-011 registration can proceed with an unverified e-mail when `REQUIRE_EMAIL_VERIFICATION` is off; R-013 no database `CHECK` constraints on wallets.
6. R-015 eleven request bodies bypass DTO validation; R-020 operator-configured URLs are not SSRF-guarded (by design).
7. R-021 / R-043 Docker images are not reproducible from the lockfile and Node versions differ; R-023 / R-042 CI has never run and is not a release gate.
8. R-045 dev-toolchain advisories (build-time only); R-026 web lint (this review counts 390 `no-explicit-any` style errors).

## 6. Deployment-specific notes (Vercel services)
- The API's background work runs in in-process timers (credit rollover, scheduled exports, webhooks, retention, token cleanup, import
  queue). Functions do not keep timers alive, so these need Vercel Cron/Queues or a persistent API host. This is reliability and
  data-protection relevant (retention and deletion jobs must actually run).
- The API is internal-only in the proposed config, which removes direct internet access to it. Keep `JWT_*` secrets identical in both services.
- Vercel rejects request bodies over 4.5 MB; the gateway allows 10 MB.

## 7. Recommended order of work
1. Rotate the database password and JWT secrets, then decide on a history rewrite (owner).
2. N-01: move refresh and admin tokens to `httpOnly` cookies (largest risk reduction for the effort).
3. Move the CSP to nonces (R-019) once N-01 is done, so XSS is contained twice.
4. Decide the background-job hosting question before any production deploy.
5. Enable the CI gate and branch protection (R-023, R-042), then lint.
6. Admin second factor and least-privilege admin tier (R-007, R-035, R-036).

## 8. Limits of this review
- It was not a line-by-line audit of the roughly 150,000 lines of code. It used pattern scans and targeted tracing, so a flaw in business
  logic can remain. The 3,500+ automated tests are the main protection there.
- No signed-in, live attacks against a real database were run (to avoid creating test users in `orion_db`); signed-in paths are covered by
  the in-memory e2e suites.
- No external scanner (OWASP ZAP, Burp, Semgrep, CodeQL) was available, and no load or denial-of-service test was done.
- A development build on localhost was tested, not a production deployment. Nothing was run against Vercel, Neon or Razorpay's live mode.
