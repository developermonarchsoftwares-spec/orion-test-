# Deploying Orion on Vercel (one project, two services)

The repository deploys as ONE Vercel project with TWO services, defined in the root `vercel.json`:

| Service | Root | Framework | Public? | Role |
|---|---|---|---|---|
| `ownus` | `ownus/` | Next.js | **Yes**: `/(.*)` | The website and the web gateway (`/api/v1/*`). It is the only public entry point. |
| `api` | `apps/api/` | NestJS | **No** (internal) | The Orion API. Reached only by the gateway, through a service binding. |

```
browser -> https://<domain>/...  ->  ownus (Next.js)
                                      |  /api/v1/*  = the gateway: handles some routes itself, proxies the rest
                                      v  binding: ORION_API_URL (injected by Vercel)
                                     api (NestJS, internal, keeps its /api/v1 prefix)
```

## How the code matches the routing
- **Public routing:** one rewrite sends every path to `ownus`. `/api/v1/*` therefore reaches the **gateway route** inside the Next.js app
  (`ownus/src/app/api/v1/[...path]/route.ts`), not the NestJS API. This is deliberate: the gateway carries session handling, rate limits,
  and the "never grant credits" rules for payments. The API is not exposed to the internet at all.
- **Binding:** `ownus` declares `{ "type": "service", "service": "api", "format": "url", "env": "ORION_API_URL" }`. Vercel injects the API's
  internal URL base into `ORION_API_URL`. Never set that variable yourself on Vercel.
- **Prefix:** a service receives the original request path, so the API keeps its `/api/v1` global prefix. `ownus/src/lib/backend-url.ts`
  builds `${ORION_API_URL}/api/v1`. Outside Vercel (local, Docker, an API hosted elsewhere) it falls back to `BACKEND_API_URL` /
  `NEST_API_URL` (the full URL including `/api/v1`) and then to `http://127.0.0.1:4000/api/v1`, so local development is unchanged.
- **Browser calls:** leave `NEXT_PUBLIC_API_URL` empty; the browser then calls the same origin (`/api/v1`). Bindings work in functions only
  (not in builds or middleware); the gateway uses it only inside the route function.

## Background jobs on Vercel (Vercel Cron)
On Vercel (`VERCEL` is set) the API's in-process timers are OFF (`serverlessRuntime()` in `common/utils/restore-mode.ts`; `FORCE_BACKGROUND_JOBS=true`
turns them back on for an always-on host). The same work is run by Vercel Cron calling authenticated routes, scheduled in the root `vercel.json`:

| Route (`GET /api/v1/cron/<job>`) | Schedule | Replaces |
|---|---|---|
| `webhooks` | every minute (loops up to 45 s while deliveries are due) | webhook dispatcher (was every 5 s; retries start at 30 s, so delivery can be up to a minute late) |
| `exports` | every minute | scheduled exports + expired file removal |
| `queues` | every minute | import / people-import queue workers (a job is also tried at once when queued, best effort) |
| `credit-rollover` | hourly | daily credit rollover |
| `privacy` | hourly :15 | account erasure + retention |
| `token-cleanup` | hourly :30 | stale token purge |
| `queue-prune` | every 6 h | old finished queue jobs |

Set **`CRON_SECRET`** (32+ random characters, Sensitive) for Production and Preview. Vercel then sends `Authorization: Bearer $CRON_SECRET`; the route
answers 503 without a secret, 401 with a wrong one, and nothing runs in `RESTORE_MODE`. Per-minute schedules need a Pro plan (Hobby allows daily crons only).
Cron requests go through the public site, so they pass the gateway, which forwards them to the API unchanged. NOT yet verified on a real deployment: check a Preview's cron logs.

## Project settings on Vercel
- Create the project from the repository with **Root Directory = the repository root** (where `vercel.json` is), not `ownus`. The earlier link in
  `.vercel/project.json` used Root Directory `ownus`: re-link or change the setting, or the services config is ignored.
- Do not set Framework, Build or Install commands in the dashboard for this project; they belong to each service.
- Production branch: `main`. Other branches get Preview deployments (full-stack: each Preview gets its own API service).

## Environment variables
Project variables are shared by both services. Set them for **Production and Preview**; mark every secret **Sensitive**.

| Variable | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | web | Public URL of the site |
| `DATABASE_URL` (+ optional `GATEWAY_DATABASE_URL`) | api + web | Remote PostgreSQL; certificate always verified. Use the provider's pooled string for functions. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` | api + web | **Identical values in both**; 32+ random characters; never a value that was committed |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | web | E-mail codes for sign-up and admin login |
| `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_CALLBACK_URL` | web | Callback must match the Google console exactly |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_API_MODE=live` | api | Live key in production; `rzp_test_` is refused unless `RAZORPAY_ALLOW_TEST_KEYS=true` (staging) |
| `TYPESENSE_*`, `MAIL_*`, `NODE_ENV=production`, `APP_URL`, `WEB_APP_URL`, ... | api | Full list: `.env.production.example` |
| `CORS_ORIGINS` | api | Not needed for browser traffic (the API is internal); keep it set to the site URL anyway |
| `CRON_SECRET` | api | Authenticates Vercel Cron calls (see Background jobs) |
| `ORION_API_URL` | web | **Injected by Vercel. Do not set.** |
| `BACKEND_API_URL`, `NEXT_PUBLIC_API_URL` | web | **Do not set on Vercel** (local/Docker only) |

## Before the first production deploy (blockers)
1. **Rotate the JWT secrets and the database password.** The old values are in Git history; production refuses publicly known secrets, so
   deploying with an old value breaks sign-in.
2. Set `CRON_SECRET` and confirm the cron jobs run on a Preview (Pro plan for per-minute schedules).
3. Run migrations from a trusted machine (`npm run drizzle:migrate` in `apps/api`, with the production `DATABASE_URL`; `npm run db:audit`
   first). Never from Vercel. Migrations `0000`-`0023` are frozen.
4. Add the production domain to the Google OAuth redirect URIs if Google sign-in is used.
5. Razorpay live key on the API; webhook secret if webhooks are used.

## Known limits
- Vercel rejects request bodies over **4.5 MB** before they reach any function; the gateway accepts 10 MB, so large CSV/XLSX imports fail.
- Each web function instance keeps 3 database connections; the API has its own pool (`DB_MAX_CONNECTIONS`). Use a pooled connection string.
- The gateway strips `-pooler.` from Neon-style hosts (see `NEON_REMOVAL_STATUS.md`).
- The API's rate limiter and monitoring state are per instance.

## Local testing
- `vercel dev -L` (Vercel CLI) runs both services together without logging in and injects `ORION_API_URL`. It was NOT run here (the CLI is
  not installed).
- Without the CLI: run the API on port 4000 and the web app with `ORION_API_URL=http://127.0.0.1:4000` (this is what the verification below used).

## Verify a Preview deployment
1. `/` loads; no CSP errors in the console.
2. `GET /api/v1/health` returns the API's own health document (proves gateway -> binding -> API).
3. Sign-in works (needs identical JWT secrets in both services).
4. `/credits` -> Buy opens Razorpay (needs the API with valid keys).
5. Check that `https://<domain>/api/v1/...` is the gateway: a login error contains a `requestId` only when it came from the API.
