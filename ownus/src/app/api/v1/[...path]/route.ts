export const runtime = 'nodejs';
// Vercel: this gateway proxies to the Orion API and runs its own database queries (imports, exports, searches), so the platform's
// default function timeout is too short. 60 s fits every plan. Requests larger than 4.5 MB are refused by Vercel before this code runs.
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { backendBaseUrl, describeBackendTarget, hasRemoteBackend } from '@/lib/backend-url';
import { headersForApi, trustedForwardedFor } from '@/lib/client-ip';
import { assessWebsite } from '@/lib/website-status';
import { isPublishStatus, PUBLISH_REFUSED_REASON, refusedLookupSql, statusUpdateSql } from '@/lib/publish-guard';
import crypto from 'crypto';
import { findAdminAccount, fixedOtpAllowed } from '@/lib/admin-account';
import { burnPasswordCheck, hashPassword, needsRehash, verifyPassword } from '@/lib/password';
import { sendAdminOtpEmail, isAuthorizedAdminEmail, sendPasswordResetEmail, sendSignupOtpEmail, sendExistingAccountEmail } from '@/lib/email-service';
import { REGISTER_WITH_PROOF_SQL, parseProof, poolAdapter, registrationOtpRequired, sendEmailOtp, verifyEmailOtp } from '@/lib/email-otp';
import { dispatchUserNotification } from '@/lib/notification-dispatcher';
import { queryDb, queryDbStrict, DbWriteError, getDbPool } from '@/lib/db';
import { claimOtpAttempt, redeemOtp } from '@/lib/admin-otp-store';
import { MAX_EXPORT_IDS, MAX_EXPORT_ROWS, MAX_FILTER_TEXT, MAX_QUERY_LENGTH, clampText, escapeLike, parseLimit, parsePage, splitList } from '@/lib/search-input';
import { UNLOCK_BUSINESS_SQL, interpretUnlockRow } from '@/lib/unlock-business';
import {
  accessSecret as gwAccessSecret,
  adminSessionTtlSeconds,
  authenticate,
  decideAccess,
  isDefinitiveUpstream,
  isUuid,
  otpSecret as gwOtpSecret,
  refreshSecret as gwRefreshSecret,
  resetSecret as gwResetSecret,
  routePolicy,
  verifyToken,
  type IAuthContext,
} from '@/lib/gateway-auth';
import { DEFAULT_FILTER_CONFIG } from '@/lib/filter-options-store';
import { TransactionRecord } from '@/types/admin';
import { FALLBACK_PEOPLE_NOTICE, canonicalPersonColumn, countRowsWithPeopleData, withoutPersonColumns } from '@/lib/import-people-columns';
import { isValidEmail, passwordComplaint, validateAvatar, pickBooleanKeys, pickPreferences, NOTIFICATION_KEYS } from '@/lib/input-validation';
import { sanitizeCsvCell, csvField } from '@/lib/csv-security';
import { isLocalRequestHost } from '@/lib/cookie-security';

/**
 * Orion Production Gateway Proxy
 *
 * Ensures NestJS API remains the single source of truth for:
 * - Authentication & JWT token verification
 * - Credit wallets and atomic deduction ledger
 * - Real business discovery and PostgreSQL search
 * - Saved leads, saved searches, and lead unlock management
 * - Audit logging and administrative imports
 *
 * Provides native OAuth fallback when running in serverless Vercel environments
 * where upstream port 4000 is not running as a local daemon.
 */

function sanitizeEnvValue(val?: string, keyPrefix?: string): string {
  if (!val) return '';
  let cleaned = String(val).replace(/[\r\n]+/g, '').trim();
  cleaned = cleaned.replace(/^["'`]|["'`]$/g, '').trim();
  if (keyPrefix && cleaned.toLowerCase().startsWith(keyPrefix.toLowerCase() + '=')) {
    cleaned = cleaned.substring(keyPrefix.length + 1).trim();
  }
  cleaned = cleaned.replace(/^[A-Za-z0-9_]+=\s*/, '').trim();
  return cleaned.replace(/^["'`]|["'`]$/g, '').trim();
}

const LOCAL_RESET_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The application's own base URL for links we e-mail (password reset, etc.). Taken ONLY from server
 * configuration (NEXT_PUBLIC_APP_URL / APP_URL). The request's Origin and Host headers are attacker-
 * controlled, so they are never used to build a link that carries a credential. When nothing is
 * configured, only a genuinely local request may fall back to its own host; anything else fails closed
 * to localhost (a broken link) rather than trusting an arbitrary host. Production MUST set the env var.
 */
function appBaseUrl(req: NextRequest): string {
  const configured = sanitizeEnvValue(process.env.NEXT_PUBLIC_APP_URL) || sanitizeEnvValue(process.env.APP_URL);
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured.replace(/\/+$/, '');
  }
  const host = (req.headers.get('host') || req.nextUrl.host || 'localhost:3000').split(',')[0].trim();
  const hostname = host.split(':')[0].toLowerCase();
  if (LOCAL_RESET_HOSTS.has(hostname) || hostname.endsWith('.localhost')) {
    return `http://${host}`;
  }
  return 'http://localhost:3000';
}

function signJwt(payload: Record<string, any>, secret: string, expiresInSec: number): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSec,
    iss: process.env.JWT_ISSUER || 'orion-api',
    aud: process.env.JWT_AUDIENCE || 'orion-client',
  };
  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64Payload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${b64Header}.${b64Payload}`).digest('base64url');
  return `${b64Header}.${b64Payload}.${sig}`;
}

/**
 * Returns the payload of a VALID access token (signature, expiry, subject, purpose), or null. It no longer decodes unsigned
 * tokens: every identity derived from it is verified (Phase 6.17).
 */
function decodeJwtPayload(token: string): any {
  return verifyToken(token, gwAccessSecret(), 'access');
}

const authNotConfigured = () =>
  NextResponse.json(
    { success: false, statusCode: 503, errorCode: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured on this gateway.', timestamp: new Date().toISOString() },
    { status: 503 },
  );
const unauthorized = () =>
  NextResponse.json(
    { success: false, statusCode: 401, errorCode: 'UNAUTHORIZED', message: 'A valid session is required.', timestamp: new Date().toISOString() },
    { status: 401 },
  );
const paymentsUnavailable = () =>
  NextResponse.json(
    { success: false, statusCode: 503, errorCode: 'PAYMENTS_UNAVAILABLE', message: 'Payments and invoices are handled by the Orion backend, which is currently unreachable. Nothing was charged or credited.', timestamp: new Date().toISOString() },
    { status: 503 },
  );

function handleGoogleAuth(req: NextRequest): NextResponse {
  const clientId = sanitizeEnvValue(process.env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID');
  if (!clientId || clientId.includes('your-') || clientId.includes('demo-')) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(
          'Google OAuth client ID is not configured. Please define GOOGLE_CLIENT_ID in your environment variables.',
        )}`,
        req.url,
      ),
    );
  }

  const host = req.headers.get('x-forwarded-host') || req.nextUrl.host || 'orion-api-snowy.vercel.app';
  const isLocal = isLocalRequestHost(host);
  let callbackUrl = sanitizeEnvValue(process.env.GOOGLE_CALLBACK_URL, 'GOOGLE_CALLBACK_URL');
  if (!callbackUrl || !callbackUrl.startsWith('http')) {
    callbackUrl = `${isLocal ? 'http' : 'https'}://${host}/api/v1/auth/google/callback`;
  }
  if (!isLocal && callbackUrl.startsWith('http://')) {
    callbackUrl = callbackUrl.replace(/^http:\/\//, 'https://');
  }

  const state = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
    state,
  });

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  const res = NextResponse.redirect(new URL(googleAuthUrl));

  res.cookies.set('orion_oauth_state', state, {
    path: '/',
    httpOnly: true,
    secure: !isLocal,
    sameSite: 'lax',
    maxAge: 600,
  });

  return res;
}

async function handleGoogleCallback(req: NextRequest): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent('Google sign-in was cancelled or denied.')}`, req.url),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent('Missing authorization code from Google.')}`, req.url),
    );
  }

  // S-10: verify the OAuth `state` against the value we set in the httpOnly cookie at the start of the flow,
  // using a constant-time compare. This blocks login-CSRF (an attacker signing a victim into the attacker's
  // account). A missing or mismatched state aborts the sign-in.
  const returnedState = req.nextUrl.searchParams.get('state') || '';
  const expectedState = req.cookies.get('orion_oauth_state')?.value || '';
  const stateOk =
    returnedState.length > 0 &&
    expectedState.length === returnedState.length &&
    (() => {
      try {
        return crypto.timingSafeEqual(Buffer.from(expectedState), Buffer.from(returnedState));
      } catch {
        return false;
      }
    })();
  if (!stateOk) {
    const res = NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent('Sign-in could not be verified. Please try again.')}`, req.url),
    );
    res.cookies.delete('orion_oauth_state');
    return res;
  }

  const clientId = sanitizeEnvValue(process.env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID');
  const clientSecret = sanitizeEnvValue(process.env.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET');

  const host = req.headers.get('x-forwarded-host') || req.nextUrl.host || 'orion-api-snowy.vercel.app';
  const isLocal = isLocalRequestHost(host);
  let callbackUrl = sanitizeEnvValue(process.env.GOOGLE_CALLBACK_URL, 'GOOGLE_CALLBACK_URL');
  if (!callbackUrl || !callbackUrl.startsWith('http')) {
    callbackUrl = `${isLocal ? 'http' : 'https'}://${host}/api/v1/auth/google/callback`;
  }
  if (!isLocal && callbackUrl.startsWith('http://')) {
    callbackUrl = callbackUrl.replace(/^http:\/\//, 'https://');
  }

  try {
    const bodyParams: Record<string, string> = {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
    };

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(bodyParams).toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('Google token exchange error:', errText);
      let userMessage = 'Failed to exchange authorization code with Google.';
      try {
        const parsedErr = JSON.parse(errText);
        if (parsedErr.error_description) {
          userMessage = `Google sign-in error: ${parsedErr.error_description}`;
        }
      } catch {
        // Keep default
      }
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent(userMessage)}`, req.url),
      );
    }

    const tokenData = await tokenRes.json();

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!profileRes.ok) {
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent('Failed to retrieve user profile from Google.')}`, req.url),
      );
    }

    const profile = await profileRes.json();
    const email = String(profile.email || '').toLowerCase().trim();
    if (!email) {
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent('Google authentication failed: Email address not returned by Google.')}`, req.url),
      );
    }
    // S-10: only a Google-verified email may be linked to (or create) an account, so an attacker cannot take
    // over an existing account by registering its address at an identity provider without proving ownership.
    if (profile.email_verified !== true && profile.email_verified !== 'true') { // Phase 25: must be affirmatively verified (same rule as the API, SG-03)
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent('Your Google email address is not verified. Please verify it with Google and try again.')}`, req.url),
      );
    }

    const firstName = profile.given_name || profile.name?.split(' ')[0] || 'User';
    const lastName = profile.family_name || profile.name?.split(' ').slice(1).join(' ') || '';
    const displayName = profile.name || email.split('@')[0];
    const avatarUrl = profile.picture || null;
    const googleId = profile.sub || null;

    let dbUser: any = null;
    let isNewUser = false;

    try {
      const existingRows = await queryDb(`SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [email]);
      if (existingRows.length > 0) {
        const updateRows = await queryDb(
          `UPDATE users
           SET first_name = COALESCE(first_name, $1),
               last_name = COALESCE(last_name, $2),
               display_name = COALESCE(display_name, $3),
               avatar_url = COALESCE($4, avatar_url),
               google_id = COALESCE($5, google_id),
               provider = CASE WHEN provider = 'EMAIL' OR provider IS NULL THEN 'google' ELSE provider END,
               updated_at = NOW()
           WHERE LOWER(email) = LOWER($6)
           RETURNING *`,
          [firstName, lastName, displayName, avatarUrl, googleId, email]
        );
        dbUser = updateRows[0] || existingRows[0];
      } else {
        isNewUser = true;
        const insertRows = await queryDb(
          `INSERT INTO users (email, first_name, last_name, display_name, avatar_url, google_id, provider, role, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'google', 'USER', 'ACTIVE')
           RETURNING *`,
          [email, firstName, lastName, displayName, avatarUrl, googleId]
        );
        dbUser = insertRows[0];
      }
    } catch (dbErr) {
      console.error('[Google OAuth] Error upserting user in PostgreSQL:', dbErr);
    }

    // Phase 25: a suspended or inactive account does not get a session from the social-login path either (the API refuses it too)
    if (dbUser && (dbUser.status === 'SUSPENDED' || dbUser.status === 'INACTIVE')) {
      return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent('Your account is inactive. Please contact support.')}`, req.url));
    }

    const userId = dbUser?.id || email;
    await getOrSyncUserWallet(email);

    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const currentMeta = (dbUser?.metadata as any) || {};
    const updatedMeta = { ...currentMeta, activeSessionId: sessionId };

    await queryDb(
      `UPDATE users SET metadata = $1::jsonb, updated_at = NOW() WHERE LOWER(email) = LOWER($2)`,
      [JSON.stringify(updatedMeta), email]
    );

    const accessSecret = gwAccessSecret();
    const refreshSecret = gwRefreshSecret();
    if (!accessSecret || !refreshSecret) {
      return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent('Authentication is not configured.')}`, req.url));
    }

    const userPayload = {
      sub: userId,
      email,
      firstName: dbUser?.first_name || firstName,
      lastName: dbUser?.last_name || lastName,
      name: dbUser?.display_name || displayName,
      displayName: dbUser?.display_name || displayName,
      avatarUrl: dbUser?.avatar_url || avatarUrl,
      role: dbUser?.role || 'USER',
      status: dbUser?.status || 'ACTIVE',
      organizationId: dbUser?.organization_name || null,
      provider: 'google',
      sessionId,
    };

    const accessToken = signJwt(userPayload, accessSecret, ACCESS_TOKEN_TTL_SEC);
    const refreshToken = signJwt({ sub: userId, email, type: 'refresh' }, refreshSecret, 7 * 24 * 3600);

    const redirectUrl = new URL(
      `/auth/callback?accessToken=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(
        refreshToken,
      )}&provider=google&isNewUser=${isNewUser}`,
      req.url,
    );

    const res = NextResponse.redirect(redirectUrl);
    res.cookies.delete('orion_oauth_code_verifier');
    res.cookies.delete('orion_oauth_state');
    return res;
  } catch (err: any) {
    console.error('Google OAuth callback error:', err);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(err.message || 'Google authentication failed.')}`, req.url),
    );
  }
}

// S-04 / S-21: admin OTPs live in the shared admin_otps table, stored only as a keyed HMAC (never plaintext).
// The table is the single source of truth, so the attempt counter and single-use guarantee survive a restart
// or hold across separate serverless instances, and there is no stateless challenge cookie to replay.
const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MIN_RESEND_SECONDS = 45; // throttles re-sends per email, independent of client IP

