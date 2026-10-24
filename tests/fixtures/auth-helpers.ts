import { APIRequestContext, Page, expect } from '@playwright/test';
import { clearOldOtpChallenges } from './e2e-db';

export interface TestUserCredentials {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string;
}

export function generateTestUser(): TestUserCredentials {
  const timestamp = Date.now();
  const randomSuffix = Math.floor(Math.random() * 10000);
  return {
    email: `pw.user.${timestamp}.${randomSuffix}@orion-qa.io`,
    password: `P@ssword${randomSuffix}!Secure`,
    firstName: 'QAUser',
    lastName: `Tester${randomSuffix}`,
    companyName: `Orion QA Ventures ${randomSuffix}`,
  };
}

export const KNOWN_ADMIN = {
  email: 'admin@monarchsoftwares.com', // the seed's default admin; admin sign-in is limited to @monarchsoftwares.com addresses
  defaultOtp: '123456',
};

/** The local mail sink (tests/fixtures/mail-capture-server.mjs). The API is started with MAIL_TRANSPORT=webhook pointing at it. */
export const MAIL_CAPTURE_URL = `http://127.0.0.1:${process.env.MAIL_CAPTURE_PORT || 4455}`;

/**
 * The 6-digit sign-up code the API e-mailed to `email`, read from the local mail sink. Polls because the mail is sent after the request
 * that triggered it returns. Pass `notBefore` (a Date.now() taken before the code was requested) to ignore an older code for the same address.
 */
export async function getEmailOtp(request: APIRequestContext, email: string, notBefore = 0): Promise<string> {
  let code = '';
  await expect
    .poll(
      async () => {
        const res = await request.get(`${MAIL_CAPTURE_URL}/otp`, { params: { email } });
        if (!res.ok()) return '';
        const body = await res.json();
        code = body.at >= notBefore ? String(body.code) : '';
        return code;
      },
      { message: `no verification e-mail reached the mail sink for ${email}`, timeout: 15000 }
    )
    .toMatch(/^\d{6}$/);
  return code;
}

/**
 * Prove ownership of an address through the API (send code, read it from the mail sink, verify it) and return the one-time proof that
 * registration must present as `verificationToken`.
 */
export async function verifyEmailViaApi(request: APIRequestContext, email: string): Promise<string> {
  await clearOldOtpChallenges();
  const startedAt = Date.now();
  const send = await request.post('/api/v1/auth/send-otp', { data: { email, purpose: 'REGISTER' } });
  expect(send.status(), `send-otp failed: ${await send.text()}`).toBeLessThan(300);
  const otp = await getEmailOtp(request, email, startedAt);
  const verify = await request.post('/api/v1/auth/verify-otp', { data: { email, otp, purpose: 'REGISTER' } });
  const body = await verify.json();
  expect(verify.status(), `verify-otp failed: ${JSON.stringify(body)}`).toBe(200);
  const token = body.verificationToken ?? body.data?.verificationToken;
  expect(token, 'verify-otp returned no verificationToken').toBeTruthy();
  return token;
}

/** Register a user through the API (with the email-code step) and return the raw response body and status. */
export async function registerUserViaApi(
  request: APIRequestContext,
  user: TestUserCredentials
): Promise<{ status: number; body: any }> {
  const verificationToken = await verifyEmailViaApi(request, user.email);
  const res = await request.post('/api/v1/auth/register', {
    data: { email: user.email, password: user.password, firstName: user.firstName, lastName: user.lastName, verificationToken },
  });
  return { status: res.status(), body: await res.json() };
}

/**
 * Perform a UI-based user registration. Sign-up has two steps: details (which e-mails a code), then the code (which creates the account).
 */
