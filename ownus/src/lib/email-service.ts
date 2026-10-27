/**
 * S-17: user-controlled values (display name, email, notification title/message) are interpolated into HTML
 * email bodies. Without escaping, a user could inject markup/links into emails sent from our domain. Every
 * interpolated user value is passed through escapeHtml; subject lines additionally strip CR/LF to prevent
 * header injection.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strips control characters (incl. CR/LF) from a value destined for an email header such as Subject. */
export function sanitizeHeader(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

export interface SendOtpEmailParams {
  email: string;
  otp: string;
  expiresInMinutes?: number;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * The Resend API key comes from the process environment only (Next.js loads .env.local itself; hosting sets real variables).
 * It used to fall back to scanning .env files across the monorepo, including the API's own .env: a key (or any secret) must never
 * be picked up from a file this module was not given, and the scan also made the production build trace the whole project.
 */
export function getResendApiKey(): string | undefined {
  return process.env.RESEND_API_KEY?.trim() || undefined;
}

/**
 * Format the sender address using RESEND_FROM_EMAIL.
 * Supports either:
 * - "security@monarchsoftwares.com" -> "Monarch Security <security@monarchsoftwares.com>"
 * - "Monarch Security <security@monarchsoftwares.com>" -> used as-is
 * - Fallback: "Monarch Security <security@monarchsoftwares.com>"
 */
export function getResendSenderAddress(): string {
  const customFrom = process.env.RESEND_FROM_EMAIL?.trim();

  if (!customFrom) {
    return 'Monarch Security <security@monarchsoftwares.com>';
  }
  if (customFrom.includes('<') && customFrom.includes('>')) {
    return customFrom;
  }
  return `Monarch Security <${customFrom}>`;
}

/**
 * Authoritative domain validation for Monarch Administrator accounts.
 * Allows ANY valid email address strictly ending with @monarchsoftwares.com.
 * Normalizes email to lowercase and trims whitespace.
 * Rejects Gmail, Outlook, Yahoo, and all other domains.
 */
export function isAuthorizedAdminEmail(email?: string | null): boolean {
  if (!email || typeof email !== 'string') return false;
  const clean = email.toLowerCase().trim();
  const parts = clean.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length === 0) return false;
  return domain === 'monarchsoftwares.com';
}

/**
 * Generate a responsive, high-contrast HTML email template for Monarch Security OTP verification.
 */
export function getAdminOtpHtml(otp: string, recipientEmail: string, expiresInMinutes: number = 5): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Monarch Security Passcode</title>
</head>
<body style="margin: 0; padding: 0; background-color: #09090b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f4f4f5;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="min-height: 100vh; background-color: #09090b; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #121215; border: 1px solid #27272a; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);">
          <!-- Header Brand Banner -->
          <tr>
            <td style="padding: 32px 32px 20px 32px; text-align: center; border-bottom: 1px solid #1e1e24;">
              <div style="display: inline-block; padding: 4px 12px; background-color: #1c1917; border: 1px solid #44403c; border-radius: 9999px; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: #a1a1aa; text-transform: uppercase; margin-bottom: 12px;">
                MONARCH SECURITY GATEWAY
              </div>
              <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff; letter-spacing: -0.02em;">
                Admin Security Verification
              </h1>
              <p style="margin: 8px 0 0 0; font-size: 13px; color: #71717a;">
                Orion Lead Intelligence Platform
              </p>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 32px 32px 24px 32px;">
              <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #d4d4d8;">
                Hello Administrator,
              </p>
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                A request was made to authenticate into the <strong>Monarch Softwares Administrator Console</strong> using your email address (<span style="color: #ffffff;">${escapeHtml(recipientEmail)}</span>). Use the 6-digit one-time passcode below to proceed:
              </p>

              <!-- OTP Code Display Card -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #09090b; border: 1px solid #27272a; border-radius: 12px; margin: 28px 0;">
                <tr>
                  <td style="padding: 24px; text-align: center;">
                    <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: #71717a; margin-bottom: 8px;">
                      Your One-Time Passcode
                    </div>
                    <div style="font-family: 'Courier New', Courier, monospace; font-size: 38px; font-weight: 900; letter-spacing: 0.35em; color: #ffffff; padding: 4px 0;">
                      ${otp}
                    </div>
                    <div style="font-size: 12px; color: #a1a1aa; margin-top: 8px;">
                      Expires in <strong style="color: #f4f4f5;">${expiresInMinutes} minutes</strong>
                    </div>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px 0; font-size: 13px; line-height: 1.5; color: #71717a;">
                <strong>Security Reminder:</strong> Never share this verification code with anyone. Monarch Engineering and Orion Support will never ask for your authentication codes or passwords.
              </p>
              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #71717a;">
                If you did not initiate this login request, your account credentials may have been targeted. Please immediately inform <a href="mailto:security@monarchsoftwares.com" style="color: #e4e4e7; text-decoration: underline;">security@monarchsoftwares.com</a>.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #0d0d10; border-top: 1px solid #1e1e24; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #52525b;">
                &copy; ${new Date().getFullYear()} Monarch Softwares Inc. All rights reserved. &bull; Enterprise Security System
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Sends the Admin OTP verification email strictly via Resend HTTP API.
 * Does not use SMTP or Nodemailer.
 * Fails safely without exposing the OTP if RESEND_API_KEY is missing.
 */
export async function sendAdminOtpEmail(params: SendOtpEmailParams): Promise<SendEmailResult> {
  const { email, otp, expiresInMinutes = 5 } = params;
  const resendApiKey = getResendApiKey();

  // Guard: Fail safely if RESEND_API_KEY is not configured
  if (!resendApiKey) {
    console.error(
      `[EMAIL_SERVICE] Cannot send OTP email to ${email}: RESEND_API_KEY is not set in environment variables.`
    );
    return {
      success: false,
      error: 'Email delivery service is not configured. Please configure RESEND_API_KEY in .env.local.',
    };
  }

  const fromAddress = getResendSenderAddress();
  const subject = `Your Monarch Security Passcode: ${otp}`;
  const htmlContent = getAdminOtpHtml(otp, email, expiresInMinutes);
  const textContent = `Your Monarch Security Administrator Verification Code is: ${otp}\n\nThis code will expire in ${expiresInMinutes} minutes.\n\nIf you did not request this verification code, please contact security@monarchsoftwares.com immediately.`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [email],
        subject,
        html: htmlContent,
        text: textContent,
      }),
    });

    const resJson = await res.json().catch(() => ({}));
    if (res.ok && resJson.id) {
      console.log(`[EMAIL_SERVICE] OTP email successfully dispatched via Resend to ${email} (ID: ${resJson.id})`);
      return {
        success: true,
        messageId: resJson.id,
      };
    }

    const errorMessage = resJson.message || `Resend returned HTTP ${res.status}`;
    console.error(`[EMAIL_SERVICE] Resend API error for ${email}:`, errorMessage);
    return {
      success: false,
      error: `Email delivery failed: ${errorMessage}`,
    };
  } catch (err: any) {
    console.error(`[EMAIL_SERVICE] Network error connecting to Resend API:`, err.message);
    return {
      success: false,
      error: `Network error delivering email: ${err.message}`,
    };
  }
}