function hashOtp(email: string, otp: string): string {
  return crypto.createHmac('sha256', gwOtpSecret() ?? '').update(`${email.toLowerCase().trim()}:${String(otp).trim()}`).digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  try {
    const x = Buffer.from(a, 'hex');
    const y = Buffer.from(b, 'hex');
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

/**
 * S-09: lightweight per-key limiter for the gateway's own credential endpoints (login, register, forgot-password),
 * which @nestjs/throttler does not cover. It is in-process, so on a multi-instance serverless deployment it only
 * limits per instance — a shared store (Postgres / Upstash) is the production-grade backing and is called out in
 * the infrastructure handoff. It still blocks single-instance and self-hosted credential stuffing.
 */
const gatewayRateStore = new Map<string, { count: number; resetAt: number }>();
function gatewayRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (gatewayRateStore.size > 10000) {
    for (const [k, v] of gatewayRateStore) if (v.resetAt < now) gatewayRateStore.delete(k);
  }
  const entry = gatewayRateStore.get(key);
  if (!entry || now > entry.resetAt) {
    gatewayRateStore.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  if (entry.count >= limit) return true;
  entry.count++;
  return false;
}
function clientIpOf(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for') || '';
  return (xff.split(',')[0] || req.headers.get('x-real-ip') || 'unknown').trim();
}
const tooManyRequests = (message: string) =>
  NextResponse.json({ success: false, statusCode: 429, errorCode: 'RATE_LIMITED', message }, { status: 429 });

/**
 * Request body as an object. Malformed JSON still throws, as `req.json()` does (callers that expect it answer 400). A body that is
 * valid JSON but not an object (null, a number, a string) used to reach handlers that read `body.x` and crash with a 500; it is now
 * an empty object, so the handler's own "field is required" answer applies. An array is kept (the import route takes a list).
 */
async function readJson(req: NextRequest): Promise<any> {
  const v = await req.json();
  return v !== null && typeof v === 'object' ? v : {};
}

/** A refused write, as the client should see it: bad values are the caller's (400, 409), anything else is a temporary failure (503). Nothing from the driver is echoed. */
function writeFailure(err: unknown): NextResponse {
  const code = err instanceof DbWriteError ? err.code : undefined;
  if (code === '23505') return NextResponse.json({ success: false, statusCode: 409, errorCode: 'ALREADY_EXISTS', message: 'That value is already in use.' }, { status: 409 });
  if (code && (code.startsWith('22') || code.startsWith('23'))) {
    return NextResponse.json({ success: false, statusCode: 400, errorCode: 'INVALID_VALUE', message: 'One of the values is not valid or is too long.' }, { status: 400 });
  }
  return NextResponse.json({ success: false, statusCode: 503, errorCode: 'SAVE_FAILED', message: 'Your changes could not be saved. Please try again.' }, { status: 503 });
}

async function handleAdminSendOtp(req: NextRequest): Promise<NextResponse> {
  if (!gwOtpSecret()) return authNotConfigured();
  let body: any = {};
  try {
    body = await readJson(req);
  } catch {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const email = String(body?.email || '').toLowerCase().trim();
  if (!email) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Please provide your administrator email.' },
      { status: 400 },
    );
  }

  if (!isAuthorizedAdminEmail(email)) {
    return NextResponse.json(
      {
        success: false,
        statusCode: 403,
        message: 'Access Denied: Only @monarchsoftwares.com email addresses are authorized for administrative access.',
      },
      { status: 403 },
    );
  }

  const genericSent = () =>
    NextResponse.json({
      success: true,
      statusCode: 200,
      message: `A 6-digit verification passcode has been dispatched to ${email}.`,
      data: { expiresIn: OTP_TTL_SECONDS },
      timestamp: new Date().toISOString(),
    });

  // The domain is only a first filter: a code is issued only for a persisted, ACTIVE ADMIN / SUPER_ADMIN account. Anyone else
  // receives the same response and no e-mail (no account enumeration).
  if (!(await findAdminAccount({ email }))) {
    return genericSent();
  }

  // S-04: re-send throttling and single-active-code enforcement live in the database (not an IP-keyed in-memory
  // counter that a rotating X-Forwarded-For defeats and a restart resets).
  try {
    await queryDb(`DELETE FROM admin_otps WHERE expires_at < NOW()`);
    const recent = await queryDb(
      `SELECT 1 FROM admin_otps WHERE email = $1 AND created_at > NOW() - make_interval(secs => $2) LIMIT 1`,
      [email, OTP_MIN_RESEND_SECONDS],
    );
    if (recent.length > 0) {
      return NextResponse.json(
        { success: false, statusCode: 429, message: 'A verification code was just sent. Please wait a moment before requesting another.' },
        { status: 429 },
      );
    }
  } catch (e) {
    console.error('[Gateway] admin OTP throttle check failed:', (e as any)?.message);
  }

  const otp = crypto.randomInt(100000, 999999).toString();
  const otpHash = hashOtp(email, otp);
  try {
    await queryDb(`DELETE FROM admin_otps WHERE email = $1`, [email]);
    await queryDb(
      `INSERT INTO admin_otps (email, otp, attempts, max_attempts, expires_at)
       VALUES ($1, $2, 0, $3, NOW() + make_interval(secs => $4))`,
      [email, otpHash, OTP_MAX_ATTEMPTS, OTP_TTL_SECONDS],
    );
  } catch (e) {
    console.error('[Gateway] admin OTP persist failed:', (e as any)?.message);
    return NextResponse.json(
      { success: false, statusCode: 503, message: 'Could not generate a verification code right now. Please try again shortly.' },
      { status: 503 },
    );
  }

  const emailResult = await sendAdminOtpEmail({ email, otp, expiresInMinutes: Math.round(OTP_TTL_SECONDS / 60) });
  if (!emailResult.success) {
    await queryDb(`DELETE FROM admin_otps WHERE email = $1`, [email]).catch(() => {});
    return NextResponse.json(
      { success: false, statusCode: 503, message: emailResult.error || 'Failed to dispatch verification email. Please ensure RESEND_API_KEY is configured.' },
      { status: 503 },
    );
  }

  return genericSent();
}

async function handleAdminVerifyOtp(req: NextRequest): Promise<NextResponse> {
  if (!gwOtpSecret()) return authNotConfigured();
  let body: any = {};
  try {
    body = await readJson(req);
  } catch {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const email = String(body?.email || '').toLowerCase().trim();
  const otp = String(body?.otp || '').trim();

  if (!email || !otp) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Email and verification code are required.' },
      { status: 400 },
    );
  }

  if (!isAuthorizedAdminEmail(email)) {
    void recordGatewayAudit(req, 'ADMIN_OTP_UNAUTHORIZED_DOMAIN', 'USER', { reason: 'domain_not_allowed' });
    return NextResponse.json(
      { success: false, statusCode: 403, message: 'Access Denied: Only @monarchsoftwares.com email addresses are authorized for administrative access.' },
      { status: 403 },
    );
  }

  // Second layer behind the per-code attempt cap (which is persisted and atomic): bounds code-guessing across successive codes.
  // In-process, so per instance only (see gatewayRateLimited); the persisted per-code cap is what holds across instances.
  if (gatewayRateLimited(`otpverify:acct:${email}`, 15, 5 * 60000) || gatewayRateLimited(`otpverify:ip:${clientIpOf(req)}`, 30, 5 * 60000)) {
    return tooManyRequests('Too many verification attempts. Please wait a few minutes and try again.');
  }

  const invalidCode = () => {
    // Phase 25: a failed administrator sign-in is audited (no e-mail, no code); the monitoring rule for administrator sign-in failures reads this
    void recordGatewayAudit(req, 'ADMIN_OTP_FAILED', 'USER', { reason: 'invalid_or_expired_code' });
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Invalid or expired verification code.' },
      { status: 400 },
    );
  };

  // S-04: validate against the single active, unexpired code in the database. The code is stored only as an
  // HMAC and compared in constant time; the attempt counter is persisted (so a restart or another instance
  // cannot reset it) and a correct code is deleted immediately (single use, no replay). There is no challenge
  // cookie. The deterministic test code is honoured only under fixedOtpAllowed() (local automated tests).
  let adminAccount: Awaited<ReturnType<typeof findAdminAccount>> = null;
  try {
    const rows = await queryDb(
      `SELECT id, otp, attempts, max_attempts FROM admin_otps WHERE email = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    const row: any = rows[0];

    if (!row) {
      if (fixedOtpAllowed() && otp === '123456') {
        adminAccount = await findAdminAccount({ email });
      }
      if (!adminAccount) return invalidCode();
    } else {
      // Claim an attempt BEFORE comparing (atomic, only while attempts remain): parallel guesses cannot exceed max_attempts.
      if (!(await claimOtpAttempt(queryDb, String(row.id)))) {
        void recordGatewayAudit(req, 'ADMIN_OTP_FAILED', 'USER', { reason: 'attempts_exhausted' });
        return NextResponse.json(
          { success: false, statusCode: 429, message: 'Too many failed attempts. This verification session is locked. Please request a new code.' },
          { status: 429 },
        );
      }
      const codeOk = timingSafeHexEqual(String(row.otp), hashOtp(email, otp)) || (fixedOtpAllowed() && otp === '123456');
      const acct = codeOk ? await findAdminAccount({ email }) : null;
      if (!codeOk || !acct) return invalidCode(); // the attempt was already counted
      // Single use and race-safe: only the caller that deletes the row is signed in; a parallel request with the same code is refused.
      if (!(await redeemOtp(queryDb, String(row.id)))) return invalidCode();
      adminAccount = acct;
    }
  } catch (e) {
    console.error('[Gateway] admin OTP verify error:', (e as any)?.message);
    return NextResponse.json(
      { success: false, statusCode: 503, message: 'Verification is temporarily unavailable. Please try again.' },
      { status: 503 },
    );
  }

  const { firstName, lastName, role: adminRole, id: userId } = adminAccount as NonNullable<typeof adminAccount>;

  const accessSecret = gwAccessSecret();
  if (!accessSecret) return authNotConfigured();
  // Phase 25: the administrator session is revocable like a customer one. It carries a session id stored as the account's active session,
  // so a logout or a newer sign-in makes the older token fail assertSessionCurrent.
  const adminSessionId = await rotateActiveSession(userId);
  void recordGatewayAudit(req, 'ADMIN_LOGIN_SUCCESS', 'USER', { entityId: userId }, userId);
  const adminToken = signJwt(
    {
      sub: userId,
      email,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      displayName: `${firstName} ${lastName}`,
      role: adminRole,
      status: 'ACTIVE',
      organizationId: null,
      provider: 'EMAIL',
      sessionId: adminSessionId,
    },
    accessSecret,
    adminSessionTtlSeconds(),
  );

  const res = NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Administrator session authenticated',
    data: {
      adminToken,
      user: {
        id: userId,
        email,
        firstName,
        lastName,
        name: `${firstName} ${lastName}`,
        displayName: `${firstName} ${lastName}`,
        role: adminRole,
        organizationName: 'Monarch Softwares',
      },
    },
    timestamp: new Date().toISOString(),
  });

  const isLocal = isLocalRequestHost(req.headers.get('host'));
  // S-11: the token cookie is HttpOnly + Secure so page scripts cannot read it. (The SPA uses the token from the
  // response body for its Authorization header; nothing client-side reads this cookie.)
  res.cookies.set('orion_admin_token', adminToken, {
    path: '/',
    httpOnly: true,
    secure: !isLocal,
    sameSite: 'lax',
    maxAge: adminSessionTtlSeconds(),
  });
  res.cookies.delete('orion_admin_otp_challenge');

  return res;
}

async function handleAdminLogout(req: NextRequest): Promise<NextResponse> {
  // Phase 25: ends the session on the server, not only in the browser. Only the CURRENT session may end the account's session (a stale or
  // forged token is ignored), so an old token cannot be used to log the administrator out of a newer sign-in.
  try {
    const a = authenticate(req.headers);
    if (a.ok && isUuidSub(a.auth.sub) && !(await assertSessionCurrent(a.auth))) {
      await rotateActiveSession(a.auth.sub);
      void recordGatewayAudit(req, 'ADMIN_LOGOUT', 'USER', { entityId: a.auth.sub }, a.auth.sub);
    }
  } catch {
    // logging out always succeeds for the browser
  }
  const res = NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Admin session terminated successfully',
    data: { loggedOut: true },
    timestamp: new Date().toISOString(),
  });
  res.cookies.delete('orion_admin_token');
  res.cookies.delete('orion_admin_otp_challenge');
  return res;
}

/**
 * S-05: user logout revokes the session server-side. Rotating the account's active session id invalidates
 * every access and refresh token previously issued to it (both the gateway's and, via JwtStrategy, the NestJS
 * API's), so a stolen token stops working the moment the real user logs out. Always succeeds (idempotent).
 */
async function handleUserLogout(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get('authorization') || '';
    const m = /^Bearer\s+(\S+)$/i.exec(authHeader);
    let sub: string | undefined = m ? verifyToken(m[1], gwAccessSecret(), 'access')?.sub : undefined;
    if (!sub) {
      const body = await req.clone().json().catch(() => ({}));
      const rt = String(body?.refreshToken || '').trim();
      if (rt) sub = verifyToken(rt, gwRefreshSecret(), 'refresh')?.sub;
    }
    if (sub && isUuidSub(sub)) await rotateActiveSession(sub);
  } catch (err) {
    console.error('[Gateway] logout session rotation error:', (err as any)?.message);
  }
  const res = NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Logged out successfully',
    data: { loggedOut: true },
    timestamp: new Date().toISOString(),
  });
  res.cookies.delete('orion_access_token');
  return res;
}

// Canonical company-upload template. MUST stay identical to docs/ORION_IMPORT_TEMPLATE.csv and to
// AdminImportService.getCanonicalTemplateCsv() (a backend test compares all three).
// Company-level columns: business_name ... founding_year (incl. email, phone, website: these belong to the COMPANY).
// Person-level columns: contact_person, contact_title, person_*, person_2_*, person_3_* (people 4 and 5 use the same pattern).
// BEGIN CANONICAL TEMPLATE
const CANONICAL_TEMPLATE_CSV = `business_name,legal_name,gstin,cin,pan,address_line1,city,district,state,pincode,phone,email,website,contact_person,contact_title,business_type,msme_category,industry,category,description,founding_year,person_email,person_phone,person_mobile,person_linkedin,person_2_name,person_2_title,person_2_email,person_2_phone,person_2_mobile,person_2_linkedin,person_3_name,person_3_title,person_3_email,person_3_phone,person_3_mobile,person_3_linkedin
"Tata Consultancy Services","Tata Consultancy Services Limited","27AAACT2727Q1ZW","L22210MH1995PLC084781","AAACT2727Q","9th Floor Nirmal Building Nariman Point","Mumbai","Mumbai","Maharashtra","400021","'+91 22 67789999","corporate.office@tcs.com","https://www.tcs.com","K. Krithivasan","CEO & Managing Director","PUBLIC_LIMITED","NOT_APPLICABLE","Information Technology","IT Services & Consulting","Global leader in IT services, digital and business solutions.","1968","","","","","","","","","","","","","","","",""
"Infosys Limited","Infosys Limited","29AAACI4397H1Z5","L85110KA1981PLC013115","AAACI4397H","Plot No 44 Electronics City Hosur Road","Bangalore","Bengaluru Urban","Karnataka","560100","'+91 80 28520261","investors@infosys.com","https://www.infosys.com","Salil Parekh","CEO & Managing Director","PUBLIC_LIMITED","NOT_APPLICABLE","Information Technology","Enterprise Software & AI","Next-generation digital services and consulting.","1981","","","","","","","","","","","","","","","",""
`;
// END CANONICAL TEMPLATE

function handleAdminCsvTemplate(): NextResponse {
  const csvContent = CANONICAL_TEMPLATE_CSV;
  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="orion_canonical_business_import_template.csv"',
    },
  });
}

const INDIAN_STATES_SET = new Set([
  'andaman and nicobar islands', 'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar',
  'chandigarh', 'chhattisgarh', 'dadra and nagar haveli and daman and diu', 'delhi', 'goa',
  'gujarat', 'haryana', 'himachal pradesh', 'jammu and kashmir', 'jharkhand', 'karnataka',
  'kerala', 'ladakh', 'lakshadweep', 'madhya pradesh', 'maharashtra', 'manipur', 'meghalaya',
  'mizoram', 'nagaland', 'odisha', 'puducherry', 'punjab', 'rajasthan', 'sikkim',
  'tamil nadu', 'telangana', 'tripura', 'uttar pradesh', 'uttarakhand', 'west bengal'
]);

function normalizeRowHeader(key: string, customMapping?: Record<string, string>, sampleVal?: string): string {
  const clean = key.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  if (customMapping && Object.keys(customMapping).length > 0) {
    for (const [csvHeader, canonical] of Object.entries(customMapping)) {
      const cHeaderClean = csvHeader.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
      const cCanonClean = (canonical || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
      if (cHeaderClean === clean && canonical) {
        return canonical;
      }
      if (cCanonClean === clean && csvHeader) {
        return csvHeader;
      }
    }
  }

  // People columns (person_*) are never company fields: a substring match on email/phone/name would leak them.
  const personColumn = canonicalPersonColumn(key);
  if (personColumn) return personColumn;

  // 1. Precise Header Pattern Matching across arbitrary column arrangements
  if (clean.includes('businessname') || clean.includes('companyname') || clean.includes('firmname') || clean.includes('entityname') || clean.includes('tradename') || clean.includes('orgname') || clean.includes('vendorname') || clean.includes('storename') || clean.includes('shopname') || clean.includes('brandname')) return 'business_name';
  if (clean.includes('business') || clean.includes('company') || clean === 'name' || clean.includes('entity') || clean.includes('firm') || clean.includes('organization') || clean.includes('trade')) return 'business_name';
  if (clean.includes('legalname') || clean.includes('registeredname') || clean.includes('officialname')) return 'legal_name';
  if (clean.includes('gstin') || clean.includes('gstno') || clean.includes('gstnumber') || clean === 'gst') return 'gstin';
  if (clean.includes('cin') || clean.includes('corporateid') || clean.includes('mcacin')) return 'cin';
  if (clean.includes('pan') || clean.includes('panno') || clean.includes('pannumber')) return 'pan';
  if (clean.includes('phone') || clean.includes('mobile') || clean.includes('contactno') || clean.includes('contactnumber') || clean.includes('telephone') || clean.includes('tel') || clean.includes('whatsapp') || clean.includes('cell')) return 'phone';
  if (clean.includes('email') || clean.includes('mail') || clean.includes('emailid')) return 'email';
  if (clean.includes('website') || clean.includes('web') || clean.includes('site') || clean.includes('url') || clean.includes('domain')) return 'website';
  if (clean === 'state' || clean.includes('statename') || clean.includes('province') || clean.includes('region')) return 'state';
  if (clean === 'city' || clean.includes('cityname') || clean.includes('town') || clean.includes('hub')) return 'city';
  if (clean.includes('district') || clean.includes('dist')) return 'district';
  if (clean.includes('pincode') || clean.includes('pin') || clean.includes('postal') || clean.includes('zip')) return 'pincode';
  if (clean.includes('address') || clean.includes('street') || clean.includes('office') || clean.includes('premises') || clean.includes('location')) return 'address_line1';
  if (clean.includes('contactperson') || clean.includes('contactname') || clean.includes('director') || clean.includes('promoter') || clean.includes('owner') || clean.includes('keycontact')) return 'contact_person';
  if (clean.includes('contacttitle') || clean.includes('designation') || clean.includes('role') || clean === 'title' || clean.includes('position')) return 'contact_title';
  if (clean.includes('businesstype') || clean.includes('entitytype') || clean.includes('constitution') || clean.includes('companytype')) return 'business_type';
  if (clean.includes('msme') || clean.includes('enterprisetype')) return 'msme_category';
  if (clean.includes('industry') || clean.includes('sector')) return 'industry';
  if (clean.includes('category') || clean.includes('subindustry') || clean.includes('segment')) return 'category';
  if (clean.includes('description') || clean.includes('about') || clean.includes('summary')) return 'description';
  if (clean.includes('founding') || clean.includes('incorporation') || clean.includes('registrationdate') || clean.includes('established')) return 'founding_year';

  // 2. Content-Type Fallback Heuristic Auto-Detection if Header is Unknown / Unrecognized
  if (sampleVal) {
    const valTrim = sampleVal.trim();
    if (/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i.test(valTrim)) return 'gstin';
    if (/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/i.test(valTrim)) return 'cin';
    if (/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i.test(valTrim)) return 'pan';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valTrim)) return 'email';
    if (/^(?:\+91[\-\s]?)?[6-9]\d{9}$/.test(valTrim.replace(/[\s\-\(\)]/g, ''))) return 'phone';
    if (/^(https?:\/\/)?(www\.)?[a-zA-Z0-9\-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(valTrim)) return 'website';
    if (INDIAN_STATES_SET.has(valTrim.toLowerCase())) return 'state';
    if (/^[1-9][0-9]{5}$/.test(valTrim)) return 'pincode';
  }

  return key;
}

/** Fallback mode never ingests people; it reports that plainly instead of guessing or silently dropping. */
function peopleFallbackReport(rows: Array<Record<string, unknown>>) {
  const rowsWithPeopleData = countRowsWithPeopleData(rows);
  return {
    processed: false,
    mode: 'FALLBACK',
    rowsWithPeopleData,
    notice: rowsWithPeopleData > 0 ? FALLBACK_PEOPLE_NOTICE : null,
  };
}

async function handleAdminImportPreview(req: NextRequest): Promise<NextResponse> {
  let body: any = {};
  try {
    body = await readJson(req);
  } catch {
    body = {};
  }
  const rows: Array<Record<string, unknown>> = Array.isArray(body?.rows) ? body.rows : [];
  const customMapping: Record<string, string> = body?.customMapping || body?.mapping || {};

  if (rows.length === 0) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'No rows provided for import preview' },
      { status: 400 },
    );
  }

  const rawHeaders = Object.keys(rows[0] || {});
  const detectedFieldMappings = rawHeaders.map((header) => {
    const sampleValue = rows[0] && rows[0][header] !== undefined && rows[0][header] !== null ? String(rows[0][header]) : '';
    const canonicalKey = normalizeRowHeader(header, customMapping, sampleValue);
    const isCustom = Boolean(customMapping && (customMapping[header] || Object.values(customMapping).includes(header)));
    return {
      csvHeader: header,
      canonicalKey,
      sampleValue,
      isAutoMapped: !isCustom && canonicalKey !== header,
    };
  });

  const previewRecords: any[] = [];
  const duplicates: any[] = [];
  const errors: any[] = [];

  const seenGstins = new Map<string, number>();
  const seenCins = new Map<string, number>();
  const seenNameCity = new Map<string, number>();

  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;
  let warningCount = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const rowNumber = idx + 1;
    const raw = rows[idx];
    const mapped: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined && v !== null && v !== '') {
        const valStr = String(v).trim();
        const canonicalKey = normalizeRowHeader(k, customMapping, valStr);
        mapped[canonicalKey] = valStr;

        // Populate property aliases for seamless internal access
        if (canonicalKey === 'business_name' || canonicalKey === 'name') {
          mapped.business_name = valStr;
          mapped.name = valStr;
          mapped.company_name = valStr;
        } else if (canonicalKey === 'legal_name' || canonicalKey === 'legalName') {
          mapped.legal_name = valStr;
          mapped.legalName = valStr;
        } else if (canonicalKey === 'address_line1' || canonicalKey === 'address') {
          mapped.address_line1 = valStr;
          mapped.address = valStr;
        } else if (canonicalKey === 'contact_person' || canonicalKey === 'contactPerson') {
          mapped.contact_person = valStr;
          mapped.contactPerson = valStr;
        } else if (canonicalKey === 'contact_title' || canonicalKey === 'title') {
          mapped.contact_title = valStr;
          mapped.title = valStr;
        } else if (canonicalKey === 'business_type' || canonicalKey === 'businessType') {
          mapped.business_type = valStr;
          mapped.businessType = valStr;
        } else if (canonicalKey === 'msme_category' || canonicalKey === 'msmeCategory') {
          mapped.msme_category = valStr;
          mapped.msmeCategory = valStr;
        } else if (canonicalKey === 'founding_year' || canonicalKey === 'foundingYear') {
          mapped.founding_year = valStr;
          mapped.foundingYear = valStr;
        } else if (canonicalKey === 'category' || canonicalKey === 'subIndustry') {
          mapped.category = valStr;
          mapped.subIndustry = valStr;
        }
      }
    }

    // Intra-Row Fallback Auto-Detection for missing mandatory fields (people columns are excluded: a person value is never a company field)
    const companyOnlyRaw = withoutPersonColumns(raw as Record<string, unknown>);
    if (!mapped.business_name && !mapped.name) {
      for (const [k, v] of Object.entries(companyOnlyRaw)) {
        const valStr = String(v || '').trim();
        if (valStr && !/^[0-9+@]/i.test(valStr) && valStr.length > 2 && !INDIAN_STATES_SET.has(valStr.toLowerCase())) {
          mapped.business_name = valStr;
          mapped.name = valStr;
          break;
        }
      }
    }
    if (!mapped.state) {
      for (const [k, v] of Object.entries(companyOnlyRaw)) {
        const valStr = String(v || '').trim();
        if (valStr && INDIAN_STATES_SET.has(valStr.toLowerCase())) {
          mapped.state = valStr;
          break;
        }
      }
    }
    if (!mapped.phone) {
      for (const [k, v] of Object.entries(companyOnlyRaw)) {
        const valStr = String(v || '').trim();
        if (/^(?:\+91[\-\s]?)?[6-9]\d{9}$/.test(valStr.replace(/[\s\-\(\)]/g, ''))) {
          mapped.phone = valStr;
          break;
        }
      }
    }
    if (!mapped.email) {
      for (const [k, v] of Object.entries(companyOnlyRaw)) {
        const valStr = String(v || '').trim();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valStr)) {
          mapped.email = valStr;
          break;
        }
      }
    }

    const businessName = mapped.business_name || mapped.name || mapped.company_name || '';
    const state = mapped.state || '';
    const city = mapped.city || '';
    const gstin = (mapped.gstin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cin = (mapped.cin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pan = (mapped.pan || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const phone = (mapped.phone || '').replace(/[^0-9+]/g, '');
    const email = mapped.email || '';
    const pincode = (mapped.pincode || '').replace(/[^0-9]/g, '');

    const issues: string[] = [];
    let isInvalid = false;
    let isDuplicate = false;
    let hasWarning = false;

    if (!businessName) {
      issues.push('ERROR: Business name is mandatory');
      errors.push({ rowNumber, field: 'name', message: 'Business name is mandatory' });
      isInvalid = true;
    }
    if (!state) {
      issues.push('ERROR: State is mandatory for Indian commercial directory');
      errors.push({ rowNumber, field: 'state', message: 'State is mandatory' });
      isInvalid = true;
    }
    if (!city) {
      issues.push('WARNING: City is missing or ambiguous');
      hasWarning = true;
    }

    // GSTIN Validation
    if (gstin) {
      const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
      if (!gstinRegex.test(gstin)) {
        issues.push(`WARNING: GSTIN '${gstin}' does not match standard 15-character statutory format`);
        hasWarning = true;
      }
      if (seenGstins.has(gstin)) {
        const prevRow = seenGstins.get(gstin);
        issues.push(`Duplicate GSTIN '${gstin}' matches row #${prevRow}`);
        duplicates.push({ rowNumber, reason: `Duplicate GSTIN '${gstin}' matches row #${prevRow}` });
        isDuplicate = true;
      } else {
        seenGstins.set(gstin, rowNumber);
      }
    }

    // CIN Validation
    if (cin) {
      const cinRegex = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
      if (!cinRegex.test(cin)) {
        issues.push(`WARNING: CIN '${cin}' does not match MCA 21-character statutory format`);
        hasWarning = true;
      }
      if (seenCins.has(cin)) {
        const prevRow = seenCins.get(cin);
        issues.push(`Duplicate CIN '${cin}' matches row #${prevRow}`);
        duplicates.push({ rowNumber, reason: `Duplicate CIN '${cin}' matches row #${prevRow}` });
        isDuplicate = true;
      } else {
        seenCins.set(cin, rowNumber);
      }
    }

    // Name + City Intra-file duplicate check
    if (businessName && city) {
      const key = `${businessName.toLowerCase()}|${city.toLowerCase()}`;
      if (seenNameCity.has(key)) {
        const prevRow = seenNameCity.get(key);
        issues.push(`Duplicate company name & location matches row #${prevRow}`);
        if (!isDuplicate) {
          duplicates.push({ rowNumber, reason: `Duplicate company name & location matches row #${prevRow}` });
          isDuplicate = true;
        }
      } else {
        seenNameCity.set(key, rowNumber);
      }
    }

    let status: 'VALID' | 'INVALID' | 'DUPLICATE' | 'WARNING' = 'VALID';
    if (isInvalid) {
      status = 'INVALID';
      invalidCount++;
    } else if (isDuplicate) {
      status = 'DUPLICATE';
      duplicateCount++;
    } else if (hasWarning) {
      status = 'WARNING';
      warningCount++;
      validCount++;
    } else {
      status = 'VALID';
      validCount++;
    }

    previewRecords.push({
      rowNumber,
      status,
      businessName: businessName || 'Unnamed Entity',
      city: city || 'Unspecified',
      state: state || 'Unspecified',
      gstin: gstin || undefined,
      phone: phone || undefined,
      email: email || undefined,
      issues,
      raw,
      normalized: {
        name: businessName,
        legalName: mapped.legal_name || businessName,
        locations: [{ addressLine1: mapped.address_line1 || mapped.address || '', city, state, pincode, country: 'India' }],
        contacts: [{ phone, email }],
        digitalPresences: mapped.website ? [{ platform: 'WEBSITE', url: mapped.website }] : [],
        identifiers: [
          ...(gstin ? [{ type: 'GSTIN', value: gstin, normalizedValue: gstin }] : []),
          ...(cin ? [{ type: 'CIN', value: cin, normalizedValue: cin }] : []),
          ...(pan ? [{ type: 'PAN', value: pan, normalizedValue: pan }] : []),
        ],
      },
    });
  }

  return NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Success',
    data: {
      total: rows.length,
      validCount,
      invalidCount,
      duplicateCount,
      warningCount,
      previewRecords,
      duplicates,
      errors,
      peopleColumns: peopleFallbackReport(rows),
      detectedHeaders: rawHeaders,
      fieldMappings: detectedFieldMappings,
    },
    timestamp: new Date().toISOString(),
  });
}

