import crypto from 'crypto';

/**
 * Sign-up e-mail verification codes for the web gateway: the same rules, table and hashes as the NestJS API
 * (`apps/api/src/auth/services/email-otp.service.ts`, `email-otp.util.ts`). The gateway can answer register itself, so it must enforce the
 * same proof; a known-answer test in each package pins the hash so the two cannot drift apart.
 *
 * The store functions take a `GatewayDb` so they run against the real pool in production and against an in-memory PostgreSQL in tests.
 */

export type EmailOtpPurpose = 'REGISTER';
export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_DAILY_LIMIT_PER_EMAIL = 10;
export const OTP_HOURLY_LIMIT_PER_IP = 20;
export const OTP_PROOF_TTL_SECONDS = 15 * 60;
export const GENERIC_OTP_SENT_MESSAGE = 'If this email can be used for verification, a 6-digit code has been sent.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 5 || e.length > 254 || !EMAIL_RE.test(e) || e.split('@').length !== 2) return null;
  return e;
}

export function normalizeOtp(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).replace(/[\s-]/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

export function generateOtp(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function otpKey(env: NodeJS.ProcessEnv): string {
  const base = (env.EMAIL_OTP_SECRET || env.JWT_ACCESS_SECRET || '').trim();
  return crypto.createHmac('sha256', base || 'orion-email-otp').update('orion:email-otp').digest('hex');
}

export function hashEmailOtp(email: string, purpose: string, otp: string, env: NodeJS.ProcessEnv = process.env): string {
  return crypto.createHmac('sha256', otpKey(env)).update(`${purpose}:${email}:${otp}`).digest('hex');
}

export function hashClientAddress(ip: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ip || ip === 'unknown') return null;
  return crypto.createHmac('sha256', otpKey(env)).update(`ip:${ip}`).digest('hex').slice(0, 32);
}

export const hashProof = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');

export function newProof(challengeId: string): { token: string; hash: string } {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { token: `${challengeId}.${secret}`, hash: hashProof(secret) };
}

export function parseProof(token: unknown): { id: string; hash: string } | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{20,100}$/.test(secret)) return null;
  return { id, hash: hashProof(secret) };
}

export function safeEqualHex(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const m = (s: string) => (s.length <= 1 ? `${s}***` : `${s[0]}***${s.length > 2 ? s[s.length - 1] : ''}`);
  return `${m(local)}@${m(host)}${tld}`;
}

/** Always true in production. Outside production only REQUIRE_REGISTRATION_OTP=false turns it off. */
export function registrationOtpRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.NODE_ENV || '').trim() === 'production') return true;
  return !/^(0|false|no|off)$/i.test((env.REQUIRE_REGISTRATION_OTP || '').trim());
}

// ------------------------------------------------------------------------------------------------ store
export interface GatewayQuery {
  (text: string, params?: unknown[]): Promise<any[]>;
}
export interface GatewayDb {
  query: GatewayQuery;
  /** Runs `fn` in one transaction (commit on return, roll back on throw). */
  transaction<T>(fn: (q: GatewayQuery) => Promise<T>): Promise<T>;
}
export interface OtpResult {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, errorCode: string, message: string, details?: Record<string, unknown>): OtpResult => ({
  status,
  body: { success: false, statusCode: status, errorCode, message, ...(details ? { details } : {}) },
});

/**
 * Sends a code. `mailer` returns whether the message was handed to the provider. The answer is identical for an address that already has an
 * account (no code is sent; a decoy row keeps cooldown, limits and lockout identical).
 */