export interface SendPreferenceEmailParams {
  email: string;
  name: string;
  title: string;
  message: string;
  type: string;
  link?: string;
}

function notificationLinkBase(): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (configured) return configured;
  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (process.env.VERCEL_ENV === 'production' && vercel) return `https://${vercel}`;
  return 'http://localhost:3000';
}

export async function sendPreferenceNotificationEmail(params: SendPreferenceEmailParams): Promise<SendEmailResult> {
  const { email, name, title, message, type, link } = params;
  const resendApiKey = getResendApiKey();

  if (!resendApiKey) {
    console.log(`[EMAIL_SERVICE] Notification '${title}' for ${email} generated (Simulated - RESEND_API_KEY not configured)`);
    return {
      success: true,
      messageId: `sim_${Date.now()}`,
    };
  }

  const fromAddress = getResendSenderAddress();
  const subject = `[Orion Notification] ${sanitizeHeader(title)}`;
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #09090b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #f4f4f5;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #121215; border: 1px solid #27272a; border-radius: 16px; padding: 32px;">
          <tr>
            <td>
              <h2 style="margin: 0 0 12px 0; color: #ffffff; font-size: 20px;">${escapeHtml(title)}</h2>
              <p style="margin: 0 0 16px 0; color: #a1a1aa; font-size: 14px; line-height: 1.6;">Hello ${escapeHtml(name)},</p>
              <p style="margin: 0 0 24px 0; color: #d4d4d8; font-size: 14px; line-height: 1.6;">${escapeHtml(message)}</p>
              ${
                link
                  ? `<a href="${escapeHtml(notificationLinkBase())}${escapeHtml(link)}" style="display: inline-block; background-color: #ffffff; color: #09090b; padding: 10px 20px; border-radius: 8px; font-weight: 600; font-size: 13px; text-decoration: none;">View in Orion</a>`
                  : ''
              }
              <p style="margin: 24px 0 0 0; color: #71717a; font-size: 11px;">You received this automated notification because your '${type}' preference is enabled in Orion Settings.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [email],
        subject,
        html: htmlContent,
      }),
    });

    const resJson = await res.json().catch(() => ({}));
    if (res.ok && resJson.id) {
      console.log(`[EMAIL_SERVICE] Notification email successfully dispatched via Resend to ${email} (ID: ${resJson.id})`);
      return { success: true, messageId: resJson.id };
    }
    return { success: false, error: resJson.message || `HTTP ${res.status}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export interface SendPasswordResetEmailParams {
  email: string;
  name?: string;
  resetUrl: string;
  expiresInMinutes?: number;
}

export function getPasswordResetHtml(resetUrl: string, recipientEmail: string, name?: string, expiresInMinutes: number = 15): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Orion Password</title>
</head>
<body style="margin: 0; padding: 0; background-color: #09090b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f4f4f5;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="min-height: 100vh; background-color: #09090b; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #121215; border: 1px solid #27272a; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);">
          <tr>
            <td style="padding: 32px 32px 20px 32px; text-align: center; border-bottom: 1px solid #1e1e24;">
              <div style="display: inline-block; padding: 4px 12px; background-color: #1c1917; border: 1px solid #44403c; border-radius: 9999px; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: #a1a1aa; text-transform: uppercase; margin-bottom: 12px;">
                ORION DATA PLATFORM
              </div>
              <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff; letter-spacing: -0.02em;">
                Reset Your Password
              </h1>
              <p style="margin: 8px 0 0 0; font-size: 13px; color: #71717a;">
                Account Security Center
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 32px 24px 32px;">
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #d4d4d8;">
                Hello ${escapeHtml(name || 'Valued User')},
              </p>
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                A request was made to reset the password for your Orion account registered under <span style="color: #ffffff; font-weight: 600;">${escapeHtml(recipientEmail)}</span>. Click the button below to set a new password:
              </p>

              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 28px 0; text-align: center;">
                <tr>
                  <td align="center">
                    <a href="${resetUrl}" target="_blank" style="display: inline-block; background-color: #ffffff; color: #09090b; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 700; text-decoration: none; box-shadow: 0 4px 12px rgba(255, 255, 255, 0.15);">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px 0; font-size: 12px; line-height: 1.5; color: #71717a;">
                This link will expire in <strong style="color: #f4f4f5;">${expiresInMinutes} minutes</strong>. If the button doesn't work, copy and paste this URL into your browser:
              </p>
              <p style="margin: 0 0 24px 0; font-size: 11px; word-break: break-all; color: #a1a1aa; background-color: #09090b; padding: 10px; border-radius: 6px; border: 1px solid #27272a;">
                ${resetUrl}
              </p>
              <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #71717a;">
                If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px; background-color: #0d0d10; border-top: 1px solid #1e1e24; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #52525b;">
                &copy; ${new Date().getFullYear()} Monarch Softwares Inc. All rights reserved. &bull; Orion Lead Intelligence Platform
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendPasswordResetEmail(params: SendPasswordResetEmailParams): Promise<SendEmailResult> {
  const { email, name, resetUrl, expiresInMinutes = 15 } = params;
  const resendApiKey = getResendApiKey();

  if (!resendApiKey) {
    console.error(
      `[EMAIL_SERVICE] Cannot send password reset email to ${email}: RESEND_API_KEY is not set in environment variables.`
    );
    return {
      success: false,
      error: 'Email delivery service is not configured. Please configure RESEND_API_KEY in .env.local or environment variables.',
    };
  }

  const fromAddress = getResendSenderAddress();
  const subject = `Reset Your Password - Orion Data Platform`;
  const htmlContent = getPasswordResetHtml(resetUrl, email, name, expiresInMinutes);
  const textContent = `Hello ${name || 'User'},\n\nA request was made to reset your password for Orion Data Platform (${email}).\n\nClick the link below to set a new password:\n${resetUrl}\n\nThis reset link is valid for ${expiresInMinutes} minutes.\n\nIf you did not request this, please ignore this email.`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [email],
        subject,
        html: htmlContent,
        text: textContent,
      }),
    });

    const resJson = await res.json().catch(() => ({}));
    if (res.ok && resJson.id) {
      console.log(`[EMAIL_SERVICE] Password reset email successfully dispatched via Resend to ${email} (ID: ${resJson.id})`);
      return {
        success: true,
        messageId: resJson.id,
      };
    }

    const errorMessage = resJson.message || `Resend returned HTTP ${res.status}`;
    console.error(`[EMAIL_SERVICE] Resend API error for ${email}:`, errorMessage);
    return {
      success: false,
      error: `Email delivery failed: ${errorMessage}`,
    };
  } catch (err: any) {
    console.error(`[EMAIL_SERVICE] Network error connecting to Resend API:`, err.message);
    return {
      success: false,
      error: `Network error delivering email: ${err.message}`,
    };
  }
}

/** The sign-up verification code e-mail (web gateway path). The subject carries no code; the body is never logged. */
export function getSignupOtpContent(otp: string, minutes: number = 5): { subject: string; text: string; html: string } {
  const brand = sanitizeHeader(process.env.APP_NAME || "Orion").replace(/[<>]/g, "").slice(0, 60) || "Orion";
  const spaced = `${otp.slice(0, 3)} ${otp.slice(3)}`;
  const text = [
    `Your ${brand} verification code is ${otp}.`,
    "",
    `It expires in ${minutes} minutes and can be used once.`,
    "Never share this code with anyone. We will never ask you for it by phone, chat or e-mail.",
    "",
    `If you did not try to create a ${brand} account, you can ignore this message; nothing was created.`,
  ].join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(brand)} verification code</title></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;"><tr><td style="padding:28px 32px 8px 32px;font-size:18px;font-weight:700;">${escapeHtml(brand)}</td></tr><tr><td style="padding:8px 32px 0 32px;font-size:15px;line-height:1.6;color:#3f3f46;">Use this code to verify your email address and finish creating your account:</td></tr><tr><td align="center" style="padding:24px 32px;"><div style="display:inline-block;padding:14px 24px;background:#fafafa;border:1px solid #e4e4e7;border-radius:10px;font-size:32px;font-weight:700;letter-spacing:8px;font-family:Consolas,monospace;">${spaced}</div></td></tr><tr><td style="padding:0 32px 8px 32px;font-size:14px;line-height:1.6;color:#52525b;">This code expires in <strong>${minutes} minutes</strong> and can be used only once.</td></tr><tr><td style="padding:0 32px 24px 32px;font-size:14px;line-height:1.6;color:#b91c1c;"><strong>Do not share this code with anyone.</strong> We will never ask you for it.</td></tr><tr><td style="padding:16px 32px 28px 32px;border-top:1px solid #f4f4f5;font-size:12px;line-height:1.6;color:#a1a1aa;">If you did not try to create a ${escapeHtml(brand)} account, you can ignore this message. Nothing was created.</td></tr></table></td></tr></table></body></html>`;
  return { subject: `${brand}: your verification code`, text, html };
}

