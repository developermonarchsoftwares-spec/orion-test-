import { test, expect } from '../fixtures/test-fixtures';
import { MAIL_CAPTURE_URL, generateTestUser, loginUserViaUI, registerUserViaUI } from '../fixtures/auth-helpers';

test.describe('PHASE 3: Authentication & Session Testing', () => {

  test.describe('1. User Registration Flow', () => {
    test('1.1 Should disable submit button by default until terms are agreed', async ({ page }) => {
      await page.goto('/register');
      await page.waitForLoadState('domcontentloaded');

      const submitBtn = page.getByRole('button', { name: /^continue$/i });
      await expect(submitBtn).toBeDisabled();

      // The Terms alone are not enough: the account-data consent is its own required, unticked box (DPDP Act)
      await page.locator('#terms').check();
      await expect(submitBtn).toBeDisabled();
      await expect(page.locator('#signup-PRODUCT_UPDATES')).not.toBeChecked();
      await expect(page.locator('#signup-MARKETING')).not.toBeChecked();
      await page.locator('#signup-ACCOUNT_SERVICE').check();
      await expect(submitBtn).toBeEnabled();
    });

    test('1.2 Should prevent submission when required fields are empty', async ({ page }) => {
      await page.goto('/register');
      await page.waitForLoadState('domcontentloaded');

      await page.locator('#terms').check();
      await page.locator('#signup-ACCOUNT_SERVICE').check();
      const submitBtn = page.getByRole('button', { name: /^continue$/i });

      await submitBtn.click();

      // Form should remain on /register due to HTML5 required fields
      await expect(page).toHaveURL(/\/register/);
    });

    test('1.3 Should reject registration with invalid email format', async ({ page }) => {
      await page.goto('/register');
      await page.waitForLoadState('domcontentloaded');

      await page.locator('#name').fill('Bad Email User');
      await page.locator('#email').fill('not-a-valid-email');
      await page.locator('#password').fill('SecurePassword123!');
      await page.locator('#terms').check();
      await page.locator('#signup-ACCOUNT_SERVICE').check();

      const submitBtn = page.getByRole('button', { name: /^continue$/i });
      await submitBtn.click();

      // HTML5 email constraint prevents navigating away
      await expect(page).toHaveURL(/\/register/);
    });

    test('1.4 Should successfully register a new user, allocate 5 credits, and navigate to dashboard', async ({ page }) => {
      const user = generateTestUser();
      await registerUserViaUI(page, user);

      // Verify dashboard URL
      await expect(page).toHaveURL(/\/dashboard/);

      // Verify tokens in localStorage
      const token = await page.evaluate(() => localStorage.getItem('orion_access_token'));
      expect(token).toBeTruthy();

      // Verify credit balance and welcome message on dashboard
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
      await expect(page.getByText('Credits Remaining')).toBeVisible();
      await expect(page.locator('text=5 Credits').first()).toBeVisible();
    });

    test('1.5 Should reject duplicate registration with clear error message', async ({ page }) => {
      const user = generateTestUser();
      // First registration
      await registerUserViaUI(page, user);

      // Clear session to attempt registering the exact same email
      await page.context().clearCookies();
      await page.evaluate(() => localStorage.clear());

      await page.goto('/register');
      await page.locator('#name').fill('Duplicate Test');
      await page.locator('#email').fill(user.email);
      await page.locator('#password').fill(user.password);
      await page.locator('#terms').check();
      await page.locator('#signup-ACCOUNT_SERVICE').check();

      const startedAt = Date.now();
      const submitBtn = page.getByRole('button', { name: /^continue$/i });
      await submitBtn.click();

      // Sign-up proves e-mail ownership first and answers the same way for a new and an existing address (no account enumeration):
      // the code screen appears, but no code is e-mailed for an address that already has an account, so registration cannot proceed.
      await expect(page.getByRole('heading', { name: /verify your email/i })).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(2000);
      const mail = await page.request.get(`${MAIL_CAPTURE_URL}/otp`, { params: { email: user.email } });
      if (mail.ok()) expect((await mail.json()).at, 'a new code was e-mailed to an address that already has an account').toBeLessThan(startedAt);
      await expect(page).toHaveURL(/\/register/);
    });
  });

  test.describe('2. User Login Flow', () => {
    let testUser = generateTestUser();

    test.beforeAll(async ({ browser }) => {
      // Register test user once for login tests
      const page = await browser.newPage();
      await registerUserViaUI(page, testUser);
      await page.close();
    });

    test('2.1 Should authenticate valid credentials and redirect to dashboard', async ({ page }) => {
      await loginUserViaUI(page, testUser.email, testUser.password);
      await expect(page).toHaveURL(/\/dashboard/);

      const token = await page.evaluate(() => localStorage.getItem('orion_access_token'));
      expect(token).toBeTruthy();
    });

    test('2.2 Should reject invalid password with error notification', async ({ page }) => {
      await page.goto('/login');
      await page.locator('#email').fill(testUser.email);
      await page.locator('#password').fill('WrongPassword999!');

      const submitBtn = page.getByRole('button', { name: /sign in with email/i });
      await submitBtn.click();

      await expect(page).toHaveURL(/\/login/);
      // Backend returns "Invalid email or password"
      await expect(page.getByText(/invalid email or password/i).first()).toBeVisible({ timeout: 8000 });
    });

    test('2.3 Should reject nonexistent user email', async ({ page }) => {
      await page.goto('/login');
      await page.locator('#email').fill('nonexistent.ghost.account@orion-qa.io');
      await page.locator('#password').fill('SomePassword123!');

      const submitBtn = page.getByRole('button', { name: /sign in with email/i });
      await submitBtn.click();

      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByText(/invalid email or password/i).first()).toBeVisible({ timeout: 8000 });
    });
  });

  test.describe('3. Session Persistence & Logout', () => {
    test('3.1 Refresh should preserve user session and state', async ({ page }) => {
      const user = generateTestUser();
      await registerUserViaUI(page, user);

      await page.reload();
      await page.waitForLoadState('domcontentloaded');

      await expect(page).toHaveURL(/\/dashboard/);
      const token = await page.evaluate(() => localStorage.getItem('orion_access_token'));
      expect(token).toBeTruthy();
    });

    test('3.2 Navigation between protected routes maintains session', async ({ page }) => {
      const user = generateTestUser();
      await registerUserViaUI(page, user);

      // Navigate via topbar links with exact: true
      await page.getByRole('link', { name: 'Discover', exact: true }).click();
      await page.waitForURL('**/discover');
      await expect(page).toHaveURL(/\/discover/);

      await page.getByRole('link', { name: 'My Leads', exact: true }).click();
      await page.waitForURL('**/leads');
      await expect(page).toHaveURL(/\/leads/);

      await page.getByRole('link', { name: 'Credits', exact: true }).click();
      await page.waitForURL('**/credits');
      await expect(page).toHaveURL(/\/credits/);

      const token = await page.evaluate(() => localStorage.getItem('orion_access_token'));
      expect(token).toBeTruthy();
    });

    test('3.3 Clearing tokens invalidates authenticated session', async ({ page }) => {
      const user = generateTestUser();
      await registerUserViaUI(page, user);

      await page.evaluate(() => {
        localStorage.removeItem('orion_access_token');
        localStorage.removeItem('orion_refresh_token');
        localStorage.removeItem('orion_user');
      });

      await page.goto('/dashboard');
      await page.waitForLoadState('domcontentloaded');

      const token = await page.evaluate(() => localStorage.getItem('orion_access_token'));
      expect(token).toBeNull();
    });
  });
});