let serverFilterOptionsStore: any = null;

async function handleGetFilterOptions(): Promise<NextResponse> {
  const config = serverFilterOptionsStore || DEFAULT_FILTER_CONFIG;
  return NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Filter options governance configuration retrieved',
    data: config,
    timestamp: new Date().toISOString(),
  });
}

async function handleUpdateFilterOptions(req: NextRequest): Promise<NextResponse> {
  let body: any = {};
  try {
    body = await readJson(req);
  } catch {
    return NextResponse.json({ success: false, statusCode: 400, message: 'Invalid JSON body' }, { status: 400 });
  }

  if (body && Array.isArray(body.categories)) {
    serverFilterOptionsStore = {
      categories: body.categories,
      lastUpdated: new Date().toISOString(),
    };
  }

  return NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Filter options governance configuration updated successfully',
    data: serverFilterOptionsStore || DEFAULT_FILTER_CONFIG,
    timestamp: new Date().toISOString(),
  });
}

function normalizeBusinessStatus(statusStr?: string): string {
  if (!statusStr) return 'DRAFT';
  const s = String(statusStr).toUpperCase().trim();
  if (s === 'DRAFT') return 'DRAFT';
  if (s === 'VALIDATED' || s === 'VALIDATION' || s === 'PENDING' || s === 'PENDING_VALIDATION' || s === 'DUPLICATE_REVIEW') return 'PENDING_VALIDATION';
  if (s === 'VERIFIED' || s === 'APPROVED' || s === 'PUBLISH_QUEUE') return 'VERIFIED';
  if (s === 'PUBLISHED' || s === 'ACTIVE') return 'PUBLISHED';
  if (s === 'ARCHIVED') return 'ARCHIVED';
  if (s === 'REJECTED') return 'REJECTED';
  return 'DRAFT';
}

/**
 * Import submit is owned by the NestJS import pipeline (records, validation, normalization, duplicate detection, publishing, People
 * stage, batch and People summaries, audit). The gateway only forwards it; it never keeps a second implementation, and it never
 * falls back to one: when the API is unreachable the upload fails visibly instead of leaving a half-written batch.
 */
async function forwardImportSubmit(req: NextRequest): Promise<NextResponse> {
  let body: any;
  try {
    body = await readJson(req);
  } catch {
    return NextResponse.json({ success: false, statusCode: 400, message: 'Invalid JSON body' }, { status: 400 });
  }
  if (!Array.isArray(body?.rows) || body.rows.length === 0) {
    return NextResponse.json({ success: false, statusCode: 400, message: 'Cannot submit empty import batch' }, { status: 400 });
  }
  // The UI sends batchName / customMapping; the API contract is filename / mapping.
  const payload = {
    filename: body.filename || body.batchName,
    rows: body.rows,
    mapping: body.mapping || body.customMapping || undefined,
    autoPublish: body.autoPublish,
  };
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  const auth = req.headers.get('authorization');
  if (auth) headers.set('authorization', auth);
  for (const h of ['x-forwarded-for', 'user-agent', 'x-request-id']) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const platformIp = trustedForwardedFor(req.headers);
  if (platformIp) headers.set('x-forwarded-for', platformIp);
  let upstream: Response;
  try {
    upstream = await fetch(`${getBackendUrl()}/admin/import/submit`, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (err) {
    const target = describeBackendTarget();
    console.error(
      `[Admin Import] API unreachable (${(err as Error)?.message}; target ${target.host}, set by ${target.source}).` +
        (target.misconfigured ? ' This deployment has no API address: set BACKEND_API_URL, or deploy with the services config in vercel.json so ORION_API_URL is injected.' : ''),
    );
    return NextResponse.json(
      { success: false, statusCode: 503, errorCode: 'BACKEND_UNAVAILABLE', message: 'The import service is unavailable. Nothing was imported; please try again.', timestamp: new Date().toISOString() },
      { status: 503 },
    );
  }
  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
  });
}

function getBackendUrl(): string {
  return backendBaseUrl();
}

/** S-19: the verified admin acting on a request, for the audit trail (null if the token is not a persisted user id). */
function gatewayActorId(req: NextRequest): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '');
  const payload = m ? verifyToken(m[1], gwAccessSecret(), 'access') : null;
  const sub = payload?.sub;
  return typeof sub === 'string' && isUuidSub(sub) ? sub : null;
}

/**
 * S-19: records a privileged action in audit_logs. Never throws (a logging failure must not fail the
 * operation), but any failure is surfaced in the server log.
 */
async function recordGatewayAudit(
  req: NextRequest,
  action: string,
  entityType: string,
  details: Record<string, unknown> = {},
  actorId?: string | null,
): Promise<void> {
  try {
    await queryDb(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values, ip_address, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())`,
      [
        actorId ?? gatewayActorId(req),
        action,
        entityType,
        (details as any).entityId ?? null,
        JSON.stringify(details),
        clientIpOf(req),
        req.headers.get('user-agent') || null,
      ],
    );
  } catch (err) {
    console.error('[Gateway Audit] failed to record', action, (err as any)?.message);
  }
}

/** S-24: a generic 500 that logs the real error server-side and returns only a correlation id to the client. */
function serverError(context: string, err: unknown): NextResponse {
  const requestId = crypto.randomUUID();
  console.error(`[Gateway 500] ${context} (ref ${requestId}):`, (err as any)?.message || err);
  return NextResponse.json(
    {
      success: false,
      statusCode: 500,
      errorCode: 'INTERNAL_ERROR',
      message: 'The request could not be completed. Please try again.',
      requestId,
      timestamp: new Date().toISOString(),
    },
    { status: 500 },
  );
}

async function getOrSyncUserWallet(userIdentifier?: string) {
  const todayStr = new Date().toISOString().slice(0, 10);
  try {
    let userRow: any = null;
    const identifier = (userIdentifier || '').trim();

    if (identifier) {
      if (identifier.includes('@')) {
        const rows = await queryDb(`SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [identifier]);
        userRow = rows[0];
      } else {
        const rows = await queryDb(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [identifier]);
        userRow = rows[0];
      }
    }

    // If user not found yet, but we have an email identifier
    if (!userRow && identifier && identifier.includes('@')) {
      const insertUser = await queryDb(
        `INSERT INTO users (email, first_name, last_name, role, status)
         VALUES (LOWER($1), $2, '', 'USER', 'ACTIVE')
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING *`,
        [identifier, identifier.split('@')[0]]
      );
      userRow = insertUser[0];
    }

    // If user not found by ID or email and no email identifier provided, do not pick a random user
    if (!userRow) {
      return {
        dailyCredits: 5,
        purchasedCredits: 0,
        balance: 5,
        lifetimePurchased: 0,
        lifetimeUsed: 0,
        lastDailyCreditDate: todayStr,
        userId: null,
        walletId: null,
        user: null,
      };
    }

    const userId = userRow.id;

    // Fetch user wallet
    const walletRows = await queryDb(`SELECT * FROM user_wallets WHERE user_id = $1 LIMIT 1`, [userId]);
    let wallet = walletRows[0];

    if (!wallet) {
      const created = await queryDb(
        `INSERT INTO user_wallets (user_id, daily_credits, purchased_credits, balance, last_daily_credit_date, lifetime_purchased, lifetime_used)
         VALUES ($1, 5, 0, 5, $2, 0, 0)
         RETURNING *`,
        [userId, todayStr]
      );
      wallet = created[0];

      if (wallet) {
        await queryDb(
          `INSERT INTO credit_transactions (wallet_id, user_id, amount, balance_after, balance_type, daily_balance_after, purchased_balance_after, type, description)
           VALUES ($1, $2, 5, 5, 'DAILY', 5, 0, 'DAILY_ALLOCATION', 'Welcome daily free credits')`,
          [wallet.id, userId]
        );
      }
    } else {
      // Check daily rollover if last_daily_credit_date !== todayStr
      if (wallet.last_daily_credit_date !== todayStr) {
        const newDaily = 5;
        const newPurchased = wallet.purchased_credits || 0;
        const newBalance = newDaily + newPurchased;

        const updated = await queryDb(
          `UPDATE user_wallets
           SET daily_credits = $1, balance = $2, last_daily_credit_date = $3, updated_at = NOW()
           WHERE id = $4
           RETURNING *`,
          [newDaily, newBalance, todayStr, wallet.id]
        );
        if (updated[0]) {
          wallet = updated[0];
          await queryDb(
            `INSERT INTO credit_transactions (wallet_id, user_id, amount, balance_after, balance_type, daily_balance_after, purchased_balance_after, type, description)
             VALUES ($1, $2, $3, $4, 'DAILY', $5, $6, 'DAILY_ALLOCATION', 'Daily allocation of free credits')`,
            [wallet.id, userId, newDaily, newBalance, newDaily, newPurchased]
          );
        }
      }
    }

    const daily = wallet.daily_credits ?? 5;
    const purchased = wallet.purchased_credits ?? 0;
    const balance = wallet.balance ?? (daily + purchased);

    return {
      dailyCredits: daily,
      purchasedCredits: purchased,
      balance: balance,
      lifetimePurchased: wallet.lifetime_purchased ?? 0,
      lifetimeUsed: wallet.lifetime_used ?? 0,
      lastDailyCreditDate: wallet.last_daily_credit_date || todayStr,
      userId: userId,
      walletId: wallet.id,
      user: userRow,
    };
  } catch (err) {
    console.error('[Gateway] Failed to getOrSyncUserWallet:', err);
    return {
      dailyCredits: 5,
      purchasedCredits: 0,
      balance: 5,
      lifetimePurchased: 0,
      lifetimeUsed: 0,
      lastDailyCreditDate: todayStr,
      userId: null,
      walletId: null,
    };
  }
}

/** Admin routes: the token's role claim is not enough, the persisted account must still be an ACTIVE ADMIN / SUPER_ADMIN. */
async function requirePersistedAdmin(policy: string, auth: { sub: string } | null): Promise<NextResponse | null> {
  if (policy !== 'ADMIN') return null;
  const account = auth && isUuidSub(auth.sub) ? await findAdminAccount({ id: auth.sub }) : null;
  if (account) return null;
  return NextResponse.json(
    { success: false, statusCode: 403, errorCode: 'FORBIDDEN', message: 'You do not have permission to do this.', timestamp: new Date().toISOString() },
    { status: 403 },
  );
}

const isUuidSub = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Gateway access-token lifetime. Reduced from 24h: a leaked access token is now also revocable through the
// active-session check below, but a shorter window further limits exposure (S-05).
const ACCESS_TOKEN_TTL_SEC = 2 * 3600;
const REFRESH_TOKEN_TTL_SEC = 7 * 24 * 3600;

/**
 * S-05 / S-06 / S-08: every logout, password reset and password change rotates the account's single active
 * session id (and records when the password last changed). Because every authenticated native route verifies
 * the caller's token still carries the current session id (assertSessionCurrent), rotating it immediately
 * invalidates every previously issued access AND refresh token for that account — the gateway's stateless
 * tokens become revocable without any schema change, using the existing users.metadata.activeSessionId field.
 */
async function rotateActiveSession(userId: string, opts: { passwordChanged?: boolean } = {}): Promise<string> {
  const newSessionId = crypto.randomUUID();
  try {
    const rows = await queryDb(`SELECT metadata FROM users WHERE id = $1 LIMIT 1`, [userId]);
    const meta = (rows[0]?.metadata && typeof rows[0].metadata === 'object') ? rows[0].metadata : {};
    const updated: Record<string, any> = { ...meta, activeSessionId: newSessionId };
    if (opts.passwordChanged) updated.passwordChangedAt = Date.now();
    await queryDb(`UPDATE users SET metadata = $1::jsonb, updated_at = NOW() WHERE id = $2`, [JSON.stringify(updated), userId]);
  } catch (err) {
    console.error('[Gateway] rotateActiveSession failed:', (err as any)?.message);
  }
  return newSessionId;
}

const sessionErr = (status: 401 | 403, errorCode: string, message: string, code?: string) =>
  NextResponse.json({ success: false, statusCode: status, errorCode, code, message, timestamp: new Date().toISOString() }, { status });

/**
 * Enforces, for an authenticated native route, that the account is still ACTIVE and that the token carries the
 * current active session id. Returns a response to short-circuit with, or null to proceed. Admin OTP tokens
 * (no sessionId) get the status check only; their role is enforced separately by requirePersistedAdmin.
 */
async function assertSessionCurrent(auth: IAuthContext | null): Promise<NextResponse | null> {
  if (!auth || !isUuidSub(auth.sub)) return null;
  let u: any;
  try {
    const rows = await queryDb(`SELECT status, metadata FROM users WHERE id = $1 LIMIT 1`, [auth.sub]);
    u = rows[0];
  } catch {
    return sessionErr(401, 'UNAUTHORIZED', 'A valid session is required.');
  }
  if (!u) return sessionErr(401, 'UNAUTHORIZED', 'A valid session is required.');
  if (u.status === 'SUSPENDED' || u.status === 'INACTIVE') {
    return sessionErr(403, 'ACCOUNT_INACTIVE', 'Your account has been deactivated. Please contact support.');
  }
  const tokenSid = auth.payload?.sessionId;
  const activeSid = (u.metadata as any)?.activeSessionId;
  if (tokenSid && activeSid && tokenSid !== activeSid) {
    return sessionErr(401, 'UNAUTHORIZED', 'Your account has been logged in on another device. Please log in again.', 'SESSION_SUPERSEDED');
  }
  return null;
}

async function handleLogin(req: NextRequest): Promise<NextResponse> {
  const body = await readJson(req).catch(() => ({}));
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '').trim();

  if (!email || !password) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Email and password are required.' },
      { status: 400 }
    );
  }

  // S-09: throttle credential stuffing per source IP and per targeted account.
  if (gatewayRateLimited(`login:ip:${clientIpOf(req)}`, 30, 5 * 60000) || gatewayRateLimited(`login:acct:${email}`, 10, 5 * 60000)) {
    return tooManyRequests('Too many login attempts. Please wait a few minutes and try again.');
  }

  let dbUser: any = null;
  try {
    const rows = await queryDb(
      `SELECT id, email, password_hash, first_name, last_name, display_name, role, status, organization_name, phone_number, avatar_url, metadata, two_factor_enabled FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    if (rows && rows.length > 0) {
      dbUser = rows[0];
    }
  } catch (err: any) {
    console.error('[Gateway] DB error looking up user for login:', err);
  }

  if (!dbUser || !dbUser.password_hash) {
    await burnPasswordCheck(password); // same cost as a wrong password: no timing hint that the account does not exist
    return NextResponse.json(
      { success: false, statusCode: 401, message: 'Invalid email or password.' },
      { status: 401 }
    );
  }

  const isPasswordValid = await verifyPassword(password, dbUser.password_hash);
  if (!isPasswordValid) {
    return NextResponse.json(
      { success: false, statusCode: 401, message: 'Invalid email or password.' },
      { status: 401 }
    );
  }

  // This native login has no second step. An account with MFA enabled must complete the API's TOTP challenge, so when the API is
  // unavailable these accounts are refused here rather than signed in with the password alone (fail closed).
  if (dbUser.two_factor_enabled === true) {
    return NextResponse.json(
      { success: false, statusCode: 503, message: 'Sign-in with two-factor authentication is temporarily unavailable. Please try again shortly.' },
      { status: 503 }
    );
  }

  // Transparent upgrade: a correct password verified against a legacy / weaker hash is re-hashed with the current parameters.
  if (needsRehash(dbUser.password_hash)) {
    try {
      await queryDb(`UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3`, [await hashPassword(password), dbUser.id, dbUser.password_hash]);
    } catch (err: any) {
      console.error('[Gateway] password hash upgrade failed:', err?.message);
    }
  }

  if (dbUser.status === 'SUSPENDED' || dbUser.status === 'INACTIVE') {
    return NextResponse.json(
      { success: false, statusCode: 403, message: 'Your account has been deactivated. Please contact support.' },
      { status: 403 }
    );
  }

  // Single-Device Login Enforcement: assign a unique sessionId
  const sessionId = crypto.randomUUID();
  const meta = typeof dbUser.metadata === 'object' && dbUser.metadata ? dbUser.metadata : {};
  const updatedMeta = { ...meta, activeSessionId: sessionId };

  try {
    await queryDb(
      `UPDATE users SET metadata = $1::jsonb, last_login_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(updatedMeta), dbUser.id]
    );
  } catch (err) {
    console.error('[Gateway] Failed to update active session ID in user metadata:', err);
  }

  const accessSecret = gwAccessSecret();
  const refreshSecret = gwRefreshSecret();
  if (!accessSecret || !refreshSecret) return authNotConfigured();

  const firstName = dbUser.first_name || '';
  const lastName = dbUser.last_name || '';
  const fullName = dbUser.display_name || (firstName ? `${firstName} ${lastName}`.trim() : email.split('@')[0]);

  const userPayload = {
    sub: dbUser.id,
    email: dbUser.email,
    firstName,
    lastName,
    name: fullName,
    displayName: fullName,
    avatarUrl: dbUser.avatar_url || null,
    role: dbUser.role || 'USER',
    status: dbUser.status || 'ACTIVE',
    organizationId: dbUser.organization_name || null,
    provider: 'EMAIL',
    sessionId,
  };

  const accessToken = signJwt(userPayload, accessSecret, ACCESS_TOKEN_TTL_SEC);
  const refreshToken = signJwt({ sub: dbUser.id, email: dbUser.email, type: 'refresh', sessionId }, refreshSecret, REFRESH_TOKEN_TTL_SEC);

  const walletData = await getOrSyncUserWallet(dbUser.id);

  const responseData = {
    accessToken,
    refreshToken,
    tokens: {
      accessToken,
      refreshToken,
    },
    user: {
      id: dbUser.id,
      email: dbUser.email,
      firstName,
      lastName,
      name: fullName,
      displayName: fullName,
      avatarUrl: dbUser.avatar_url || null,
      role: dbUser.role || 'USER',
      status: dbUser.status || 'ACTIVE',
      organizationName: dbUser.organization_name || null,
      companyName: dbUser.organization_name || null,
      phone: dbUser.phone_number || null,
      phoneNumber: dbUser.phone_number || null,
      isEmailVerified: true,
      provider: 'EMAIL',
      googleLinked: false,
      microsoftLinked: false,
      hasPassword: true,
      wallet: {
        dailyCredits: walletData.dailyCredits,
        purchasedCredits: walletData.purchasedCredits,
        balance: walletData.balance,
        lifetimePurchased: walletData.lifetimePurchased,
        lifetimeUsed: walletData.lifetimeUsed,
        lastDailyCreditDate: walletData.lastDailyCreditDate,
      },
      metadata: updatedMeta,
    },
  };

  const res = NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'User authenticated successfully',
    data: responseData,
    timestamp: new Date().toISOString(),
  });

  const isLocal = isLocalRequestHost(req.headers.get('host'));
  // S-11: HttpOnly + Secure so the cookie copy of the session token is not readable by page scripts.
  res.cookies.set('orion_access_token', accessToken, {
    path: '/',
    httpOnly: true,
    secure: !isLocal,
    sameSite: 'lax',
    maxAge: ACCESS_TOKEN_TTL_SEC,
  });

  return res;
}