export async function registerUserViaUI(
  page: Page,
  user: TestUserCredentials
): Promise<void> {
  await clearOldOtpChallenges();
  await page.goto('/register');
  await page.waitForLoadState('domcontentloaded');

  await page.locator('#name').fill(`${user.firstName} ${user.lastName}`);
  await page.locator('#email').fill(user.email);
  await page.locator('#company').fill(user.companyName);
  await page.locator('#password').fill(user.password);

  const termsCheckbox = page.locator('#terms');
  await termsCheckbox.check();

  const startedAt = Date.now();
  const continueBtn = page.getByRole('button', { name: /^continue$/i });
  await expect(continueBtn).toBeEnabled({ timeout: 5000 });
  await continueBtn.click();

  // Step 2: the code the API e-mailed (read from the local mail sink)
  await expect(page.getByRole('heading', { name: /verify your email/i })).toBeVisible({ timeout: 10000 });
  const otp = await getEmailOtp(page.request, user.email, startedAt);
  await page.getByLabel('Digit 1 of 6').fill(otp);
  const verifyBtn = page.getByRole('button', { name: /verify code/i });
  if (await verifyBtn.isEnabled().catch(() => false)) await verifyBtn.click().catch(() => undefined); // entering the 6th digit may already submit

  // Should navigate to dashboard
  await page.waitForURL('**/dashboard', { timeout: 15000 });
}

/**
 * Perform a UI-based user login
 */
export async function loginUserViaUI(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('domcontentloaded');

  if (page.url().includes('/dashboard')) {
    await page.context().clearCookies();
    await page.evaluate(() => {
      try {
        localStorage.clear();
      } catch {}
    });
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');
  }

  const emailInput = page.locator('#email');
  await emailInput.fill(email);
  await page.locator('#password').fill(password);

  const submitBtn = page.getByRole('button', { name: /sign in with email/i });
  await expect(submitBtn).toBeEnabled({ timeout: 5000 });
  await submitBtn.click();

  await page.waitForURL('**/dashboard', { timeout: 15000 });
}

/**
 * Perform UI-based admin login at /admin/monarch
 */
export async function loginAdminViaUI(
  page: Page,
  email: string = KNOWN_ADMIN.email,
  otp: string = KNOWN_ADMIN.defaultOtp
): Promise<void> {
  // Fetch a valid admin token directly. A code must be requested first: verifying without one counts as a wrong attempt, and five wrong
  // attempts lock the account until a new code is issued. Requests for a new code are limited to one per 30 seconds, so a refusal there
  // just means the previous code is still valid.
  try {
    await page.request.post('http://localhost:3000/api/v1/admin/auth/send-otp', { data: { email } });
    const res = await page.request.post('http://localhost:3000/api/v1/admin/auth/verify-otp', {
      data: { email, otp: otp || '123456' },
    });
    const json = await res.json();
    if (json?.data?.adminToken) {
      const token = json.data.adminToken;
      await page.context().addCookies([
        {
          name: 'orion_admin_token',
          value: token,
          url: 'http://localhost:3000',
        },
      ]);
      await page.addInitScript(
        ({ tok, em }) => {
          try {
            window.localStorage.setItem('orion_admin_token', tok);
            window.localStorage.setItem('orion_admin_email', em);
          } catch {}
        },
        { tok: token, em: email }
      );
    }
  } catch {
    // Fall through
  }

  await page.goto('/admin/monarch');
  await page.waitForLoadState('domcontentloaded');

  const consoleLocator = page.getByText(/ORION ADMIN|Operations Dashboard|admin@monarchsoftwares\.com/i).first();
  if (await consoleLocator.isVisible().catch(() => false)) {
    return;
  }

  // If still on gateway screen, wait for email input to be ready and submit
  const emailInput = page.locator('#admin-email');
  if (await emailInput.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    await emailInput.fill(email);
    const sendOtpBtn = page.getByRole('button', { name: /send verification code/i });
    if (await sendOtpBtn.isEnabled().catch(() => false)) {
      await sendOtpBtn.click();
      const otpInput = page.locator('#otp-input');
      if (await otpInput.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) {
        await otpInput.fill(otp);
        const verifyBtn = page.getByRole('button', { name: /verify & launch admin console/i });
        await verifyBtn.click();
      }
    }
  }

  // Verify admin dashboard / console is visible
  await expect(consoleLocator).toBeVisible({ timeout: 15000 });
}