export async function sendEmailOtp(
  db: GatewayDb,
  input: { email: unknown; purpose?: unknown; ip?: string; accountExists: (email: string) => Promise<boolean>; existingAccountMailer?: (email: string) => Promise<boolean>; mailer: (email: string, code: string, minutes: number) => Promise<boolean> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<OtpResult> {
  const email = normalizeEmail(input.email);
  if (!email) return fail(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
  const purpose = typeof input.purpose === 'string' && input.purpose ? input.purpose.toUpperCase() : 'REGISTER';
  if (purpose !== 'REGISTER') return fail(400, 'INVALID_OTP_PURPOSE', 'Unsupported verification purpose');

  const exists = await input.accountExists(email);
  const ipHash = hashClientAddress(input.ip, env);
  const code = exists ? null : generateOtp();
  const storedHash = code ? hashEmailOtp(email, purpose, code, env) : crypto.randomBytes(32).toString('hex');

  let challengeId: string;
  try {
    const out = await db.transaction(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`email-otp:${purpose}:${email}`]);
      const stats = (
        await q(
          `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(created_at))), 1e9)::float AS since,
                  count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS daily
             FROM email_otp_challenges WHERE email = $1 AND purpose = $2`,
          [email, purpose],
        )
      )[0];
      if (Number(stats.since) < OTP_RESEND_COOLDOWN_SECONDS) {
        const wait = Math.max(1, Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - Number(stats.since)));
        return fail(429, 'OTP_RESEND_COOLDOWN', `Please wait ${wait} seconds before requesting another code.`, { retryAfterSeconds: wait });
      }
      if (Number(stats.daily) >= OTP_DAILY_LIMIT_PER_EMAIL) {
        return fail(429, 'OTP_DAILY_LIMIT', 'Too many verification codes were requested for this address today. Please try again tomorrow.');
      }
      if (ipHash) {
        const ip = (await q(`SELECT count(*)::int AS n FROM email_otp_challenges WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'`, [ipHash]))[0];
        if (Number(ip.n) >= OTP_HOURLY_LIMIT_PER_IP) return fail(429, 'OTP_RATE_LIMITED', 'Too many verification requests from this network. Please try again later.');
      }
      await q(`UPDATE email_otp_challenges SET invalidated_at = now() WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL AND invalidated_at IS NULL`, [email, purpose]);
      const ins = await q(
        `INSERT INTO email_otp_challenges (email, purpose, otp_hash, max_attempts, expires_at, ip_hash)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6) RETURNING id`,
        [email, purpose, storedHash, OTP_MAX_ATTEMPTS, OTP_TTL_SECONDS, ipHash],
      );
      return ins[0].id as string;
    });
    if (typeof out !== 'string') return out;
    challengeId = out;
  } catch {
    return fail(503, 'SERVICE_UNAVAILABLE', 'We could not send the verification code right now. Please try again in a moment.');
  }

  if (code) {
    let delivered = false;
    try {
      delivered = await input.mailer(email, code, Math.round(OTP_TTL_SECONDS / 60));
    } catch {
      delivered = false;
    }
    if (!delivered) {
      await db.query(`DELETE FROM email_otp_challenges WHERE id = $1`, [challengeId]).catch(() => undefined);
      return fail(503, 'EMAIL_DELIVERY_FAILED', 'We could not send the verification code right now. Please try again in a moment.');
    }
  }
  if (!code) {
    // The address already has an account: no code exists and the answer below stays identical, but its owner is told why nothing arrives.
    try {
      await input.existingAccountMailer?.(email);
    } catch {
      /* a failed notice changes nothing */
    }
  }
  return {
    status: 200,
    body: { success: true, statusCode: 200, message: GENERIC_OTP_SENT_MESSAGE, maskedEmail: maskEmail(email), expiresInSeconds: OTP_TTL_SECONDS, resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS },
  };
}

