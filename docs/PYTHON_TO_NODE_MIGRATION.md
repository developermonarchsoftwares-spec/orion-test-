# Python pipeline to Node.js migration

Source: `D:\Monarch Project\Own product\new data storing\datas storing\datas storing\datas storing` (`python_pipeline/`, `business_scraper/`, `server.py`, `scripts/`).
Target: `apps/api` (NestJS, TypeScript) inside this npm workspace. New code lives in `apps/api/src/modules/pipeline/`.

## Single-project run
`npm run dev` (repo root) now starts the NestJS API in watch mode (`apps/api start:dev`, port 4000) and the Next.js web app together. Previously it ran the API from `dist` and needed a prior build.

## Coverage map (Python module -> TypeScript)
| Python | Status | Where / note |
|---|---|---|
| `cleaner`, `validator`, `deduplicator`, `ingestion`, `batch_manager`, `publishing`, `storage` | Already in TS | `modules/import/services/*` (normalization, validation, duplicate-detection, publishing) |
| `people/*` | Already in TS | `modules/people/*` |
| `queue/*` | Already in TS | `modules/queue`, Vercel cron routes |
| `commercial/*` (auth, credits, leads, searches, export, analytics) | Already in TS | `auth`, `credit`, `saved-searches`, `export`, `dashboard` modules |
| `enrichment/ssrf.py`, `business_scraper/netsafety.py` | Reuse | `modules/integrations/net/safe-http.ts` |
| `business_scraper` normalize, extract, location, dedupe, netsafety, fetcher, sources, runner, export | **Ported** | `pipeline/scraper/*.ts`, 194 tests passing (uses `cheerio`) |
| `business_scraper/cli.py` | To do | needs a Nest command or admin route to start a run |
| `enrichment/*` (web collector, providers, website finder, taxonomies, service) | To do | |
| `entity_resolution/*` | To do | overlaps `modules/business/company-resolution` |
| `freshness/*` | To do | |
| `verification.py`, `file_readers.py`, `watch_folder.py`, `r2_diagnostics.py`, `migrate.py` | To do / review | verification may overlap people verification |
| `server.py` legacy console + `ui/` | Retire | replaced by admin routes + Next.js app |
| `scripts/*` (benchmarks, backup/restore, DB copy) | Port as needed | many are Python-specific |

## Rules
Port behaviour, not structure; port each Python test alongside its module; never call the 19 external pipeline tables; no `--apply` runs; applied migrations 0000-0023 are frozen.
