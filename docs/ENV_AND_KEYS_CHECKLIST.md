# Environment variables and keys to set (DPDP and security changes)

**Date:** 2026-10-30 · **Branch:** `compliance/dpdp` · This is a checklist of what an operator must set or rotate. It contains **no secret values**: generate them yourself, keep them in the host's secret store (for example the Vercel project's Environment Variables, Production scope), and never put them in git, chat, a ticket or a backup. Full variable reference: `ENVIRONMENT_VARIABLES_GUIDE.md`.

> **Read this first.** After these changes a production API **will not start** until sections 1 and 2 are done. A production web build or start also stops if only one of the two Turnstile keys is set. Do sections 1 and 2 in a preview or staging environment before production.

## 1. Must set (production refuses to start without them)

| Variable | Set on | Value | Notes |
|---|---|---|---|
| `MFA_ENCRYPTION_KEY` | API service | New random string, **32 or more characters** | Seals two-step sign-in secrets. Generate: `openssl rand -base64 48`. Not an example value (anything starting `your_`, `change`, `generate`, `example`, `placeholder`, `replace`, `orion_` is refused). |
| `INTEGRATIONS_ENCRYPTION_KEY` | API service | A **second, different** random string, 32+ characters | Seals webhook signing secrets and CRM credentials. |
| `TURNSTILE_SECRET_KEY` | API service **and** web service | Secret key of your Cloudflare Turnstile widget | The web gateway checks sign-in itself, so it needs the secret too. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Web service | Public site key of the **same** widget | Set together with the secret. The value is public by design and is built into the web app, so set it before building. |

Rules: the two encryption keys must differ from each other and from `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`. If you cannot use Turnstile yet, set `ALLOW_NO_CAPTCHA=true` on the API **instead of** the Turnstile keys: production then starts with no bot protection and logs a warning. It is a recorded decision, not a fix; remove it as soon as the keys exist. It never weakens a check that is configured.

## 2. Must set for the privacy features to work

| Variable | Set on | Why |
|---|---|---|
| `FRONTEND_URL` (or `WEB_APP_URL`) | API service | Public https address of the web app. Without it the erasure confirmation e-mail has no link. |
| `APP_URL` | API service | Public https address of the API. |
| `CORS_ORIGINS` | API service | Exact https origins of the web app(s). Together with the two above these are the only hosts the HTTP-to-HTTPS redirect will send a browser to; a plain-http request for any other host is refused (403). |
| `NEXT_PUBLIC_GRIEVANCE_OFFICER_NAME` | Web service | Name of the appointed Grievance Officer. Until set, the footer and notice show "[Grievance Officer: to be appointed]". |
| `NEXT_PUBLIC_GRIEVANCE_EMAIL` | Web service | Defaults to `privacy@monarchsoftwares.com`. |
| `NEXT_PUBLIC_GRIEVANCE_ADDRESS` | Web service | Postal address shown for the Grievance Officer. |
| `NEXT_PUBLIC_FIDUCIARY_ADDRESS` | Web service | Registered address of the company shown in the notice. |
| `PRIVACY_CONTACT_EMAIL` | API service | Where requesters are told to write in decision e-mails. Defaults to `privacy@monarchsoftwares.com`. |

These `NEXT_PUBLIC_` values are published on the website on purpose; do not put anything private in them.

## 3. Rotate (exposed in git history according to `SECURITY_REMEDIATION_SG02.md`)

| What | Where | Rule |
|---|---|---|
| Database owner credential | API service (`DATABASE_URL`) | Create a new credential, update, deploy, then revoke the old one. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | API **and** web service | The two services must hold the same values. Rotating signs everyone out. **Do it only after the reseal in section 5.** |

Also rotate any key that was ever pasted into a chat, ticket, screenshot or log.

## 4. Optional and situational

| Variable | When |
|---|---|
| `MFA_ENCRYPTION_KEY_PREVIOUS`, `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS` | Only while rotating an encryption key: the old key (comma separated for several). Remove after the reseal reports up to date. |
| `RESEAL_CONFIRM_DATABASE` | Only when running the reseal tool with `--apply`: the exact database name. |
| `ALLOW_NO_CAPTCHA` | Only as described in section 1. |
| `REQUIRE_SIGNUP_CONSENT`, `REQUIRE_REGISTRATION_OTP` | Development and tests only. Ignored in production, where both are always on. |

## 5. Order of operations

1. In a preview or staging environment, set everything in sections 1 and 2. Confirm the API starts and the web build succeeds.
2. Take a database backup.
3. Deploy to production with sections 1 and 2 set.
4. In `apps/api`, dry run: `npm run db:reseal-secrets`. It prints how many stored secrets are still in the old format. It writes nothing.
5. Apply: set `RESEAL_CONFIRM_DATABASE=<database name>`, then `npm run db:reseal-secrets -- --apply`. It writes in one transaction and only if every row can be opened; if any cannot, it stops with nothing written. Run the dry run again and confirm "already under the current key".
6. Only now rotate the JWT secrets and the database credential (section 3).
7. To rotate an encryption key later: put the new key in `*_ENCRYPTION_KEY` and the old one in `*_PREVIOUS`, deploy, run the reseal (steps 4 and 5), then remove the old key.

## 6. What you will see if something is missing

| Symptom | Cause |
|---|---|
| API exits at start with `"MFA_ENCRYPTION_KEY" is required` (or `INTEGRATIONS_...`) | Section 1 keys missing. |
| API exits at start with `"TURNSTILE_SECRET_KEY" is required` | Set it, or `ALLOW_NO_CAPTCHA=true`. |
| `"MFA_ENCRYPTION_KEY" length must be at least 32` or `contains an invalid value` | Key too short or an example value. |
| Web build stops: "TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not" (or the reverse) | Set both. |
| Sign-in answers "We could not verify the security check right now" in production | No Turnstile secret on the service that answered (API or web gateway). |
| `HTTPS_REQUIRED` (403) on a plain-http request | The host is not in `APP_URL`, `FRONTEND_URL`, `WEB_APP_URL` or `CORS_ORIGINS`, or the method was not GET or HEAD. |
| Reseal tool says rows are unreadable | A row was sealed with a key that is no longer configured; put that key in `*_PREVIOUS` and run again. |

## 7. Sign-off

- [ ] Section 1 values set in staging and production (API and web as listed)
- [ ] Section 2 values set; Grievance Officer appointed
- [ ] Backup taken
- [ ] Reseal dry run, apply, and second dry run done (record the date: ______)
- [ ] JWT secrets and database credential rotated after the reseal (date: ______)
- [ ] `ALLOW_NO_CAPTCHA` is **not** set (or its removal date is recorded: ______)
- [ ] The platform serves HTTPS only and sends `X-Forwarded-Proto` (check with `curl -I http://<your host>/`; expect a 308 to https)