/** Checks a code. Each try is counted before it is compared, in one statement, so parallel requests cannot exceed the attempt limit. */
export async function verifyEmailOtp(
  db: GatewayDb,
  input: { email: unknown; otp: unknown; purpose?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<OtpResult> {
  const email = normalizeEmail(input.email);
  if (!email) return fail(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
  const purpose = typeof input.purpose === 'string' && input.purpose ? input.purpose.toUpperCase() : 'REGISTER';
  if (purpose !== 'REGISTER') return fail(400, 'INVALID_OTP_PURPOSE', 'Unsupported verification purpose');
  const otp = normalizeOtp(input.otp);
  if (!otp) return fail(400, 'OTP_INVALID', 'Enter the 6-digit code.');

  try {
    const claimed = (
      await db.query(
        `UPDATE email_otp_challenges
            SET attempts = attempts + 1,
                locked_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE locked_at END
          WHERE id = (SELECT id FROM email_otp_challenges
                       WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL AND invalidated_at IS NULL
                         AND locked_at IS NULL AND expires_at > now() AND attempts < max_attempts
                       ORDER BY created_at DESC LIMIT 1)
            AND consumed_at IS NULL AND invalidated_at IS NULL AND locked_at IS NULL AND expires_at > now() AND attempts < max_attempts
         RETURNING id, otp_hash, attempts, max_attempts`,
        [email, purpose],
      )
    )[0];

    if (!claimed) {
      const last = (
        await db.query(
          `SELECT consumed_at, invalidated_at, locked_at, (expires_at <= now()) AS expired
             FROM email_otp_challenges WHERE email = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
          [email, purpose],
        )
      )[0];
      if (last?.locked_at) return fail(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Request a new code.');
      if (last && last.expired && !last.consumed_at && !last.invalidated_at) return fail(400, 'OTP_EXPIRED', 'This code has expired. Request a new one.');
      return fail(400, 'OTP_INVALID', 'That code is not valid. Request a new one.');
    }

    if (!safeEqualHex(hashEmailOtp(email, purpose, otp, env), String(claimed.otp_hash))) {
      const remaining = Math.max(0, Number(claimed.max_attempts) - Number(claimed.attempts));
      if (remaining === 0) return fail(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Request a new code.');
      return fail(400, 'OTP_INVALID', 'Incorrect code. Check it and try again.', { attemptsRemaining: remaining });
    }

    const proof = newProof(claimed.id);
    const accepted = await db.transaction(async (q) => {
      const upd = await q(
        `UPDATE email_otp_challenges
            SET consumed_at = now(), proof_hash = $2, proof_expires_at = now() + make_interval(secs => $3)
          WHERE id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
          RETURNING id`,
        [claimed.id, proof.hash, OTP_PROOF_TTL_SECONDS],
      );
      if (!upd[0]) return false;
      await q(`UPDATE email_otp_challenges SET invalidated_at = now() WHERE email = $1 AND purpose = $2 AND id <> $3 AND consumed_at IS NULL AND invalidated_at IS NULL`, [email, purpose, claimed.id]);
      return true;
    });
    if (!accepted) return fail(400, 'OTP_INVALID', 'That code is not valid. Request a new one.');
    return { status: 200, body: { success: true, statusCode: 200, verified: true, verificationToken: proof.token, expiresInSeconds: OTP_PROOF_TTL_SECONDS, message: 'Email verified.' } };
  } catch {
    return fail(503, 'SERVICE_UNAVAILABLE', 'Verification is temporarily unavailable. Please try again.');
  }
}

/**
 * Creates the account ONLY if a live, unspent proof for exactly this address is presented, in ONE statement: the proof is spent and the user
 * row inserted together, so a failed insert (for example a duplicate address) leaves the proof unspent and a proof can never create two accounts.
 * Returns the number of rows inserted (0 = the proof was not acceptable).
 */
export const REGISTER_WITH_PROOF_SQL = `
  WITH proof AS (
    UPDATE email_otp_challenges SET proof_consumed_at = now()
     WHERE id = $10::uuid AND email = $2::text AND purpose = 'REGISTER' AND proof_hash = $11::text
       AND consumed_at IS NOT NULL AND proof_consumed_at IS NULL AND proof_expires_at > now()
    RETURNING id)
  INSERT INTO users (id, email, password_hash, first_name, last_name, display_name, organization_name, phone_number, role, status, provider, metadata, is_email_verified, email_verified_at, created_at, updated_at)
  SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, 'USER', 'ACTIVE', 'EMAIL', $9::jsonb, true, now(), now(), now()
    FROM proof
  RETURNING id`;

/** Adapts a `pg` Pool (or anything shaped like one) to the store's `GatewayDb`. */
export function poolAdapter(pool: { query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; connect(): Promise<{ query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; release(): void }> }): GatewayDb {
  return {
    query: async (text, params = []) => (await pool.query(text, params)).rows,
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(async (text, params = []) => (await client.query(text, params)).rows);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