/** Sign-up e-mail verification (the same rules and table as the NestJS API; see lib/email-otp.ts). */
async function handleSendOtp(req: NextRequest): Promise<NextResponse> {
  const body = await readJson(req).catch(() => null);
  if (body === null) return NextResponse.json({ success: false, statusCode: 400, message: 'Invalid JSON body' }, { status: 400 });
  const ip = clientIpOf(req);
  if (gatewayRateLimited(`otp-send:ip:${ip}`, 12, 10 * 60000)) return tooManyRequests('Too many verification requests. Please wait a few minutes and try again.');
  const pool = getDbPool();
  if (!pool) return NextResponse.json({ success: false, statusCode: 503, errorCode: 'SERVICE_UNAVAILABLE', message: 'Verification is temporarily unavailable.' }, { status: 503 });
  const result = await sendEmailOtp(poolAdapter(pool as any), {
    email: body?.email,
    purpose: body?.purpose,
    ip,
    accountExists: async (email) => ((await queryDb(`SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email])) || []).length > 0,
    mailer: sendSignupOtpEmail,
    existingAccountMailer: (to) => sendExistingAccountEmail(to, process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim() || req.nextUrl.origin),
  });
  return NextResponse.json(result.body, { status: result.status });
}

async function handleVerifyOtp(req: NextRequest): Promise<NextResponse> {
  const body = await readJson(req).catch(() => null);
  if (body === null) return NextResponse.json({ success: false, statusCode: 400, message: 'Invalid JSON body' }, { status: 400 });
  if (gatewayRateLimited(`otp-verify:ip:${clientIpOf(req)}`, 30, 10 * 60000)) return tooManyRequests('Too many attempts. Please wait a few minutes and try again.');
  const pool = getDbPool();
  if (!pool) return NextResponse.json({ success: false, statusCode: 503, errorCode: 'SERVICE_UNAVAILABLE', message: 'Verification is temporarily unavailable.' }, { status: 503 });
  const result = await verifyEmailOtp(poolAdapter(pool as any), { email: body?.email, otp: body?.otp, purpose: body?.purpose });
  return NextResponse.json(result.body, { status: result.status });
}

async function handleRegister(req: NextRequest): Promise<NextResponse> {
  const body = await readJson(req).catch(() => ({}));
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '').trim();
  const fullNameText = typeof body?.name === 'string' ? body.name : '';
  const firstName = String(body?.firstName || fullNameText.split(' ')[0] || '').trim();
  const lastName = String(body?.lastName || fullNameText.split(' ').slice(1).join(' ') || '').trim();
  const companyName = String(body?.companyName || body?.organizationName || '').trim();
  const phone = String(body?.phone || body?.phoneNumber || '').trim();

  if (!email || !password) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Email and password are required for registration.' },
      { status: 400 }
    );
  }

  // S-09: throttle automated sign-up abuse per source IP.
  if (gatewayRateLimited(`register:ip:${clientIpOf(req)}`, 10, 10 * 60000)) {
    return tooManyRequests('Too many sign-up attempts. Please wait a few minutes and try again.');
  }

  // S-16: reject malformed emails and trivially weak passwords at the edge (the NestJS ValidationPipe never
  // runs for gateway-native routes).
  if (!isValidEmail(email)) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Please enter a valid email address.' },
      { status: 400 }
    );
  }
  // New accounts need the one-time proof from /auth/verify-otp (always in production). Checked before any other work is spent.
  const otpRequired = registrationOtpRequired();
  const proof = otpRequired ? parseProof(body?.verificationToken) : null;
  if (otpRequired && !proof) {
    return NextResponse.json(
      { success: false, statusCode: 403, errorCode: 'EMAIL_OTP_REQUIRED', message: 'Please verify your email address with the code we send you before creating an account.' },
      { status: 403 }
    );
  }
  const pwComplaint = passwordComplaint(password);
  if (pwComplaint) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: pwComplaint },
      { status: 400 }
    );
  }

  try {
    const existing = await queryDb(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [email]);
    if (existing && existing.length > 0) {
      return NextResponse.json(
        { success: false, statusCode: 400, message: 'An account with this email address already exists. Please sign in.' },
        { status: 400 }
      );
    }
  } catch (err: any) {
    console.error('[Gateway] DB error checking existing user on registration:', err);
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const fullName = `${firstName} ${lastName}`.trim() || email.split('@')[0];
  const sessionId = crypto.randomUUID();
  const metadata = { activeSessionId: sessionId };

  try {
    if (otpRequired && proof) {
      // One statement: the proof is spent and the account inserted together. A proof that is not live and unspent for exactly this address
      // inserts nothing; a failed insert (for example a duplicate address) leaves the proof unspent. Fails closed when there is no database.
      const created = await queryDbStrict(REGISTER_WITH_PROOF_SQL, [userId, email, passwordHash, firstName || null, lastName || null, fullName, companyName || null, phone || null, JSON.stringify(metadata), proof.id, proof.hash]);
      if (!created || created.length === 0) {
        return NextResponse.json(
          { success: false, statusCode: 403, errorCode: 'EMAIL_OTP_REQUIRED', message: 'Please verify your email address with the code we send you before creating an account.' },
          { status: 403 }
        );
      }
    } else {
    await queryDbStrict(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, display_name, organization_name, phone_number, role, status, provider, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'USER', 'ACTIVE', 'EMAIL', $9::jsonb, NOW(), NOW())`,
      [userId, email, passwordHash, firstName || null, lastName || null, fullName, companyName || null, phone || null, JSON.stringify(metadata)]
    );
    }
  } catch (err: any) {
    console.error('[Gateway] DB error inserting new user:', (err as { code?: string })?.code);
    return writeFailure(err);
  }

  const walletData = await getOrSyncUserWallet(userId);

  const accessSecret = gwAccessSecret();
  const refreshSecret = gwRefreshSecret();
  if (!accessSecret || !refreshSecret) return authNotConfigured();

  const userPayload = {
    sub: userId,
    email,
    firstName,
    lastName,
    name: fullName,
    displayName: fullName,
    role: 'USER',
    status: 'ACTIVE',
    organizationId: companyName || null,
    provider: 'EMAIL',
    sessionId,
  };

  const accessToken = signJwt(userPayload, accessSecret, ACCESS_TOKEN_TTL_SEC);
  const refreshToken = signJwt({ sub: userId, email, type: 'refresh', sessionId }, refreshSecret, REFRESH_TOKEN_TTL_SEC);

  const res = NextResponse.json(
    {
      success: true,
      statusCode: 201,
      message: 'User registered successfully',
      data: {
        accessToken,
        refreshToken,
        tokens: {
          accessToken,
          refreshToken,
        },
        user: {
          id: userId,
          email,
          firstName,
          lastName,
          name: fullName,
          displayName: fullName,
          avatarUrl: null,
          role: 'USER',
          status: 'ACTIVE',
          organizationName: companyName || null,
          companyName: companyName || null,
          phone: phone || null,
          phoneNumber: phone || null,
          isEmailVerified: true,
          provider: 'EMAIL',
          googleLinked: false,
          microsoftLinked: false,
          hasPassword: true,
          wallet: {
            dailyCredits: walletData.dailyCredits,
            purchasedCredits: walletData.purchasedCredits,
            balance: walletData.balance,
            lifetimePurchased: walletData.lifetimePurchased,
            lifetimeUsed: walletData.lifetimeUsed,
            lastDailyCreditDate: walletData.lastDailyCreditDate,
          },
          metadata,
        },
      },
      timestamp: new Date().toISOString(),
    },
    { status: 201 }
  );

  const isLocal = isLocalRequestHost(req.headers.get('host'));
  // S-11: HttpOnly + Secure so the cookie copy of the session token is not readable by page scripts.
  res.cookies.set('orion_access_token', accessToken, {
    path: '/',
    httpOnly: true,
    secure: !isLocal,
    sameSite: 'lax',
    maxAge: ACCESS_TOKEN_TTL_SEC,
  });

  return res;
}

async function handleRefresh(req: NextRequest): Promise<NextResponse> {
  const body = await readJson(req).catch(() => ({}));
  const refreshToken = String(body?.refreshToken || '').trim();

  if (!refreshToken) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Refresh token is required.' },
      { status: 400 }
    );
  }

  const refreshSecret = gwRefreshSecret();
  const accessSecret = gwAccessSecret();
  if (!refreshSecret || !accessSecret) return authNotConfigured();
  const tokenData = verifyToken(refreshToken, refreshSecret, 'refresh');

  if (!tokenData || !tokenData.sub) {
    return NextResponse.json(
      { success: false, statusCode: 401, message: 'Invalid refresh token.' },
      { status: 401 }
    );
  }

  const walletData = await getOrSyncUserWallet(tokenData.sub);
  const dbUser = walletData.user;

  // S-05 / S-08: the refresh token is honoured only while it still carries the account's current active session
  // id and the account is active. After a logout, password change or a login elsewhere (all of which rotate the
  // session id), a previously issued refresh token is rejected here instead of silently minting fresh tokens.
  if (dbUser && (dbUser.status === 'SUSPENDED' || dbUser.status === 'INACTIVE')) {
    return NextResponse.json(
      { success: false, statusCode: 403, errorCode: 'ACCOUNT_INACTIVE', message: 'Your account has been deactivated. Please contact support.' },
      { status: 403 }
    );
  }
  const activeSessionId = (dbUser?.metadata as any)?.activeSessionId;
  if (activeSessionId && tokenData.sessionId && tokenData.sessionId !== activeSessionId) {
    return NextResponse.json(
      { success: false, statusCode: 401, code: 'SESSION_SUPERSEDED', message: 'This session is no longer valid. Please log in again.' },
      { status: 401 }
    );
  }

  const sessionId = tokenData.sessionId || activeSessionId || crypto.randomUUID();
  const firstName = dbUser?.first_name || '';
  const lastName = dbUser?.last_name || '';
  const fullName = dbUser?.display_name || (firstName ? `${firstName} ${lastName}`.trim() : tokenData.email?.split('@')[0] || 'User');

  const userPayload = {
    sub: tokenData.sub,
    email: tokenData.email || dbUser?.email,
    firstName,
    lastName,
    name: fullName,
    displayName: fullName,
    role: dbUser?.role || 'USER',
    status: dbUser?.status || 'ACTIVE',
    provider: dbUser?.provider || 'EMAIL',
    sessionId,
  };

  const newAccessToken = signJwt(userPayload, accessSecret, ACCESS_TOKEN_TTL_SEC);
  const newRefreshToken = signJwt({ sub: tokenData.sub, email: tokenData.email, type: 'refresh', sessionId }, refreshSecret, REFRESH_TOKEN_TTL_SEC);

  return NextResponse.json({
    success: true,
    statusCode: 200,
    data: {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    },
    timestamp: new Date().toISOString(),
  });
}

async function handleForgotPassword(req: NextRequest): Promise<NextResponse> {
  const body = await readJson(req).catch(() => ({}));
  const email = String(body?.email || '').trim().toLowerCase();
  if (!email) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Please enter a valid email address.' },
      { status: 400 }
    );
  }

  const jwtSecret = gwResetSecret();
  if (!jwtSecret) return authNotConfigured();

  // S-09: throttle reset-email flooding, per source IP and per targeted address.
  if (gatewayRateLimited(`forgot:ip:${clientIpOf(req)}`, 10, 10 * 60000) || gatewayRateLimited(`forgot:acct:${email}`, 5, 10 * 60000)) {
    return tooManyRequests('Too many password reset requests. Please wait a few minutes and try again.');
  }

  // S-14: one generic response whether or not the address is registered, so this endpoint cannot be used
  // to enumerate accounts. An email is dispatched only when a matching account exists.
  const genericOk = NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'If an account exists for this address, a password reset link has been sent.',
  });

  let user: any = null;
  try {
    const rows = await queryDb(
      `SELECT id, email, first_name, last_name, metadata FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    if (rows && rows.length > 0) {
      user = rows[0];
    }
  } catch (err: any) {
    console.error('[Gateway] DB error looking up user for forgot password:', err);
  }

  if (!user) {
    return genericOk;
  }

  // S-06: bind the token to the password's current state. A successful reset bumps passwordChangedAt, so the
  // same token (carrying the old value) can never be replayed. A short jti aids log correlation.
  const pwc = Number((user.metadata as any)?.passwordChangedAt) || 0;
  const resetToken = signJwt(
    { sub: user.id, email: user.email, type: 'password_reset', pwc, jti: crypto.randomBytes(8).toString('hex') },
    jwtSecret,
    900,
  );

  // S-02: the reset-link host comes ONLY from server configuration, never from a request header.
  const origin = appBaseUrl(req);
  const resetUrl = `${origin}/reset-password?token=${encodeURIComponent(resetToken)}`;
  const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email.split('@')[0];

  await sendPasswordResetEmail({
    email: user.email,
    name: userName,
    resetUrl,
    expiresInMinutes: 15,
  }).catch((e) => console.error('[Gateway] reset email dispatch error:', (e as any)?.message));

  return genericOk;
}

async function handleResetPassword(req: NextRequest): Promise<NextResponse> {
  const body = await readJson(req).catch(() => ({}));
  const token = String(body?.token || '').trim();
  const newPassword = String(body?.newPassword || body?.password || '').trim();

  if (!token || !newPassword) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Password reset token and new password are required.' },
      { status: 400 }
    );
  }

  if (newPassword.length < 8) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Password must be at least 8 characters long.' },
      { status: 400 }
    );
  }

  const resetKey = gwResetSecret();
  if (!resetKey) return authNotConfigured();
  const tokenData = verifyToken(token, resetKey, 'password_reset');

  if (!tokenData || !isUuid(tokenData.sub)) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Invalid or expired password reset link. Please request a new one.' },
      { status: 400 }
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (tokenData.exp && tokenData.exp < nowSec) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Password reset link has expired. Please request a new link.' },
      { status: 400 }
    );
  }

  const userId = tokenData.sub;

  // Identity for a reset is always the token's verified subject (a UUID), never a free-form email.
  if (!isUuid(userId)) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Invalid or expired password reset link. Please request a new one.' },
      { status: 400 }
    );
  }

  try {
    // S-06: the token is single-use. It carries the passwordChangedAt value from when it was issued; if the
    // stored value has moved on (because this token, or another, already completed a reset), it is refused.
    const rows = await queryDb(`SELECT metadata FROM users WHERE id = $1 LIMIT 1`, [userId]);
    if (!rows[0]) {
      return NextResponse.json(
        { success: false, statusCode: 400, message: 'Invalid or expired password reset link. Please request a new one.' },
        { status: 400 }
      );
    }
    const currentPwc = Number((rows[0].metadata as any)?.passwordChangedAt) || 0;
    const tokenPwc = Number(tokenData.pwc) || 0;
    if (tokenPwc !== currentPwc) {
      return NextResponse.json(
        { success: false, statusCode: 400, message: 'This password reset link has already been used or has expired. Please request a new one.' },
        { status: 400 }
      );
    }

    const newPasswordHash = await hashPassword(newPassword);
    await queryDbStrict(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [newPasswordHash, userId]);
    // Invalidate the token (passwordChangedAt bumps) and revoke every existing session for this account (S-05).
    await rotateActiveSession(userId, { passwordChanged: true });

    return NextResponse.json({
      success: true,
      statusCode: 200,
      message: 'Password updated successfully! You can now log in with your new password.',
    });
  } catch (err: any) {
    console.error('[Gateway] DB error resetting password:', err);
    return NextResponse.json(
      { success: false, statusCode: 500, message: 'Failed to update password. Please try again.' },
      { status: 500 }
    );
  }
}

async function getUserFromRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  const rawToken = authHeader.replace(/^Bearer\s+/i, '');
  const tokenData = rawToken ? decodeJwtPayload(rawToken) : null;
  const userIdentifier = tokenData?.email || tokenData?.sub || null;

  if (!userIdentifier) {
    return {
      dbUser: null,
      walletData: {
        dailyCredits: 0,
        purchasedCredits: 0,
        balance: 0,
        lifetimePurchased: 0,
        lifetimeUsed: 0,
        lastDailyCreditDate: null,
        userId: null,
        walletId: null,
      },
      tokenData: null,
      userIdentifier: null,
    };
  }

  const walletData = await getOrSyncUserWallet(userIdentifier);
  let dbUser = walletData.user;

  if (!dbUser && tokenData?.email) {
    const rows = await queryDb(`SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [tokenData.email]);
    dbUser = rows[0];
  } else if (!dbUser && tokenData?.sub) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tokenData.sub);
    if (isUuid) {
      const rows = await queryDb(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [tokenData.sub]);
      dbUser = rows[0];
    }
  }

  let isSessionSuperseded = false;
  if (dbUser && tokenData?.sessionId) {
    const dbActiveSessionId = (dbUser.metadata as any)?.activeSessionId;
    if (dbActiveSessionId && tokenData.sessionId !== dbActiveSessionId) {
      isSessionSuperseded = true;
    }
  }

  return { dbUser, walletData, tokenData, userIdentifier, isSessionSuperseded };
}

async function handleGetUserProfile(req: NextRequest): Promise<NextResponse> {
  const { dbUser, walletData, tokenData, isSessionSuperseded } = await getUserFromRequest(req);

  if (isSessionSuperseded) {
    return NextResponse.json(
      {
        success: false,
        statusCode: 401,
        code: 'SESSION_SUPERSEDED',
        message: 'Your account has been logged in on another device. Please log in again.',
      },
      { status: 401 }
    );
  }

  // Identity is the persisted account or the verified token subject, never a placeholder: with neither there is no profile to show.
  const profileId: string | undefined = dbUser?.id || tokenData?.sub || undefined;
  if (!profileId) {
    return NextResponse.json({ success: false, statusCode: 401, message: 'A valid session is required.' }, { status: 401 });
  }
  const email = dbUser?.email || tokenData?.email || '';
  const firstName = dbUser?.first_name || tokenData?.firstName || '';
  const lastName = dbUser?.last_name || tokenData?.lastName || '';
  const fullName = dbUser?.display_name || (firstName ? `${firstName} ${lastName}`.trim() : email.split('@')[0]);

  return NextResponse.json({
    success: true,
    statusCode: 200,
    data: {
      id: profileId,
      email,
      firstName,
      lastName,
      name: fullName,
      displayName: fullName,
      avatarUrl: dbUser?.avatar_url || dbUser?.profile_picture || null,
      role: dbUser?.role || 'USER',
      status: dbUser?.status || 'ACTIVE',
      organizationName: dbUser?.organization_name || null,
      companyName: dbUser?.organization_name || null,
      jobTitle: (dbUser?.metadata as any)?.jobTitle || null,
      phone: dbUser?.phone_number || null,
      phoneNumber: dbUser?.phone_number || null,
      isEmailVerified: dbUser?.is_email_verified ?? true,
      provider: dbUser?.provider || 'EMAIL',
      googleLinked: Boolean(dbUser?.google_id || dbUser?.provider === 'google'),
      microsoftLinked: Boolean(dbUser?.microsoft_id || dbUser?.provider === 'microsoft'),
      hasPassword: Boolean(dbUser?.password_hash && dbUser.password_hash.length > 0),
      wallet: {
        dailyCredits: walletData.dailyCredits,
        purchasedCredits: walletData.purchasedCredits,
        balance: walletData.balance,
        lifetimePurchased: walletData.lifetimePurchased,
        lifetimeUsed: walletData.lifetimeUsed,
        lastDailyCreditDate: walletData.lastDailyCreditDate,
      },
      metadata: dbUser?.metadata || {},
    },
    timestamp: new Date().toISOString(),
  });
}

