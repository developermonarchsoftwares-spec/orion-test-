/**
 * DPDP Act sign-up consent for the web gateway: the same rules as the NestJS API (`apps/api/src/modules/privacy/privacy.config.ts`:
 * `signupConsentRequired`, `parseSignupConsents`). The gateway can create accounts itself, so it must refuse an account without the person's
 * explicit consent and write the choices together with the account. No imports: usable from the route and from node:test.
 */
export type SignupConsentPurpose = 'ACCOUNT_SERVICE' | 'PRODUCT_UPDATES' | 'MARKETING';

/** Always on in production; elsewhere it can be switched off (REQUIRE_SIGNUP_CONSENT=false) for local development. */
export function signupConsentRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.NODE_ENV || '').trim() === 'production') return true;
  return !/^(0|false|no|off)$/i.test((env.REQUIRE_SIGNUP_CONSENT || '').trim());
}

/** Only a real boolean true counts as consent to the account purpose; optional purposes are kept when they are real booleans (a refusal is recorded too). */
export function parseSignupConsents(raw: unknown): { accountService: boolean; rows: Array<{ purpose: SignupConsentPurpose; granted: boolean }> } {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const accountService = o.ACCOUNT_SERVICE === true;
  const rows: Array<{ purpose: SignupConsentPurpose; granted: boolean }> = [];
  if (accountService) rows.push({ purpose: 'ACCOUNT_SERVICE', granted: true });
  for (const purpose of ['PRODUCT_UPDATES', 'MARKETING'] as const) if (typeof o[purpose] === 'boolean') rows.push({ purpose, granted: o[purpose] as boolean });
  return { accountService, rows };
}

/**
 * REGISTER_WITH_PROOF_SQL (lib/email-otp.ts) plus the consent rows, in ONE statement: the proof is spent, the account inserted and its
 * consent recorded together, or none of it happens. $12 = JSON array of {purpose, granted}, $13 = policy version, $14 = IP, $15 = user agent.
 * Returns the new user id (no row = the proof was not acceptable).
 */
export const REGISTER_WITH_PROOF_SQL_CONSENT = `
  WITH proof AS (
    UPDATE email_otp_challenges SET proof_consumed_at = now()
     WHERE id = $10::uuid AND email = $2::text AND purpose = 'REGISTER' AND proof_hash = $11::text
       AND consumed_at IS NOT NULL AND proof_consumed_at IS NULL AND proof_expires_at > now()
    RETURNING id),
  ins AS (
    INSERT INTO users (id, email, password_hash, first_name, last_name, display_name, organization_name, phone_number, role, status, provider, metadata, is_email_verified, email_verified_at, created_at, updated_at)
    SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, 'USER', 'ACTIVE', 'EMAIL', $9::jsonb, true, now(), now(), now()
      FROM proof
    RETURNING id),
  consent AS (
    INSERT INTO consent_records (user_id, purpose, granted, policy_version, source, ip_address, user_agent)
    SELECT ins.id, c.purpose, c.granted, $13::text, 'signup', $14::text, $15::text
      FROM ins CROSS JOIN jsonb_to_recordset($12::jsonb) AS c(purpose text, granted boolean)
    RETURNING 1)
  SELECT id FROM ins`;

/** The consent rows alone, for the path that runs without a sign-up code (development only). $1 = user id, $2 = rows as JSON, $3 = version, $4 = IP, $5 = user agent. */
export const SIGNUP_CONSENT_ROWS_SQL = `
  INSERT INTO consent_records (user_id, purpose, granted, policy_version, source, ip_address, user_agent)
  SELECT $1::uuid, c.purpose, c.granted, $3::text, 'signup', $4::text, $5::text
    FROM jsonb_to_recordset($2::jsonb) AS c(purpose text, granted boolean)`;