/** Sends the sign-up code through Resend. Resolves true only when the provider accepted the message. Never logs the code or the address. */
export async function sendSignupOtpEmail(email: string, otp: string, minutes: number = 5): Promise<boolean> {
  const key = getResendApiKey();
  if (!key) {
    console.error("[EMAIL_SERVICE] Cannot send a sign-up code: RESEND_API_KEY is not set.");
    return false;
  }
  const { subject, text, html } = getSignupOtpContent(otp, minutes);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: getResendSenderAddress(), to: [email], subject, html, text }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.id) return true;
    console.error("[EMAIL_SERVICE] Sign-up code was not accepted by the mail provider", { status: res.status });
    return false;
  } catch (err: any) {
    console.error("[EMAIL_SERVICE] Sign-up code delivery error", { message: String(err?.message || err).slice(0, 120) });
    return false;
  }
}

/** The notice sent instead of a code when sign-up is started for an address that already has an account (it holds no secret, only sign-in links). */
export function getExistingAccountContent(baseUrl: string): { subject: string; text: string; html: string } {
  const brand = sanitizeHeader(process.env.APP_NAME || "Orion").replace(/[<>]/g, "").slice(0, 60) || "Orion";
  const base = baseUrl.replace(/\/+$/, "");
  const text = [
    `Someone, hopefully you, started creating a ${brand} account with this email address, but an account with this address already exists, so no verification code was sent.`,
    "",
    `Sign in: ${base}/login`,
    `Forgot your password? ${base}/forgot-password`,
    "",
    "If this was not you, you can ignore this message; nothing was changed.",
  ].join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${brand}</title></head><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;line-height:1.6;padding:24px;"><p style="font-size:18px;font-weight:700;margin:0 0 12px;">${brand}</p><p>Someone, hopefully you, started creating a ${brand} account with this email address, but <strong>an account with this address already exists</strong>, so no verification code was sent.</p><p><a href="${base}/login">Sign in</a> &middot; <a href="${base}/forgot-password">Forgot your password?</a></p><p style="color:#71717a;font-size:13px;">If this was not you, you can ignore this message; nothing was changed.</p></body></html>`;
  return { subject: `${brand}: you already have an account`, text, html };
}

/** Sends that notice through Resend. Resolves true only when the provider accepted it. Never logs the address. */
export async function sendExistingAccountEmail(email: string, baseUrl: string): Promise<boolean> {
  const key = getResendApiKey();
  if (!key) return false;
  const { subject, text, html } = getExistingAccountContent(baseUrl);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: getResendSenderAddress(), to: [email], subject, html, text }),
    });
    const json = await res.json().catch(() => ({}));
    return Boolean(res.ok && json.id);
  } catch {
    return false;
  }
}