async function handleGetUserSettings(req: NextRequest): Promise<NextResponse> {
  const { dbUser } = await getUserFromRequest(req);
  const meta = (dbUser?.metadata as any) || {};

  return NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Settings retrieved from database',
    data: {
      company: {
        companyName: dbUser?.organization_name || '',
        phone: dbUser?.phone_number || '',
        jobTitle: meta.jobTitle || '',
      },
      notifications: meta.notifications || {
        emailNewBusinesses: true,
        savedSearchAlerts: true,
        creditLowWarning: true,
        weeklyDigest: false,
        productUpdates: true,
        marketingEmails: false,
      },
      preferences: meta.preferences || {
        resultsPerPage: '25 results',
        defaultView: 'Table View',
        timezone: 'India Standard Time (IST) - New Delhi, Kolkata',
        dateFormat: 'DD/MM/YYYY',
      },
      billing: meta.billing || {
        currency: 'INR',
        plan: 'Professional Plan',
      },
    },
    timestamp: new Date().toISOString(),
  });
}

async function handleUpdateUserProfile(req: NextRequest): Promise<NextResponse> {
  const { dbUser, walletData } = await getUserFromRequest(req);
  const userId = dbUser?.id || walletData.userId;
  const email = dbUser?.email;

  if (!userId && !email) {
    return NextResponse.json({ success: false, statusCode: 401, message: 'Unauthorized' }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await readJson(req);
  } catch {}

  const rawName = String(body.name || body.displayName || '').trim();
  let firstName = body.firstName !== undefined ? String(body.firstName).trim() : undefined;
  let lastName = body.lastName !== undefined ? String(body.lastName).trim() : undefined;

  if (rawName && (firstName === undefined || lastName === undefined)) {
    const parts = rawName.split(' ');
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  const displayName = rawName || (firstName ? `${firstName} ${lastName || ''}`.trim() : undefined);
  const organizationName = body.companyName || body.organizationName;
  const phone = body.phone || body.phoneNumber;
  const jobTitle = body.jobTitle;
  const avatarUrl = body.avatarUrl || body.avatar_url;

  const currentMeta = (dbUser?.metadata as any) || {};
  let updatedMeta = { ...currentMeta };
  if (jobTitle !== undefined) {
    updatedMeta.jobTitle = String(jobTitle).trim();
  }

  const rows = await queryDbStrict(
    `UPDATE users
     SET first_name = COALESCE($1, first_name),
         last_name = COALESCE($2, last_name),
         display_name = COALESCE($3, display_name),
         organization_name = COALESCE($4, organization_name),
         phone_number = COALESCE($5, phone_number),
         avatar_url = COALESCE($6, avatar_url),
         profile_picture = COALESCE($6, profile_picture),
         metadata = $7::jsonb,
         updated_at = NOW()
     WHERE id = $8 OR (email IS NOT NULL AND LOWER(email) = LOWER($9))
     RETURNING *`,
    [
      firstName || null,
      lastName !== undefined ? lastName : null,
      displayName || null,
      organizationName || null,
      phone || null,
      avatarUrl || null,
      JSON.stringify(updatedMeta),
      userId || '00000000-0000-0000-0000-000000000000',
      email || '',
    ]
  );

  const updatedUser = rows[0] || dbUser;

  return NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Profile updated successfully in PostgreSQL database',
    data: {
      id: updatedUser.id,
      email: updatedUser.email,
      firstName: updatedUser.first_name,
      lastName: updatedUser.last_name,
      name: updatedUser.display_name || `${updatedUser.first_name || ''} ${updatedUser.last_name || ''}`.trim(),
      displayName: updatedUser.display_name,
      avatarUrl: updatedUser.avatar_url || updatedUser.profile_picture || null,
      organizationName: updatedUser.organization_name,
      companyName: updatedUser.organization_name,
      jobTitle: (updatedUser.metadata as any)?.jobTitle || null,
      phone: updatedUser.phone_number,
      phoneNumber: updatedUser.phone_number,
      metadata: updatedUser.metadata,
    },
    timestamp: new Date().toISOString(),
  });
}

async function handleUploadUserAvatar(req: NextRequest): Promise<NextResponse> {
  const { dbUser, walletData } = await getUserFromRequest(req);
  const userId = dbUser?.id || walletData.userId;
  const email = dbUser?.email;

  if (!userId && !email) {
    return NextResponse.json({ success: false, statusCode: 401, message: 'Unauthorized' }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await readJson(req);
  } catch {}

  const rawImage = body.image || body.avatarUrl || body.avatar_url || body.data;
  // S-16: only a bounded base64 image, or an https URL on one of our own storage/CDN hosts, is accepted.
  // Arbitrary external URLs (tracking pixels) and multi-megabyte blobs are rejected before any DB write.
  const avatarCheck = validateAvatar(rawImage);
  if (!avatarCheck.ok) {
    return NextResponse.json({ success: false, statusCode: 400, message: avatarCheck.error }, { status: 400 });
  }
  const image = avatarCheck.value;

  const rows = await queryDbStrict(
    `UPDATE users
     SET avatar_url = $1,
         profile_picture = $1,
         updated_at = NOW()
     WHERE id = $2 OR (email IS NOT NULL AND LOWER(email) = LOWER($3))
     RETURNING *`,
    [image, userId || '00000000-0000-0000-0000-000000000000', email || '']
  );

  const updatedUser = rows[0] || dbUser;
  const newAvatarUrl = updatedUser?.avatar_url || image;

  return NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Profile photo updated successfully in database',
    data: {
      avatarUrl: newAvatarUrl,
      profilePicture: newAvatarUrl,
      id: updatedUser?.id,
      email: updatedUser?.email,
    },
    timestamp: new Date().toISOString(),
  });
}

async function handleUpdateUserCompany(req: NextRequest): Promise<NextResponse> {
  const { dbUser, walletData } = await getUserFromRequest(req);
  const userId = dbUser?.id || walletData.userId;
  const email = dbUser?.email;

  if (!userId && !email) {
    return NextResponse.json({ success: false, statusCode: 401, message: 'Unauthorized' }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await readJson(req);
  } catch {}

  const organizationName = body.companyName || body.organizationName || body.name;
  const phone = body.phone || body.phoneNumber;
  const jobTitle = body.jobTitle;

  const currentMeta = (dbUser?.metadata as any) || {};
  let updatedMeta = { ...currentMeta };
  if (jobTitle !== undefined) {
    updatedMeta.jobTitle = String(jobTitle).trim();
  }

  const rows = await queryDbStrict(
    `UPDATE users
     SET organization_name = COALESCE($1, organization_name),
         phone_number = COALESCE($2, phone_number),
         metadata = $3::jsonb,
         updated_at = NOW()
     WHERE id = $4 OR (email IS NOT NULL AND LOWER(email) = LOWER($5))
     RETURNING *`,
    [
      organizationName || null,
      phone || null,
      JSON.stringify(updatedMeta),
      userId || '00000000-0000-0000-0000-000000000000',
      email || '',
    ]
  );

  const updatedUser = rows[0] || dbUser;

  return NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Company details saved directly to the PostgreSQL database',
    data: {
      companyName: updatedUser.organization_name,
      phone: updatedUser.phone_number,
      jobTitle: updatedUser.metadata?.jobTitle || '',
    },
    timestamp: new Date().toISOString(),
  });
}

async function handleUpdateUserNotifications(req: NextRequest): Promise<NextResponse> {
  const { dbUser, walletData } = await getUserFromRequest(req);
  const userId = dbUser?.id || walletData.userId;
  const email = dbUser?.email;

  if (!userId && !email) {
    return NextResponse.json({ success: false, statusCode: 401, message: 'Unauthorized' }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await readJson(req);
  } catch {}

  const currentMeta = (dbUser?.metadata as any) || {};
  // S-16: merge only known boolean notification flags, so arbitrary/oversized keys cannot be stashed in
  // users.metadata.
  const updatedNotifications = {
    ...(currentMeta.notifications || {}),
    ...pickBooleanKeys(body, NOTIFICATION_KEYS as unknown as string[]),
  };
  const updatedMeta = {
    ...currentMeta,
    notifications: updatedNotifications,
  };

  const rows = await queryDbStrict(
    `UPDATE users
     SET metadata = $1::jsonb,
         updated_at = NOW()
     WHERE id = $2 OR (email IS NOT NULL AND LOWER(email) = LOWER($3))
     RETURNING *`,
    [
      JSON.stringify(updatedMeta),
      userId || '00000000-0000-0000-0000-000000000000',
      email || '',
    ]
  );

  const updatedUser = rows[0] || dbUser;

  return NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Notification preferences saved to the PostgreSQL database',
    data: updatedUser.metadata?.notifications || updatedNotifications,
    timestamp: new Date().toISOString(),
  });
}

async function handleUpdateUserPreferences(req: NextRequest): Promise<NextResponse> {
  const { dbUser, walletData } = await getUserFromRequest(req);
  const userId = dbUser?.id || walletData.userId;
  const email = dbUser?.email;

  if (!userId && !email) {
    return NextResponse.json({ success: false, statusCode: 401, message: 'Unauthorized' }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await readJson(req);
  } catch {}

  const currentMeta = (dbUser?.metadata as any) || {};
  // S-16: keep only known, length-bounded preference keys.
  const updatedPreferences = {
    ...(currentMeta.preferences || {}),
    ...pickPreferences(body),
  };
  const updatedMeta = {
    ...currentMeta,
    preferences: updatedPreferences,
  };

  const rows = await queryDbStrict(
    `UPDATE users
     SET metadata = $1::jsonb,
         updated_at = NOW()
     WHERE id = $2 OR (email IS NOT NULL AND LOWER(email) = LOWER($3))
     RETURNING *`,
    [
      JSON.stringify(updatedMeta),
      userId || '00000000-0000-0000-0000-000000000000',
      email || '',
    ]
  );

  const updatedUser = rows[0] || dbUser;

  return NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'App preferences saved to the PostgreSQL database',
    data: updatedUser.metadata?.preferences || updatedPreferences,
    timestamp: new Date().toISOString(),
  });
}

async function handleUpdateUserPassword(req: NextRequest): Promise<NextResponse> {
  const { dbUser, walletData } = await getUserFromRequest(req);
  const userId = dbUser?.id || walletData.userId;
  const email = dbUser?.email;

  if (!userId && !email) {
    return NextResponse.json({ success: false, statusCode: 401, message: 'Unauthorized' }, { status: 401 });
  }

  // The current password is verified here, so a stolen session token could otherwise be used to guess it without limit.
  if (gatewayRateLimited(`pwchange:${userId || email}`, 5, 10 * 60000)) {
    return tooManyRequests('Too many password change attempts. Please wait a few minutes and try again.');
  }

  let body: any = {};
  try {
    body = await readJson(req);
  } catch {}

  const currentPassword = String(body.currentPassword || '').trim();
  const newPassword = String(body.newPassword || '').trim();

  if (!newPassword) {
    return NextResponse.json({ success: false, statusCode: 400, message: 'New password is required' }, { status: 400 });
  }

  if (newPassword.length < 8) {
    return NextResponse.json({ success: false, statusCode: 400, message: 'Password must be at least 8 characters long' }, { status: 400 });
  }

  const existingHash = dbUser?.password_hash;
  if (existingHash && existingHash.length > 0) {
    if (!currentPassword) {
      return NextResponse.json({ success: false, statusCode: 400, message: 'Current password is required' }, { status: 400 });
    }
    const isValid = await verifyPassword(currentPassword, existingHash);
    if (!isValid) {
      return NextResponse.json({ success: false, statusCode: 400, message: 'Incorrect current password. Verification failed.' }, { status: 400 });
    }
  }

  const newHashStr = await hashPassword(newPassword);

  await queryDbStrict(
    `UPDATE users
     SET password_hash = $1,
         updated_at = NOW()
     WHERE id = $2 OR (email IS NOT NULL AND LOWER(email) = LOWER($3))`,
    [newHashStr, userId || '00000000-0000-0000-0000-000000000000', email || '']
  );

  // S-05: a password change revokes all existing sessions for the account. To keep the caller signed in
  // seamlessly, we rotate to a fresh session id and hand them a new token pair; every token minted before
  // this point (including any the change was meant to lock out) is now rejected by assertSessionCurrent.
  const data: Record<string, any> = { passwordUpdated: true, hasPassword: true };
  let res: NextResponse | null = null;
  if (userId && isUuidSub(userId)) {
    const newSessionId = await rotateActiveSession(userId, { passwordChanged: true });
    const accessSecret = gwAccessSecret();
    const refreshSecret = gwRefreshSecret();
    if (accessSecret && refreshSecret) {
      const fullName = dbUser?.display_name || `${dbUser?.first_name || ''} ${dbUser?.last_name || ''}`.trim() || (email || '').split('@')[0];
      const accessToken = signJwt(
        { sub: userId, email, name: fullName, displayName: fullName, role: dbUser?.role || 'USER', status: dbUser?.status || 'ACTIVE', provider: dbUser?.provider || 'EMAIL', sessionId: newSessionId },
        accessSecret,
        ACCESS_TOKEN_TTL_SEC,
      );
      const refreshToken = signJwt({ sub: userId, email, type: 'refresh', sessionId: newSessionId }, refreshSecret, REFRESH_TOKEN_TTL_SEC);
      data.accessToken = accessToken;
      data.refreshToken = refreshToken;
      data.tokens = { accessToken, refreshToken };
      res = NextResponse.json({
        success: true,
        statusCode: 200,
        message: existingHash ? 'Password updated successfully' : 'New password set successfully',
        data,
        timestamp: new Date().toISOString(),
      });
      const isLocal = isLocalRequestHost(req.headers.get('host'));
      res.cookies.set('orion_access_token', accessToken, { path: '/', httpOnly: true, secure: !isLocal, sameSite: 'lax', maxAge: ACCESS_TOKEN_TTL_SEC });
    }
  }

  return res || NextResponse.json({
    success: true,
    statusCode: 200,
    message: existingHash ? 'Password updated successfully' : 'New password set successfully',
    data,
    timestamp: new Date().toISOString(),
  });
}

async function proxyRequest(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;

  // Block path traversal attempts
  if (!path || path.some((seg) => seg.includes('..') || seg.includes('/') || seg.includes('\\'))) {
    return NextResponse.json(
      { success: false, statusCode: 400, message: 'Invalid path parameters' },
      { status: 400 },
    );
  }

  const fullPath = path.join('/');

  // Access gate (Phase 6.17) for every route the gateway handles itself: verified token, role and customer-account checks
  // happen here, once, before any handler runs. Routes that are proxied to the NestJS API are authenticated by it.
  const gatePolicy = routePolicy(fullPath, req.method);
  const gate = decideAccess(gatePolicy, req.headers);
  if (!gate.allow) {
    return NextResponse.json(
      { success: false, statusCode: gate.status, errorCode: gate.errorCode, message: gate.message, timestamp: new Date().toISOString() },
      { status: gate.status },
    );
  }
  const notAdmin = await requirePersistedAdmin(gatePolicy, gate.auth);
  if (notAdmin) return notAdmin;

  // S-05 / S-08 / S-13: for every authenticated native route, confirm the account is still ACTIVE and the
  // token carries the current active session id (so logout, password change and suspension take effect at once,
  // and a superseded single-device session is rejected everywhere, not only on /auth/me).
  if (gatePolicy === 'USER' || gatePolicy === 'ADMIN') {
    const staleSession = await assertSessionCurrent(gate.auth);
    if (staleSession) return staleSession;
  }

  // User logout: revoke the session natively (S-05) regardless of upstream reachability.
  if (fullPath === 'auth/logout' && req.method === 'POST') {
    // With a remote API the session and refresh token live there: revoke them first, or a "logged out" refresh token keeps minting new
    // tokens. This must run before the native logout, which rotates the account's active session id. Best effort: if the API is
    // unreachable the native logout still ends the gateway-side session.
    if (hasRemoteBackend()) {
      try {
        const targetUrl = new URL(`${getBackendUrl()}/${fullPath}${req.nextUrl.search}`);
        const bodyBuffer = await req.clone().arrayBuffer().catch(() => undefined);
        await fetch(targetUrl.toString(), { method: 'POST', headers: headersForApi(req.headers), body: bodyBuffer });
      } catch {
        // fall through to the native logout
      }
    }
    return await handleUserLogout(req);
  }

  // Customer Panel - Profile & User Settings Database Handlers
  if (fullPath === 'auth/me' || fullPath === 'user/profile') {
    if (req.method === 'GET') {
      return await handleGetUserProfile(req);
    } else if (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST') {
      return await handleUpdateUserProfile(req);
    }
  }

  if (fullPath === 'user/avatar' || fullPath === 'user/upload-avatar') {
    return await handleUploadUserAvatar(req);
  }

  if (fullPath === 'settings') {
    if (req.method === 'GET') {
      return await handleGetUserSettings(req);
    } else if (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST') {
      return await handleUpdateUserProfile(req);
    }
  }

  if (fullPath === 'settings/company') {
    return await handleUpdateUserCompany(req);
  }

  if (fullPath === 'settings/notifications') {
    return await handleUpdateUserNotifications(req);
  }

  if (fullPath === 'settings/preferences' || fullPath === 'user/settings') {
    return await handleUpdateUserPreferences(req);
  }

  if (fullPath === 'user/change-password' || fullPath === 'auth/change-password' || fullPath === 'settings/change-password') {
    return await handleUpdateUserPassword(req);
  }

  // Admin Auth - Send OTP
  if (fullPath === 'admin/auth/send-otp') {
    if (hasRemoteBackend()) {
      try {
        const backendBase = getBackendUrl();
        const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: req.method,
          headers: headersForApi(req.headers),
          body: await req.clone().arrayBuffer(),
        });
        if (isDefinitiveUpstream(upstreamRes.status)) return await relayUpstream(upstreamRes);
      } catch {
        // Fall back to native handler
      }
    }
    return handleAdminSendOtp(req);
  }

  // Admin Auth - Verify OTP
  if (fullPath === 'admin/auth/verify-otp') {
    if (hasRemoteBackend()) {
      try {
        const backendBase = getBackendUrl();
        const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: req.method,
          headers: headersForApi(req.headers),
          body: await req.clone().arrayBuffer(),
        });
        if (isDefinitiveUpstream(upstreamRes.status)) return await relayUpstream(upstreamRes);
      } catch {
        // Fall back to native handler
      }
    }
    return handleAdminVerifyOtp(req);
  }

  // Admin Auth - Logout
  if (fullPath === 'admin/auth/logout') {
    return handleAdminLogout(req);
  }

  // Admin Import Template CSV Download
  if (fullPath === 'admin/import/template' || fullPath === 'admin/template/csv') {
    return handleAdminCsvTemplate();
  }

  // Admin Import Preview - Validate rows and duplicate check
  if (fullPath === 'admin/import/preview') {
    if (hasRemoteBackend()) {
      try {
        const backendBase = getBackendUrl();
        const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: req.method,
          headers: headersForApi(req.headers),
          body: await req.clone().arrayBuffer(),
        });
        if (upstreamRes.ok) return await relayUpstream(upstreamRes);
      } catch {
        // Fall back to native handler
      }
    }
    return handleAdminImportPreview(req);
  }

  // Admin Import Submit - always the NestJS import pipeline
  if (fullPath === 'admin/import/submit') {
    return forwardImportSubmit(req);
  }

let serverPublishedBusinessesStore: any[] | null = null;

async function handleDiscoverSearch(req: NextRequest): Promise<NextResponse> {
  const searchParams = req.nextUrl.searchParams;

  const q = clampText(searchParams.get('q'), MAX_QUERY_LENGTH);
  const state = clampText(searchParams.get('state'), MAX_FILTER_TEXT);
  const city = clampText(searchParams.get('city'), MAX_FILTER_TEXT);
  const citiesParam = searchParams.get('cities')?.trim() || '';
  const district = clampText(searchParams.get('district'), MAX_FILTER_TEXT);
  const districtsParam = searchParams.get('districts')?.trim() || '';
  const pincode = clampText(searchParams.get('pincode'), 20);
  
  const industriesParam = searchParams.get('industries')?.trim() || '';
  const subIndustriesParam = searchParams.get('subIndustries')?.trim() || searchParams.get('categories')?.trim() || searchParams.get('businessCategories')?.trim() || '';
  const businessTypesParam = searchParams.get('businessTypes')?.trim() || '';
  const msmeCategoriesParam = searchParams.get('msmeCategories')?.trim() || '';

  const hasWebsite = searchParams.get('hasWebsite');
  const hasPhone = searchParams.get('hasPhone');
  const hasEmail = searchParams.get('hasEmail');
  const hasWhatsApp = searchParams.get('hasWhatsApp');
  const hasLinkedIn = searchParams.get('hasLinkedIn');
  const verified = searchParams.get('verified');

  const sort = searchParams.get('sort') || searchParams.get('sortOption') || 'highest_orion_score';
  const page = parsePage(searchParams.get('page'));
  const limit = parseLimit(searchParams.get('limit'), 25, 100);
  const offset = (page - 1) * limit;

  // Enforce strictly PUBLISHED businesses filter
  const whereClauses: string[] = [
    `(b.status = 'PUBLISHED' OR LOWER(b.status::text) = 'published' OR LOWER(b.status::text) = 'active')`
  ];
  const queryValues: any[] = [];
  let paramIdx = 1;

  if (q) {
    whereClauses.push(`(
      b.name ILIKE $${paramIdx} OR
      COALESCE(i.name, '') ILIKE $${paramIdx} OR
      COALESCE(c.name, '') ILIKE $${paramIdx} OR
      COALESCE(bl.city, '') ILIKE $${paramIdx} OR
      COALESCE(bl.state, '') ILIKE $${paramIdx} OR
      COALESCE(bl.district, '') ILIKE $${paramIdx} OR
      COALESCE(bl.pincode, '') ILIKE $${paramIdx} OR
      COALESCE(b.business_type::text, '') ILIKE $${paramIdx} OR
      COALESCE(b.description, '') ILIKE $${paramIdx}
    )`);
    queryValues.push(`%${escapeLike(q)}%`);
    paramIdx++;
  }

  if (state) {
    whereClauses.push(`LOWER(bl.state) LIKE $${paramIdx}`);
    queryValues.push(`%${escapeLike(state.toLowerCase())}%`);
    paramIdx++;
  }

  const districts = [
    ...(district ? [district] : []),
    ...(districtsParam ? splitList(districtsParam) : []),
  ];
  if (districts.length > 0) {
    whereClauses.push(`LOWER(bl.district) = ANY($${paramIdx}::text[])`);
    queryValues.push(districts.map((d) => d.toLowerCase()));
    paramIdx++;
  }

  const cities = [
    ...(city ? [city] : []),
    ...(citiesParam ? splitList(citiesParam) : []),
  ];
  if (cities.length > 0) {
    whereClauses.push(`LOWER(bl.city) = ANY($${paramIdx}::text[])`);
    queryValues.push(cities.map((c) => c.toLowerCase()));
    paramIdx++;
  }

  if (pincode) {
    whereClauses.push(`bl.pincode ILIKE $${paramIdx}`);
    queryValues.push(`%${escapeLike(pincode)}%`);
    paramIdx++;
  }

  if (industriesParam) {
    const inds = splitList(industriesParam);
    if (inds.length > 0) {
      whereClauses.push(`LOWER(i.name) = ANY($${paramIdx}::text[])`);
      queryValues.push(inds.map((i) => i.toLowerCase()));
      paramIdx++;
    }
  }

  if (subIndustriesParam) {
    const subs = splitList(subIndustriesParam);
    if (subs.length > 0) {
      whereClauses.push(`LOWER(c.name) = ANY($${paramIdx}::text[])`);
      queryValues.push(subs.map((s) => s.toLowerCase()));
      paramIdx++;
    }
  }

  if (businessTypesParam) {
    const bTypes = splitList(businessTypesParam);
    if (bTypes.length > 0) {
      whereClauses.push(`(
        LOWER(b.business_type::text) = ANY($${paramIdx}::text[]) OR
        LOWER(REPLACE(b.business_type::text, '_', ' ')) = ANY($${paramIdx}::text[])
      )`);
      queryValues.push(bTypes.map((t) => t.toLowerCase()));
      paramIdx++;
    }
  }

  if (msmeCategoriesParam) {
    const msmes = splitList(msmeCategoriesParam);
    if (msmes.length > 0) {
      whereClauses.push(`(
        LOWER(b.msme_category::text) = ANY($${paramIdx}::text[]) OR
        LOWER(REPLACE(b.msme_category::text, '_', ' ')) = ANY($${paramIdx}::text[])
      )`);
      queryValues.push(msmes.map((m) => m.toLowerCase()));
      paramIdx++;
    }
  }

  if (hasWebsite === 'true') {
    whereClauses.push(`dp.url IS NOT NULL AND dp.url != ''`);
  } else if (hasWebsite === 'false') {
    whereClauses.push(`(dp.url IS NULL OR dp.url = '')`);
  }

  if (hasPhone === 'true' || hasWhatsApp === 'true') {
    whereClauses.push(`bc.phone IS NOT NULL AND bc.phone != ''`);
  }

  if (hasEmail === 'true') {
    whereClauses.push(`bc.email IS NOT NULL AND bc.email != ''`);
  }

  if (hasLinkedIn === 'true') {
    whereClauses.push(`bc.linkedin_url IS NOT NULL AND bc.linkedin_url != ''`);
  }

  if (verified === 'true') {
    whereClauses.push(`b.is_verified = true`);
  }

  // Decision-maker (People layer) filters. Same rules as the NestJS PeopleSearchService: only
  // PUBLISHED people with current roles count, and "verified" needs role-scoped verified evidence
  // plus a verification newer than 365 days. Tables are only touched when a filter is sent.
  const DM_TYPES = [
    'FOUNDER_CEO', 'MANAGING_DIRECTOR', 'DIRECTOR_PARTNER', 'GENERAL_MANAGER', 'SALES_DECISION_MAKER',
    'MARKETING_DECISION_MAKER', 'BUSINESS_DEVELOPMENT_DECISION_MAKER', 'TECHNOLOGY_DECISION_MAKER',
    'OPERATIONS_DECISION_MAKER', 'FINANCE_DECISION_MAKER', 'HR_DECISION_MAKER', 'PROCUREMENT_DECISION_MAKER',
  ];
  const dmTypes = (searchParams.get('decisionMakerType') || '')
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => DM_TYPES.includes(t));
  const wantsDm = searchParams.get('hasDecisionMaker') === 'true';
  const wantsVerifiedDm = searchParams.get('hasVerifiedDecisionMaker') === 'true';
  const wantsDmContact = searchParams.get('hasDecisionMakerContact') === 'true';
  if (dmTypes.length > 0 || wantsDm || wantsVerifiedDm || wantsDmContact) {
    const dmParts = [`cp.business_id = b.id`, `cp.is_current = true`, `cp.is_published = true`, `cp.review_status = 'APPROVED'`, `p.data_status = 'PUBLISHED'`];
    if (dmTypes.length > 0) {
      dmParts.push(`cp.decision_maker_type = ANY($${paramIdx}::text[])`);
      queryValues.push(dmTypes);
      paramIdx++;
    } else {
      dmParts.push(`cp.decision_maker_type IS NOT NULL`);
    }
    if (wantsVerifiedDm) {
      dmParts.push(`cp.verification_status = 'VERIFIED'`);
      dmParts.push(`cp.last_verified_at > now() - interval '365 days'`);
      dmParts.push(
        `EXISTS (SELECT 1 FROM people_evidence ev WHERE ev.verified_at IS NOT NULL AND ev.company_person_id = cp.id)`,
      );
    }
    if (wantsDmContact) {
      dmParts.push(
        `EXISTS (SELECT 1 FROM person_contacts pc WHERE pc.person_id = cp.person_id AND pc.is_published = true)`,
      );
    }
    whereClauses.push(
      `EXISTS (SELECT 1 FROM company_people cp JOIN people p ON p.id = cp.person_id WHERE ${dmParts.join(' AND ')})`,
    );
  }

  const whereSql = whereClauses.join(' AND ');

  let orderBySql = 'ORDER BY created_at DESC';
  switch (sort) {
    case 'newest':
      orderBySql = 'ORDER BY created_at DESC';
      break;
    case 'oldest':
      orderBySql = 'ORDER BY created_at ASC';
      break;
    case 'name_asc':
      orderBySql = 'ORDER BY name ASC';
      break;
    case 'name_desc':
      orderBySql = 'ORDER BY name DESC';
      break;
    case 'recently_updated':
      orderBySql = 'ORDER BY updated_at DESC';
      break;
    case 'highest_orion_score':
    default:
      orderBySql = 'ORDER BY created_at DESC';
      break;
  }

  const countSql = `
    SELECT COUNT(DISTINCT b.id)::int as total
    FROM businesses b
    LEFT JOIN industries i ON b.industry_id = i.id
    LEFT JOIN categories c ON b.category_id = c.id
    LEFT JOIN business_locations bl ON b.id = bl.business_id
    LEFT JOIN business_contacts bc ON b.id = bc.business_id
    LEFT JOIN digital_presences dp ON b.id = dp.business_id AND dp.platform = 'WEBSITE'
    WHERE ${whereSql}
  `;

  const countRows = await queryDb(countSql, queryValues);
  const total = countRows[0]?.total || 0;

  const limitIdx = paramIdx;
  const offsetIdx = paramIdx + 1;
  const dataSql = `
    SELECT b_sub.*
    FROM (
      SELECT DISTINCT ON (b.id) b.id, b.name, b.slug, b.status, b.created_at, b.updated_at,
             b.business_type, b.msme_category, b.is_verified, b.incorporation_date,
             i.name as industry, c.name as category,
             bl.city, bl.state, bl.district, bl.pincode, bl.address_line1 as address,
             bc.phone, bc.email, bc.linkedin_url as linkedin_url, dp.url as website, b.description
      FROM businesses b
      LEFT JOIN industries i ON b.industry_id = i.id
      LEFT JOIN categories c ON b.category_id = c.id
      LEFT JOIN business_locations bl ON b.id = bl.business_id
      LEFT JOIN business_contacts bc ON b.id = bc.business_id
      LEFT JOIN digital_presences dp ON b.id = dp.business_id AND dp.platform = 'WEBSITE'
      WHERE ${whereSql}
      ORDER BY b.id
    ) b_sub
    ${orderBySql}
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const rows = await queryDb(dataSql, [...queryValues, limit, offset]);

  // S-01: resolve the caller's unlocked businesses BEFORE building the response, so paid contact
  // fields (phone / email / LinkedIn) are only ever serialised for rows this user has unlocked.
  // Identity comes only from a signature-verified access token; an anonymous caller unlocks nothing.
  const authHeader = req.headers.get('authorization') || '';
  const rawToken = authHeader.replace(/^Bearer\s+/i, '');
  const tokenData = rawToken ? decodeJwtPayload(rawToken) : null;
  const userIdentifier = tokenData?.sub || null;
  const unlockedIdsSet = new Set<string>();
  try {
    if (userIdentifier) {
      const wallet = await getOrSyncUserWallet(userIdentifier);
      if (wallet.userId) {
        const unlockedRows = await queryDb(
          `SELECT business_id FROM lead_unlocks WHERE user_id = $1`,
          [wallet.userId]
        );
        unlockedRows.forEach((u: any) => unlockedIdsSet.add(String(u.business_id)));
      }
    }
  } catch (e) {}

  const itemsWithUnlock = rows.map((r: any, i: number) => {
    const bType = r.business_type ? String(r.business_type).replace(/_/g, ' ') : 'Private Limited';
    const msme = r.msme_category && r.msme_category !== 'NOT_APPLICABLE'
      ? String(r.msme_category).replace(/_/g, ' ')
      : 'Medium';
    const isUnlocked = unlockedIdsSet.has(String(r.id));
    // Presence flags describe whether contact data EXISTS (drives the lock badges); the raw values
    // themselves are withheld until the row is unlocked.
    const hasPhone = Boolean(r.phone);
    const hasEmail = Boolean(r.email);
    const hasLinkedIn = Boolean(r.linkedin_url);
    return {
      id: r.id || `BIZ-${10001 + i}`,
      name: r.name,
      legalName: r.name,
      industry: r.industry || 'Information Technology',
      subIndustry: r.category || 'Services',
      category: r.category || 'Enterprise',
      city: r.city || '',
      district: r.district || r.city || '',
      state: r.state || '',
      address: r.address || '',
      zipCode: r.pincode || '',
      pincode: r.pincode || '',
      phone: isUnlocked ? (r.phone || null) : null,
      email: isUnlocked ? (r.email || null) : null,
      website: r.website || null,
      linkedin: isUnlocked ? (r.linkedin_url || null) : null,
      linkedInUrl: isUnlocked ? (r.linkedin_url || null) : null,
      hasLinkedIn,
      linkedinStatus: hasLinkedIn ? 'available' : 'not_available',
      phoneStatus: hasPhone ? 'available' : 'not_available',
      emailStatus: hasEmail ? 'available' : 'not_available',
      hasWhatsApp: hasPhone,
      verified: r.is_verified ?? false,
      completeProfile: hasPhone && hasEmail,
      recentlyUpdated: true,
      entityType: bType,
      businessType: bType,
      msmeCategory: msme,
      opportunityScore: 90,
      businessAge: 'Established',
      registrationDate: r.incorporation_date ? new Date(r.incorporation_date).toISOString().split('T')[0] : '',
      description: r.description || '',
      creditsRequired: 1,
      status: 'active',
      isUnlocked,
      tags: [r.industry || 'Enterprise', r.category || 'Verified'].filter(Boolean),
    };
  });

  return NextResponse.json({
    success: true,
    statusCode: 200,
    message: 'Published businesses search executed successfully',
    data: {
      items: itemsWithUnlock,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    },
    timestamp: new Date().toISOString(),
  });
}

async function handleDiscoverExport(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization') || '';
  const rawToken = authHeader.replace(/^Bearer\s+/i, '');
  const tokenData = rawToken ? decodeJwtPayload(rawToken) : null;
  const userIdentifier = tokenData?.sub || null;

  let userId: string | null = null;
  try {
    const wallet = await getOrSyncUserWallet(userIdentifier);
    userId = wallet.userId || null;
  } catch {}

  let requestedIds: string[] = [];
  const searchParams = req.nextUrl.searchParams;
  const queryIds = searchParams.get('ids');
  if (queryIds) {
    requestedIds = splitList(queryIds, MAX_EXPORT_IDS, 64);
  }

  if (req.method === 'POST') {
    try {
      const body = await readJson(req).catch(() => ({}));
      if (Array.isArray(body?.ids)) requestedIds = body.ids.filter((x: unknown) => typeof x === 'string').slice(0, MAX_EXPORT_IDS);
    } catch {}
  }

  const format = searchParams.get('format') || 'csv';

  let sql = `
    SELECT DISTINCT ON (b.id)
           b.id, b.name, COALESCE(b.legal_name, b.name) as legal_name, b.status, b.created_at, b.updated_at,
           b.business_type, b.msme_category, b.is_verified, b.incorporation_date, b.founding_year,
           i.name as industry, c.name as category,
           bl.address_line1, bl.address_line2, bl.city, bl.state, bl.district, bl.pincode, bl.country,
           bc.contact_person, bc.contact_title, bc.contact_department, bc.phone, bc.email, bc.linkedin_url,
           bc.has_direct_dial,
           dp.url as website, b.description,
           lu.unlocked_at,
           (SELECT value FROM business_identifiers WHERE business_id = b.id AND type = 'GSTIN' LIMIT 1) as gstin,
           (SELECT value FROM business_identifiers WHERE business_id = b.id AND type = 'PAN' LIMIT 1) as pan
    FROM businesses b
    INNER JOIN lead_unlocks lu ON b.id = lu.business_id AND lu.user_id = $1
    LEFT JOIN industries i ON b.industry_id = i.id
    LEFT JOIN categories c ON b.category_id = c.id
    LEFT JOIN business_locations bl ON b.id = bl.business_id AND bl.is_primary = true
    LEFT JOIN LATERAL (
      SELECT
        string_agg(DISTINCT NULLIF(full_name, ''), ' | ') AS contact_person,
        string_agg(DISTINCT NULLIF(title, ''), ' | ') AS contact_title,
        string_agg(DISTINCT NULLIF(department, ''), ' | ') AS contact_department,
        string_agg(DISTINCT NULLIF(phone, ''), ' | ') AS phone,
        string_agg(DISTINCT NULLIF(email, ''), ' | ') AS email,
        string_agg(DISTINCT NULLIF(linkedin_url, ''), ' | ') AS linkedin_url,
        COALESCE(bool_or(is_direct_dial), false) AS has_direct_dial
      FROM business_contacts
      WHERE business_id = b.id
    ) bc ON TRUE
    LEFT JOIN digital_presences dp ON b.id = dp.business_id AND dp.platform = 'WEBSITE'
    WHERE (b.status = 'PUBLISHED' OR LOWER(b.status::text) = 'published' OR LOWER(b.status::text) = 'active')
  `;


  const queryParams: any[] = [userId];

  if (requestedIds.length > 0) {
    const validUuids = requestedIds.filter((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    );
    if (validUuids.length > 0) {
      sql += ` AND b.id = ANY($2::uuid[])`;
      queryParams.push(validUuids);
    }
  }

  // one more row than the cap, so a truncated export can be told from one that is exactly full
  sql += ` ORDER BY b.id, lu.unlocked_at DESC NULLS LAST LIMIT ${MAX_EXPORT_ROWS + 1}`;

  const allRows = await queryDb(sql, queryParams);
  const exportTruncated = allRows.length > MAX_EXPORT_ROWS;
  const rows = exportTruncated ? allRows.slice(0, MAX_EXPORT_ROWS) : allRows;

  const exportItems = rows.map((r: any) => {
    const bType = r.business_type ? String(r.business_type).replace(/_/g, ' ') : 'Private Limited';
    const fullAddr = [r.address_line1, r.address_line2].filter(Boolean).join(', ') || [r.city, r.state].filter(Boolean).join(', ') || '';
    const unlockDate = r.unlocked_at 
      ? new Date(r.unlocked_at).toISOString().split('T')[0] 
      : (r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]);

    return {
      businessName: r.name || '',
      contactNames: r.contact_person ? String(r.contact_person).trim() : '',
      contactTitles: r.contact_title ? String(r.contact_title).trim() : '',
      contactDepartments: r.contact_department ? String(r.contact_department).trim() : '',
      phoneNumber: r.phone ? String(r.phone).trim() : '',
      email: r.email ? String(r.email).trim() : '',
      linkedInUrls: r.linkedin_url ? String(r.linkedin_url).trim() : '',
      directDialAvailable: r.has_direct_dial ? 'Yes' : 'No',
      website: r.website ? String(r.website).trim() : '',
      businessType: bType,
      address: fullAddr || '',
      city: r.city || '',
      district: r.district || r.city || '',
      state: r.state || '',
      unlockDate: unlockDate,
    };
  });

  // P9: the gateway export is audited like the API export (who, format, requested vs delivered count; no personal data).
  await recordGatewayAudit(req, 'EXPORT_CREATED', 'EXPORT', {
    dataset: 'unlocked-leads',
    format: format === 'json' ? 'json' : 'csv',
    source: 'ON_DEMAND',
    outcome: 'COMPLETED',
    requestedIds: requestedIds.length,
    rowCount: exportItems.length,
    truncated: exportTruncated,
    requestId: req.headers.get('x-request-id'),
    channel: 'gateway',
  });

  const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };

  if (format === 'json') {
    return NextResponse.json({
      success: true,
      statusCode: 200,
      message: `Exported ${exportItems.length} lead(s) successfully`,
      truncated: exportTruncated,
      data: exportItems,
      timestamp: new Date().toISOString(),
    }, { headers: NO_STORE_HEADERS });
  }

  // Format as CSV
  const csvHeaders = [
    'Business Name',
    'Contact Names',
    'Contact Titles',
    'Contact Departments',
    'Phone Numbers',
    'Email Addresses',
    'LinkedIn URLs',
    'Direct Dial Available',
    'Website',
    'Business Type',
    'Address',
    'City',
    'District',
    'State',
    'Unlock Date'
  ];

  const csvLines = [csvHeaders.join(',')];
  exportItems.forEach((item: any) => {
    // S-18: every cell is neutralised against spreadsheet formula injection (=, +, -, @, tab/CR) and quoted.
    const row = [
      csvField(item.businessName),
      csvField(item.contactNames),
      csvField(item.contactTitles),
      csvField(item.contactDepartments),
      csvField(item.phoneNumber),
      csvField(item.email),
      csvField(item.linkedInUrls),
      csvField(item.directDialAvailable),
      csvField(item.website),
      csvField(item.businessType),
      csvField(item.address),
      csvField(item.city),
      csvField(item.district),
      csvField(item.state),
      csvField(item.unlockDate),
    ];
    csvLines.push(row.join(','));
  });

  // UTF-8 BOM ensures Excel opens the file with correct encoding and treats text as text (prevents phone numbers from becoming scientific notation)
  const BOM = '\uFEFF';
  const csvContent = BOM + csvLines.join('\n');
  const exportDate = new Date().toISOString().slice(0, 10);
  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="orion-unlocked-leads-${exportDate}.csv"`,
      'X-Export-Truncated': String(exportTruncated),
      ...NO_STORE_HEADERS,
    },
  });
}


  // Discover Export Unlocked Leads API Handler
  if (fullPath === 'discover/export' || fullPath === 'export/unlocked-leads') {
    return await handleDiscoverExport(req);
  }

  // Discover Search API Handler
  if (fullPath === 'discover/search' || fullPath === 'discover/businesses') {
    return await handleDiscoverSearch(req);
  }

  // Admin & Discover Dynamic Filter Options Governance
  if (fullPath === 'admin/filter-options' || fullPath === 'discover/filter-options') {
    if (req.method === 'POST') {
      return handleUpdateFilterOptions(req);
    }
    return handleGetFilterOptions();
  }

  // Real Database Admin - Businesses List
  if (fullPath === 'admin/businesses') {
    if (req.method === 'DELETE') {
      try {
        let idsToDelete: string[] = [];
        try {
          const body = await readJson(req);
          if (Array.isArray(body?.ids)) idsToDelete = body.ids;
          else if (body?.id) idsToDelete = [body.id];
        } catch {
          const queryId = req.nextUrl.searchParams.get('id');
          const queryIds = req.nextUrl.searchParams.get('ids');
          if (queryId) idsToDelete = [queryId];
          else if (queryIds) idsToDelete = queryIds.split(',').map((s) => s.trim()).filter(Boolean);
        }

        const validUuids = idsToDelete.filter((id) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        );
        const slugsToDelete = idsToDelete.filter(
          (id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        );

        if (validUuids.length > 0) {
          await queryDb(`DELETE FROM business_contacts WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM business_locations WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM digital_presences WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM business_identifiers WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM business_history WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM business_metrics WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM business_scores WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM business_refresh_history WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM duplicate_candidates WHERE matched_business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM duplicate_clusters WHERE primary_business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM publish_queue WHERE target_business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM search_sync_logs WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM lead_unlocks WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM saved_leads WHERE business_id = ANY($1::uuid[])`, [validUuids]);
          await queryDb(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [validUuids]);
        }

        for (const slug of slugsToDelete) {
          const rows = await queryDb(`SELECT id FROM businesses WHERE slug = $1`, [slug]);
          const matchId = rows[0]?.id;
          if (matchId) {
            const uidArr = [matchId];
            await queryDb(`DELETE FROM business_contacts WHERE business_id = ANY($1::uuid[])`, [uidArr]);
            await queryDb(`DELETE FROM business_locations WHERE business_id = ANY($1::uuid[])`, [uidArr]);
            await queryDb(`DELETE FROM digital_presences WHERE business_id = ANY($1::uuid[])`, [uidArr]);
            await queryDb(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [uidArr]);
          }
        }

        console.log(`[Admin Businesses DELETE] Permanently deleted ${idsToDelete.length} records from the PostgreSQL database.`);
        // S-19: record who deleted which business records.
        await recordGatewayAudit(req, 'ADMIN_BUSINESS_DELETE', 'BUSINESS', {
          deletedIds: idsToDelete,
          count: idsToDelete.length,
        });
        return NextResponse.json({
          success: true,
          statusCode: 200,
          message: `Permanently deleted ${idsToDelete.length} business record(s) from PostgreSQL database`,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        // S-24: do not echo raw DB error text to the client.
        return serverError('admin/businesses DELETE', err);
      }
    }

    if (req.method === 'POST') {
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return NextResponse.json({ success: false, statusCode: 400, errorCode: 'INVALID_JSON', message: 'Invalid JSON body' }, { status: 400 });
      }
      try {
        const rawList = Array.isArray(body) ? body : Array.isArray(body?.businesses) ? body.businesses : [];
        serverPublishedBusinessesStore = rawList.filter((b: any) => b.status === 'published' || b.status === 'active');

        // Persist status updates & record state directly into PostgreSQL businesses table.
        // R-005: a business whose recorded source is not APPROVED is never moved to PUBLISHED from here (see lib/publish-guard.ts).
        const refused: string[] = [];
        for (const item of rawList) {
          if (item.id && item.status) {
            const dbStatus = normalizeBusinessStatus(item.status);
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id);
            const key = isUuid ? 'id' : 'slug';
            const publishing = isPublishStatus(dbStatus);
            const changed = await queryDb(statusUpdateSql(key), [dbStatus, item.id, publishing]);
            if (publishing && changed.length === 0) {
              const blocked = await queryDb(refusedLookupSql(key), [item.id]);
              if (blocked.length > 0) refused.push(String(item.id));
            }
          }
        }
        if (refused.length > 0) {
          // keep the in-memory list consistent with the database: a refused record is not published
          serverPublishedBusinessesStore = (serverPublishedBusinessesStore ?? []).filter((b: any) => !refused.includes(String(b.id)));
        }
        // S-19: record which records had their status/publish state changed.
        await recordGatewayAudit(req, 'ADMIN_BUSINESS_STATUS_UPDATE', 'BUSINESS', {
          changes: rawList
            .filter((b: any) => b?.id && b?.status && !refused.includes(String(b.id)))
            .map((b: any) => ({ id: b.id, status: normalizeBusinessStatus(b.status) })),
        });
        if (refused.length > 0) {
          await recordGatewayAudit(req, 'ADMIN_BUSINESS_PUBLISH_REFUSED', 'BUSINESS', { refusedIds: refused, count: refused.length, reason: 'SOURCE_NOT_APPROVED' });
          return NextResponse.json({
            success: true,
            statusCode: 200,
            message: `${refused.length} business(es) were not published: ${PUBLISH_REFUSED_REASON}`,
            refused,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err: any) {
        // S-24: generic error, detail only in the server log.
        return serverError('admin/businesses POST', err);
      }
      return NextResponse.json({ success: true, statusCode: 200, message: 'Published businesses updated successfully in database', timestamp: new Date().toISOString() });
    }
    const rows = await queryDb(`
      SELECT b.id, b.name, b.slug, b.status, b.created_at, b.updated_at,
             b.business_type, b.msme_category, b.is_verified, b.incorporation_date,
             i.name as industry, c.name as category,
             bl.city, bl.state, bl.district, bl.pincode, bl.address_line1 as address,
             bc.phone, bc.email, dp.url as website, b.description
      FROM businesses b
      LEFT JOIN industries i ON b.industry_id = i.id
      LEFT JOIN categories c ON b.category_id = c.id
      LEFT JOIN business_locations bl ON b.id = bl.business_id
      LEFT JOIN business_contacts bc ON b.id = bc.business_id
      LEFT JOIN digital_presences dp ON b.id = dp.business_id AND dp.platform = 'WEBSITE'
      ORDER BY b.created_at DESC
    `);
    const records = rows.map((r, i) => {
      const bType = r.business_type ? String(r.business_type).replace(/_/g, ' ') : 'Private Limited Company';
      const msme = r.msme_category && r.msme_category !== 'NOT_APPLICABLE' 
        ? `${String(r.msme_category).replace(/_/g, ' ')} Enterprise` 
        : 'Medium Enterprise';

      let mappedStatus = 'draft';
      const rawStatus = String(r.status || '').toUpperCase();
      if (rawStatus === 'PUBLISHED') mappedStatus = 'published';
      else if (rawStatus === 'VERIFIED') mappedStatus = 'approved';
      else if (rawStatus === 'PENDING_VALIDATION') mappedStatus = 'validated';
      else if (rawStatus === 'ARCHIVED') mappedStatus = 'archived';
      else if (rawStatus === 'REJECTED') mappedStatus = 'rejected';
      else mappedStatus = 'draft';

      return {
        id: r.id || `BIZ-${10001 + i}`,
        name: r.name,
        industry: r.industry || 'Manufacturing & Industrial',
        subIndustry: r.category || '',
        category: r.category || 'Enterprise',
        businessType: bType,
        msmeCategory: msme,
        address: r.address || '',
        state: r.state || '',
        district: r.district || r.city || '',
        city: r.city || '',
        pincode: r.pincode || '',
        phone: r.phone || '',
        whatsapp: '',
        email: r.email || '',
        website: r.website || '',
        registrationDate: r.incorporation_date ? new Date(r.incorporation_date).toISOString().split('T')[0] : r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : '',
        description: r.description || '',
        status: mappedStatus,
        validationStatus: r.is_verified ? 'Approved' : 'Validated',
        phoneStatus: r.phone ? 'valid' : 'missing',
        emailStatus: r.email ? 'valid' : 'missing',
        websiteStatus: assessWebsite(r.website).status,
        validationScore: r.is_verified ? 95 : 85,
        opportunityScore: 80,
        dataQualityScore: 90,
        hasWebsite: assessWebsite(r.website).hasWebsite,
        missingFields: [],
        validationErrors: [],
        reviewer: 'Monarch Administrator',
        approvedDate: r.updated_at ? new Date(r.updated_at).toISOString().split('T')[0] : '',
        validationChecks: [],
        createdAt: r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : '',
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString().split('T')[0] : '',
        importedBy: 'Admin Ingestion Pipeline',
        tags: [r.industry || 'Enterprise', r.category || 'Verified'].filter(Boolean),
        internalNotes: []
      };
    });
    return NextResponse.json({ success: true, statusCode: 200, data: records, timestamp: new Date().toISOString() });
  }

  // Real Database Admin - Import Batches
  if (fullPath === 'admin/import/batches') {
    if (req.method === 'DELETE') {
      try {
        let batchId = req.nextUrl.searchParams.get('id');
        if (!batchId) {
          const body = await readJson(req).catch(() => ({}));
          batchId = body?.id;
        }
        if (batchId) {
          await queryDb(`DELETE FROM import_batches WHERE id = $1`, [batchId]).catch(() => {});
        }
        return NextResponse.json({ success: true, statusCode: 200, message: 'Import batch permanently deleted from database' });
      } catch (e: any) {
        return NextResponse.json({ success: false, statusCode: 500, message: 'Failed to delete import batch' });
      }
    }
    const rows = await queryDb(`
      SELECT id, filename, status, total_records, processed_records, successful_records, failed_records, duplicate_records, created_at, completed_at
      FROM import_batches
      ORDER BY created_at DESC
    `);
    const batches = rows.map(r => ({
      id: r.id,
      fileName: r.filename,
      fileSize: 'CSV',
      status: r.status === 'COMPLETED' ? 'Completed' : r.status === 'FAILED' ? 'Failed' : 'Processing',
      totalRecords: r.total_records || 0,
      successCount: r.successful_records || 0,
      failedCount: r.failed_records || 0,
      duplicateCount: r.duplicate_records || 0,
      uploadedAt: r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16) : '',
      uploadedBy: 'Admin Ingestion'
    }));
    return NextResponse.json({ success: true, statusCode: 200, data: batches, timestamp: new Date().toISOString() });
  }

  // Real Database Admin - Users List
  if (fullPath === 'admin/users') {
    const rows = await queryDb(`
      SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.status, u.created_at, u.last_login_at,
             uw.balance, uw.lifetime_purchased, uw.lifetime_used
      FROM users u
      LEFT JOIN user_wallets uw ON u.id = uw.user_id
      WHERE u.role != 'SUPER_ADMIN'
      ORDER BY u.created_at DESC
    `);
    const users = rows.map(r => ({
      id: r.id,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email.split('@')[0],
      company: r.email.split('@')[1] || 'Enterprise',
      email: r.email,
      phone: '+91 98000 00000',
      role: r.role === 'ADMIN' ? 'Administrator' : 'Customer Account',
      status: r.status === 'ACTIVE' ? 'Active' : 'Suspended',
      plan: 'Starter' as const,
      credits: r.balance || 0,
      registeredDate: r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : '',
      lastLogin: r.last_login_at ? new Date(r.last_login_at).toISOString().split('T')[0] : 'Never',
      totalSpent: 0,
      unlockedCount: 0,
      unlockedBusinesses: [],
      savedSearches: [],
      loginHistory: [],
      activityTimeline: []
    }));
    return NextResponse.json({ success: true, statusCode: 200, data: users, timestamp: new Date().toISOString() });
  }

  // Real Database Admin - Transactions
  if (fullPath === 'admin/transactions') {
    const rows = await queryDb(`
      SELECT ct.id, ct.amount, ct.type, ct.balance_after, ct.description, ct.reference_id, ct.created_at,
             u.id as user_id, u.email, u.first_name, u.last_name
      FROM credit_transactions ct
      JOIN users u ON ct.user_id = u.id
      ORDER BY ct.created_at DESC
      LIMIT 50
    `);
    const transactions = rows.map((r, i) => ({
      id: r.id,
      receiptNumber: `RCP-${100000 + i}`,
      date: r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16) : '',
      customerId: r.user_id,
      customerName: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email.split('@')[0],
      customerEmail: r.email,
      company: r.email.split('@')[1] || 'Enterprise',
      plan: 'Starter' as const,
      creditsPurchased: r.amount > 0 ? r.amount : 0,
      creditsUsed: r.amount < 0 ? Math.abs(r.amount) : 0,
      amount: r.type === 'PACKAGE_PURCHASE' ? (r.amount === 100 ? 99 : r.amount === 350 ? 299 : r.amount === 1500 ? 999 : 0) : 0,
      paymentMethod: 'Razorpay UPI' as const,
      paymentStatus: 'Success' as const,
      invoiceUrl: '#',
      refundReason: undefined
    }));
    return NextResponse.json({ success: true, statusCode: 200, data: transactions, timestamp: new Date().toISOString() });
  }

  // Real Database Admin - Activity / Audit Logs
  if (fullPath === 'admin/activity-logs') {
    // S-19 / F-03: the audit_logs table has no "details" column (it has entity_type, entity_id, old_values,
    // new_values). The previous query selected a non-existent column, which queryDb swallowed, so the admin
    // Activity Logs view was always empty. Select the real columns.
    const rows = await queryDb(`
      SELECT al.id, al.action, al.entity_type, al.entity_id, al.old_values, al.new_values,
             al.ip_address, al.created_at, u.email
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.created_at DESC
      LIMIT 50
    `);
    const logs = rows.map(r => {
      const details = r.new_values ?? r.old_values ?? {};
      return {
        id: r.id,
        action: r.action,
        timestamp: r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16) : '',
        actor: r.email || 'System / Automated',
        target: r.entity_id || (details as any)?.businessId || (details as any)?.email || r.entity_type || 'Platform',
        ipAddress: r.ip_address || '',
        status: 'Success' as const,
        details: typeof details === 'object' ? JSON.stringify(details) : String(details || ''),
      };
    });
    return NextResponse.json({ success: true, statusCode: 200, data: logs, timestamp: new Date().toISOString() });
  }

  if ((fullPath === 'auth/login' || fullPath === 'auth/jwt/login') && req.method === 'POST') {
    if (hasRemoteBackend()) {
      try {
        const backendBase = getBackendUrl();
        const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);
        const bodyBuffer = await req.clone().arrayBuffer().catch(() => undefined);
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: req.method,
          headers: headersForApi(req.headers),
          body: bodyBuffer,
        });
        if (isDefinitiveUpstream(upstreamRes.status)) return await relayUpstream(upstreamRes);
      } catch {
        // Fall back to native handler
      }
    }
    return handleLogin(req);
  }

  if (fullPath === 'auth/register' && req.method === 'POST') {
    if (hasRemoteBackend()) {
      try {
        const backendBase = getBackendUrl();
        const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);
        const bodyBuffer = await req.clone().arrayBuffer().catch(() => undefined);
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: req.method,
          headers: headersForApi(req.headers),
          body: bodyBuffer,
        });
        if (isDefinitiveUpstream(upstreamRes.status)) return await relayUpstream(upstreamRes);
      } catch {
        // Fall back to native handler
      }
    }
    return handleRegister(req);
  }

  if (fullPath === 'auth/send-otp' && req.method === 'POST') {
    if (hasRemoteBackend()) {
      try {
        const backendBase = getBackendUrl();
        const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);
        const bodyBuffer = await req.clone().arrayBuffer().catch(() => undefined);
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: req.method,
          headers: headersForApi(req.headers),
          body: bodyBuffer,
        });
        if (isDefinitiveUpstream(upstreamRes.status)) return await relayUpstream(upstreamRes);
      } catch {
        // Fall back to native handler
      }
    }
    return handleSendOtp(req);
  }

  if (fullPath === 'auth/verify-otp' && req.method === 'POST') {
    if (hasRemoteBackend()) {
      try {
        const backendBase = getBackendUrl();
        const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);
        const bodyBuffer = await req.clone().arrayBuffer().catch(() => undefined);
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: req.method,
          headers: headersForApi(req.headers),
          body: bodyBuffer,
        });
        if (isDefinitiveUpstream(upstreamRes.status)) return await relayUpstream(upstreamRes);
      } catch {
        // Fall back to native handler
      }
    }
    return handleVerifyOtp(req);
  }

  if (fullPath === 'auth/refresh' && req.method === 'POST') {
    if (hasRemoteBackend()) {
      try {
        const backendBase = getBackendUrl();
        const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);
        const bodyBuffer = await req.clone().arrayBuffer().catch(() => undefined);
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: req.method,
          headers: headersForApi(req.headers),
          body: bodyBuffer,
        });
        if (isDefinitiveUpstream(upstreamRes.status)) return await relayUpstream(upstreamRes);
      } catch {
        // Fall back to native handler
      }
    }
    return handleRefresh(req);
  }

  if (fullPath === 'auth/forgot-password' && req.method === 'POST') {
    return handleForgotPassword(req);
  }

  if (fullPath === 'auth/reset-password' && req.method === 'POST') {
    return handleResetPassword(req);
  }

  // Google OAuth Initiation
  if (fullPath === 'auth/google') {
    if (hasRemoteBackend()) {
      try {
        const backendBase = getBackendUrl();
        const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: req.method,
          redirect: 'manual',
        });
        if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
          const loc = upstreamRes.headers.get('location');
          if (loc) return NextResponse.redirect(loc);
        }
        if (upstreamRes.ok) return await relayUpstream(upstreamRes);
      } catch {
        // Fall back to native handler
      }
    }
    return handleGoogleAuth(req);
  }

  // Google OAuth Callback
  if (fullPath === 'auth/google/callback') {
    if (hasRemoteBackend()) {
      try {
        const backendBase = getBackendUrl();
        const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: req.method,
          redirect: 'manual',
        });
        if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
          const loc = upstreamRes.headers.get('location');
          if (loc) return NextResponse.redirect(loc);
        }
        if (upstreamRes.ok) return await relayUpstream(upstreamRes);
      } catch {
        // Fall back to native handler
      }
    }
    return handleGoogleCallback(req);
  }

  // Gateway Liveness / Readiness health probe
  if (fullPath === 'health/liveness' || fullPath === 'health/readiness') {
    return NextResponse.json({
      success: true,
      statusCode: 200,
      message: 'Orion Gateway Online',
      data: { status: 'ok', uptime: process.uptime() },
      timestamp: new Date().toISOString(),
    });
  }

  const backendBase = getBackendUrl();
  const targetUrl = new URL(`${backendBase}/${fullPath}${req.nextUrl.search}`);

  // Prevent self-proxy recursion loops
  if (targetUrl.host === req.nextUrl.host) {
    return NextResponse.json(
      {
        success: false,
        statusCode: 500,
        message: 'Invalid routing configuration: Gateway cannot proxy to its own host.',
      },
      { status: 500 },
    );
  }

  const headers = new Headers();
  req.headers.forEach((val, key) => {
    const lower = key.toLowerCase();
    if (
      ![
        'host',
        'connection',
        'keep-alive',
        'transfer-encoding',
        'content-length',
        'expect',
      ].includes(lower)
    ) {
      headers.set(key, val);
    }
  });
  const platformClientIp = trustedForwardedFor(req.headers);
  if (platformClientIp) headers.set('x-forwarded-for', platformClientIp);
  headers.set('host', targetUrl.host);

  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip');
  if (clientIp) {
    headers.set('x-forwarded-for', clientIp);
  }
  headers.set('x-forwarded-proto', req.nextUrl.protocol.replace(':', ''));
  headers.set('x-forwarded-host', req.headers.get('host') || targetUrl.host);

  let body: ArrayBuffer | undefined = undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const contentLength = Number(req.headers.get('content-length') || 0);
    const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10MB
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return NextResponse.json(
        {
          success: false,
          statusCode: 413,
          message: 'Payload too large. Maximum request body size is 10MB.',
        },
        { status: 413 },
      );
    }
    try {
      body = await req.arrayBuffer();
      if (body.byteLength > MAX_PAYLOAD_BYTES) {
        return NextResponse.json(
          {
            success: false,
            statusCode: 413,
            message: 'Payload too large. Maximum request body size is 10MB.',
          },
          { status: 413 },
        );
      }
    } catch {
      // Body may be empty for certain calls
    }
  }

  try {
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(targetUrl.toString(), {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
      });
    } catch (firstErr: any) {
      if (targetUrl.hostname === '127.0.0.1' || targetUrl.hostname === 'localhost') {
        const altHost = targetUrl.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
        const altUrl = new URL(targetUrl.toString());
        altUrl.hostname = altHost;
        headers.set('host', altUrl.host);
        upstreamRes = await fetch(altUrl.toString(), {
          method: req.method,
          headers,
          body,
          redirect: 'manual',
        });
      } else {
        throw firstErr;
      }
    }

    // Handle OAuth redirects (Google/Microsoft 302 redirect)
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const location = upstreamRes.headers.get('location');
      if (location) {
        const redirectHeaders = new Headers();
        redirectHeaders.set('location', location);
        return new NextResponse(null, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: redirectHeaders,
        });
      }
    }

    const resHeaders = new Headers();
    upstreamRes.headers.forEach((val, key) => {
      const lowerKey = key.toLowerCase();
      if (!['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length'].includes(lowerKey)) {
        resHeaders.set(key, val);
      }
    });

    const bodyBuffer = await upstreamRes.arrayBuffer();

    return new NextResponse(bodyBuffer, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders,
    });
  } catch (err: any) {
    console.error(
      `[Gateway Error] Failed to proxy ${req.method} ${fullPath} to upstream API: ${err?.message}`,
      err?.cause || '',
    );

    // The upstream is unreachable and the gateway is about to answer itself: apply the same access decision as the NestJS API would.
    const fallbackPolicy = routePolicy(fullPath, req.method, 'fallback');
    const fallbackGate = decideAccess(fallbackPolicy, req.headers);
    if (!fallbackGate.allow) {
      return NextResponse.json(
        { success: false, statusCode: fallbackGate.status, errorCode: fallbackGate.errorCode, message: fallbackGate.message, timestamp: new Date().toISOString() },
        { status: fallbackGate.status },
      );
    }
    const fallbackNotAdmin = await requirePersistedAdmin(fallbackPolicy, fallbackGate.auth);
    if (fallbackNotAdmin) return fallbackNotAdmin;

    // Same active-session / status enforcement as the primary path (S-05 / S-08 / S-13).
    if (fallbackPolicy === 'USER' || fallbackPolicy === 'ADMIN') {
      const staleSession = await assertSessionCurrent(fallbackGate.auth);
      if (staleSession) return staleSession;
    }

    // If upstream is unavailable, provide graceful fallbacks for critical session endpoints
    if (fullPath === 'auth/login' || fullPath === 'auth/jwt/login') {
      return handleLogin(req);
    }

    if (fullPath === 'auth/register') {
      return handleRegister(req);
    }

    if (fullPath === 'auth/refresh') {
      return handleRefresh(req);
    }

    if (fullPath === 'auth/me' || fullPath === 'user/profile') {
      const authHeader = req.headers.get('authorization') || '';
      const rawToken = authHeader.replace(/^Bearer\s+/i, '');
      const tokenData = rawToken ? decodeJwtPayload(rawToken) : null;
      if (tokenData && tokenData.email && tokenData.sub) {
        const wallet = await getOrSyncUserWallet(tokenData.sub || tokenData.email);
        return NextResponse.json({
          success: true,
          statusCode: 200,
          data: {
            id: tokenData.sub,
            email: tokenData.email,
            firstName: tokenData.firstName || tokenData.name?.split(' ')[0] || 'User',
            lastName: tokenData.lastName || '',
            name: tokenData.name || tokenData.displayName || tokenData.email.split('@')[0],
            displayName: tokenData.displayName || tokenData.name || tokenData.email.split('@')[0],
            avatarUrl: tokenData.avatarUrl || null,
            role: tokenData.role || 'USER',
            status: tokenData.status || 'ACTIVE',
            organizationName: tokenData.organizationId || null,
            isEmailVerified: true,
            provider: tokenData.provider || 'google',
            googleLinked: tokenData.provider === 'google',
            microsoftLinked: tokenData.provider === 'microsoft',
            hasPassword: false,
            wallet: {
              dailyCredits: wallet.dailyCredits,
              purchasedCredits: wallet.purchasedCredits,
              balance: wallet.balance,
              lifetimePurchased: wallet.lifetimePurchased,
              lifetimeUsed: wallet.lifetimeUsed,
              lastDailyCreditDate: wallet.lastDailyCreditDate,
            },
          },
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (fullPath === 'credit/wallet') {
      const authHeader = req.headers.get('authorization') || '';
      const rawToken = authHeader.replace(/^Bearer\s+/i, '');
      const tokenData = rawToken ? decodeJwtPayload(rawToken) : null;
      const userIdentifier = tokenData?.sub || null;
      const wallet = await getOrSyncUserWallet(userIdentifier);
      return NextResponse.json({
        success: true,
        statusCode: 200,
        data: {
          dailyCredits: wallet.dailyCredits,
          purchasedCredits: wallet.purchasedCredits,
          balance: wallet.balance,
          lifetimePurchased: wallet.lifetimePurchased,
          lifetimeUsed: wallet.lifetimeUsed,
          lastDailyCreditDate: wallet.lastDailyCreditDate,
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (fullPath === 'credit/packages' || fullPath === 'credit/admin/packages') {
      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Success',
        data: [
          {
            id: '5b11b41d-4451-4ea3-9ace-be33b7a18ad4',
            slug: 'free',
            name: 'Free Plan',
            description: 'Standard access for early prospecting and exploring verified business intelligence.',
            priceInr: 0,
            priceAnnualInr: null,
            credits: 5,
            userLimit: 1,
            billingType: 'DAILY_FREE',
            popular: false,
            features: [
              '5 Daily Verified Leads',
              'Search & Discovery Engine',
              'Basic Contact Details',
              'Daily rollover at 11:59 PM',
              'Community Support',
            ],
            badgeText: '5 Daily Free',
            isActive: true,
            sortOrder: 1,
          },
          {
            id: '30ad3ee3-f861-4a59-b374-5af11f820194',
            slug: 'starter',
            name: 'Starter Pack',
            description: 'Ideal for individual founders, freelancers, and sales reps building focused pipelines.',
            priceInr: 299,
            priceAnnualInr: 239,
            credits: 100,
            userLimit: 1,
            billingType: 'ONE_TIME',
            popular: false,
            features: [
              '100 Lifetime Lead Credits',
              'Credits Never Expire',
              'Direct Mobile & Email Unlocks',
              'CSV / Spreadsheet Export',
              'Single User License',
              'Standard Support',
            ],
            badgeText: null,
            isActive: true,
            sortOrder: 2,
          },
          {
            id: 'cdcc091d-282c-4bd6-93d2-2f5aa1955110',
            slug: 'growth',
            name: 'Growth Pack',
            description: 'Best for growing sales teams and agencies looking for rapid pipeline scale.',
            priceInr: 499,
            priceAnnualInr: 399,
            credits: 350,
            userLimit: 1,
            billingType: 'ONE_TIME',
            popular: true,
            features: [
              '350 Lifetime Lead Credits',
              'Credits Never Expire',
              'Direct Decision Maker Contacts',
              'Full Export & Filter Capabilities',
              'Single User License',
              'Priority Email Support',
            ],
            badgeText: 'Most Popular',
            isActive: true,
            sortOrder: 3,
          },
          {
            id: 'b8dfcad5-f348-40b7-801d-38124b909425',
            slug: 'agency',
            name: 'Agency Pack',
            description: 'High-volume lead intelligence for outreach agencies and enterprise outbound teams.',
            priceInr: 999,
            priceAnnualInr: 799,
            credits: 1500,
            userLimit: 1,
            billingType: 'ONE_TIME',
            popular: false,
            features: [
              '1,500 Lifetime Lead Credits',
              'Credits Never Expire',
              'Full Executive & CXO Contacts',
              'Bulk Export Engine',
              'Single User License',
              'Priority VIP Support',
            ],
            badgeText: 'Best Value',
            isActive: true,
            sortOrder: 4,
          },
          {
            id: 'c31b8ca8-a484-46cb-b30d-675acfaefdb8',
            slug: 'enterprise',
            name: 'Enterprise Plan',
            description: 'Custom high-volume intelligence, dedicated infrastructure, and team workspace management.',
            priceInr: null,
            priceAnnualInr: null,
            credits: 0,
            userLimit: null,
            billingType: 'CUSTOM',
            popular: false,
            features: [
              'Custom High-Volume Credit Allocation',
              'Unlimited Team Users & RBAC',
              'Team Workspace Collaboration',
              'Bulk Export Engine',
              'Dedicated API Access',
              '24x7 Priority Account Manager',
            ],
            badgeText: 'Custom',
            isActive: true,
            sortOrder: 5,
          },
        ],
        timestamp: new Date().toISOString(),
      });
    }

    if (fullPath === 'credit/config') {
      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Success',
        data: {
          dailyFreeCredits: 5,
          annualDiscountPercentage: 20,
          defaultCurrency: 'INR',
          currencySymbol: '₹',
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (fullPath === 'credit/transactions') {
      const authHeader = req.headers.get('authorization') || '';
      const rawToken = authHeader.replace(/^Bearer\s+/i, '');
      const tokenData = rawToken ? decodeJwtPayload(rawToken) : null;
      const userIdentifier = tokenData?.sub || null;
      const wallet = await getOrSyncUserWallet(userIdentifier);

      let txRows: any[] = [];
      if (wallet.userId) {
        txRows = await queryDb(
          `SELECT id, amount, balance_after, balance_type, daily_balance_after, purchased_balance_after, type, description, reference_id, created_at
           FROM credit_transactions
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 50`,
          [wallet.userId]
        );
      }

      const items = txRows.map((r) => ({
        id: r.id,
        amount: r.amount,
        balanceAfter: r.balance_after,
        balanceType: r.balance_type,
        dailyBalanceAfter: r.daily_balance_after,
        purchasedBalanceAfter: r.purchased_balance_after,
        type: r.type,
        description: r.description,
        referenceId: r.reference_id,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      }));

      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Success',
        data: {
          items,
          total: items.length,
          page: 1,
          limit: 50,
          totalPages: 1,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Invoices are generated by the backend from real transactions. This fallback used to render a "paid" PDF from query-string
    // values (amount, customer, status), i.e. a receipt forger; it now fails closed.
    if (
      fullPath === 'payments/invoice/download' ||
      fullPath === 'invoices/download' ||
      fullPath === 'admin/invoices/download' ||
      fullPath.startsWith('payments/invoice') ||
      fullPath.startsWith('invoices/') ||
      fullPath.startsWith('admin/invoices/')
    ) {
      return paymentsUnavailable();
    }

    if (fullPath === 'payments/history') {
      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Success',
        data: [],
        timestamp: new Date().toISOString(),
      });
    }

    // Payments (Phase 6.17): the gateway never creates an order, never verifies a payment and never credits a wallet. The NestJS
    // payment module (signature-verified, bound to the order, idempotent) is the only place credits are granted for a purchase.
    if (fullPath === 'payments/create-order' || fullPath === 'payments/verify') {
      return paymentsUnavailable();
    }

    if (fullPath === 'dashboard/summary') {
      // The dashboard summary is computed by the API from the database. The gateway keeps no second copy of it: with the API unreachable it
      // says so, instead of answering with invented zeros that the page would show as real numbers.
      return NextResponse.json(
        { success: false, statusCode: 503, errorCode: 'DASHBOARD_UNAVAILABLE', message: 'The dashboard data is temporarily unavailable. Please try again.', timestamp: new Date().toISOString() },
        { status: 503 },
      );
    }

    if (fullPath === 'settings') {
      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Success',
        data: {
          company: {
            name: 'Orion Workspace',
            website: 'https://orion.ai',
          },
          notifications: {
            emailAlerts: true,
            weeklyDigest: true,
          },
          billing: {
            currency: 'INR',
          },
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (fullPath === 'unlock/user-leads') {
      const authHeader = req.headers.get('authorization') || '';
      const rawToken = authHeader.replace(/^Bearer\s+/i, '');
      const tokenData = rawToken ? decodeJwtPayload(rawToken) : null;
      const userIdentifier = tokenData?.sub || null;
      const wallet = await getOrSyncUserWallet(userIdentifier);

      let unlockedIds: string[] = [];
      if (wallet.userId) {
        const rows = await queryDb(
          `SELECT business_id FROM lead_unlocks WHERE user_id = $1`,
          [wallet.userId]
        );
        unlockedIds = rows.map((r: any) => String(r.business_id));
      }

      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Unlocked leads retrieved from database',
        data: { unlockedIds },
        timestamp: new Date().toISOString(),
      });
    }

    if (fullPath === 'admin/duplicates') {
      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Duplicate pairs retrieved from database',
        data: [],
        timestamp: new Date().toISOString(),
      });
    }

    if (fullPath.startsWith('unlock/status/')) {
      const businessId = fullPath.replace('unlock/status/', '');
      const authHeader = req.headers.get('authorization') || '';
      const rawToken = authHeader.replace(/^Bearer\s+/i, '');
      const tokenData = rawToken ? decodeJwtPayload(rawToken) : null;
      const userIdentifier = tokenData?.sub || null;
      const wallet = await getOrSyncUserWallet(userIdentifier);

      let isUnlocked = false;
      if (wallet.userId && businessId) {
        const rows = await queryDb(
          `SELECT id FROM lead_unlocks WHERE user_id = $1 AND business_id::text = $2::text LIMIT 1`,
          [wallet.userId, businessId]
        );
        isUnlocked = rows.length > 0;
      }

      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Success',
        data: {
          isUnlocked,
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (fullPath === 'unlock/business') {
      // Credit-spending fallback (Phase 6.16). Identity comes ONLY from a signature-verified, unexpired access token; the unlock
      // and its single deduction are one atomic statement (see lib/unlock-business.ts), so concurrent requests charge once and a
      // failed unlock (unknown / unpublished company, no credits) never charges.
      let parsedBody: any = {};
      try {
        if (body) {
          const parsed = JSON.parse(Buffer.from(body).toString('utf-8'));
          parsedBody = parsed !== null && typeof parsed === 'object' ? parsed : {}; // null / a number / a string used to crash the next line
        }
      } catch {}

      const authResult = authenticate(req.headers);
      if (!authResult.ok && authResult.reason === 'NOT_CONFIGURED') return authNotConfigured();
      const callerId = authResult.ok ? authResult.auth.sub : undefined;
      const businessId = String(parsedBody.businessId || parsedBody.id || '');
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const fail = (status: number, errorCode: string, message: string) =>
        NextResponse.json({ success: false, statusCode: status, errorCode, message, timestamp: new Date().toISOString() }, { status });

      if (!callerId || !UUID.test(callerId)) return fail(401, 'UNAUTHORIZED', 'A valid session is required to unlock a business.');
      if (!UUID.test(businessId)) return fail(400, 'INVALID_BUSINESS_ID', 'A valid business id is required.');

      const wallet = await getOrSyncUserWallet(callerId);
      if (!wallet.userId || wallet.userId !== callerId || !wallet.walletId) return fail(401, 'UNAUTHORIZED', 'A valid session is required to unlock a business.');

      const existing = await queryDb(`SELECT id FROM lead_unlocks WHERE user_id = $1 AND business_id = $2::uuid LIMIT 1`, [callerId, businessId]);
      const already = existing.length > 0;
      const rows = await queryDb(UNLOCK_BUSINESS_SQL, [wallet.walletId, callerId, businessId]);
      const outcome = interpretUnlockRow(rows[0], already);

      if (outcome.kind === 'NOT_FOUND') return fail(404, 'BUSINESS_NOT_FOUND', 'Business not found');
      if (outcome.kind === 'INSUFFICIENT_CREDITS') return fail(402, 'INSUFFICIENT_CREDITS', 'Insufficient credits. Please purchase credits to continue.');
      if (outcome.kind === 'ALREADY_UNLOCKED') {
        const fresh = await getOrSyncUserWallet(callerId);
        return NextResponse.json({
          success: true,
          statusCode: 200,
          message: 'Business contact details unlocked.',
          data: {
            unlocked: true,
            alreadyUnlocked: true,
            remainingCredits: fresh.balance,
            balance: fresh.balance,
            dailyCredits: fresh.dailyCredits,
            purchasedCredits: fresh.purchasedCredits,
            creditsSpent: 0,
          },
          timestamp: new Date().toISOString(),
        });
      }

      if (outcome.balance < 50) {
        try {
          await dispatchUserNotification({
            userId: callerId,
            type: 'creditLowWarning',
            title: 'Credit Low Warning',
            message: `Your credit balance is now ${outcome.balance}. Replenish your credits to ensure uninterrupted lead intelligence searches.`,
            link: '/credits',
          });
        } catch (notifErr) {
          console.warn('[Unlock Gateway] Notice on creditLowWarning notification dispatch:', (notifErr as any)?.message);
        }
      }

      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Business contact details unlocked.',
        data: {
          unlocked: true,
          alreadyUnlocked: false,
          remainingCredits: outcome.balance,
          balance: outcome.balance,
          dailyCredits: outcome.dailyCredits,
          purchasedCredits: outcome.purchasedCredits,
          creditsSpent: 1,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Offline stand-ins: they can only answer a read with an empty list. A write used to be answered with the same "success", so a
    // customer was told a lead or search was saved when nothing was stored; it is now refused while the main service is unreachable.
    if ((fullPath === 'saved-leads' || fullPath === 'saved-searches') && req.method !== 'GET' && req.method !== 'HEAD') {
      return NextResponse.json(
        { success: false, statusCode: 503, errorCode: 'TEMPORARILY_UNAVAILABLE', message: 'This cannot be saved right now because the main service is unreachable. Please try again shortly.', timestamp: new Date().toISOString() },
        { status: 503 },
      );
    }

    if (fullPath === 'saved-leads') {
      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Success',
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 20,
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (fullPath === 'saved-searches') {
      return NextResponse.json({
        success: true,
        statusCode: 200,
        message: 'Success',
        data: [],
        timestamp: new Date().toISOString(),
      });
    }

    if (fullPath === 'admin/auth/send-otp') {
      return handleAdminSendOtp(req);
    }

    if (fullPath === 'admin/auth/verify-otp') {
      return handleAdminVerifyOtp(req);
    }

    if (fullPath === 'admin/auth/logout') {
      return handleAdminLogout(req);
    }

    if (fullPath === 'admin/import/preview') {
      return handleAdminImportPreview(req);
    }

    if (fullPath === 'admin/import/submit') {
      return forwardImportSubmit(req);
    }

    if (fullPath === 'admin/import/template' || fullPath === 'admin/template/csv') {
      return handleAdminCsvTemplate();
    }

    if (fullPath === 'admin/import/batches') {
      return NextResponse.json({
        success: true,
        statusCode: 200,
        data: [],
        timestamp: new Date().toISOString(),
      });
    }

    return NextResponse.json(
      {
        success: false,
        statusCode: 503,
        errorCode: 'BACKEND_UNAVAILABLE',
        message:
          'The Orion backend API is currently unreachable. Please ensure the NestJS service is running.',
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}

/**
 * Hands an upstream API response to the browser. fetch() has already decoded a compressed body, so the transport headers of the ORIGINAL body
 * (content-encoding, content-length, transfer-encoding) must not be copied: sending the decoded bytes under a 'gzip' header makes the browser
 * fail the whole response ("Failed to fetch"), which happened for any reply large enough for the API to compress, such as register.
 */
async function relayUpstream(upstreamRes: Response): Promise<NextResponse> {
  const headers = new Headers();
  upstreamRes.headers.forEach((val, key) => {
    if (!['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length'].includes(key.toLowerCase())) headers.set(key, val);
  });
  return new NextResponse(await upstreamRes.arrayBuffer(), { status: upstreamRes.status, statusText: upstreamRes.statusText, headers });
}

/** Entry point for every method: nothing a handler throws reaches the client as a bare, body-less 500, and no error text is echoed. */
async function guarded(req: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  try {
    return await proxyRequest(req, context);
  } catch (err) {
    if (err instanceof DbWriteError) return writeFailure(err);
    console.error('[Gateway] unhandled error in a request handler:', err instanceof Error ? err.name : typeof err);
    return NextResponse.json(
      { success: false, statusCode: 500, errorCode: 'INTERNAL_ERROR', message: 'An unexpected server error occurred. Please contact support.' },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return guarded(req, context);
}

export async function POST(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return guarded(req, context);
}

export async function PUT(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return guarded(req, context);
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return guarded(req, context);
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return guarded(req, context);
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get('origin') || '';
  const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((o) => o.trim());

  const allowOrigin = allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] || 'http://localhost:3000');

  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, x-request-id, x-refresh-token',
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}
