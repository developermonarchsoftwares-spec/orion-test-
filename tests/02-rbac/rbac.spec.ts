import { test, expect } from '../fixtures/test-fixtures';
import { generateTestUser, loginUserViaUI, loginAdminViaUI, registerUserViaApi, registerUserViaUI, KNOWN_ADMIN } from '../fixtures/auth-helpers';

test.describe('PHASE 4: Authorization & RBAC Testing', () => {

  test.describe('1. Standard User (USER Role) Route & Action Restrictions', () => {
    let testUser = generateTestUser();

    test.beforeAll(async ({ browser }) => {
      const page = await browser.newPage();
      await registerUserViaUI(page, testUser);
      await page.close();
    });

    test('1.1 Standard user should have access to standard application routes', async ({ page }) => {
      await loginUserViaUI(page, testUser.email, testUser.password);

      // Dashboard
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard/);
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

      // Discover
      await page.goto('/discover');
      await expect(page).toHaveURL(/\/discover/);

      // Leads
      await page.goto('/leads');
      await expect(page).toHaveURL(/\/leads/);

      // Credits
      await page.goto('/credits');
      await expect(page).toHaveURL(/\/credits/);

      // Saved Searches
      await page.goto('/saved-searches');
      await expect(page).toHaveURL(/\/saved-searches/);
    });

    test('1.2 Standard user direct navigation to /admin must return 404 (Not Found)', async ({ page }) => {
      await loginUserViaUI(page, testUser.email, testUser.password);

      // Attempt visiting /admin root
      const response = await page.goto('/admin');
      // Next.js notFound() renders 404 page with 404 status code
      expect(response?.status()).toBe(404);
      await expect(page.getByText(/this page could not be found|404/i).first()).toBeVisible();
    });

    test('1.3 Standard user direct navigation to /admin/monarch must enforce security gate and block admin data', async ({ page }) => {
      await loginUserViaUI(page, testUser.email, testUser.password);

      await page.goto('/admin/monarch');
      await page.waitForLoadState('domcontentloaded');

      // The Monarch Admin Security Gate must be present, NOT the admin data
      await expect(page.getByText(/Admin Console Access|Monarch Security Gateway/i).first()).toBeVisible();
      // Admin dashboard tables, businesses, and batches should NOT be rendered without admin OTP session
      await expect(page.getByText('Import Pipeline Batch')).not.toBeVisible();
      await expect(page.getByText('Publish Queue')).not.toBeVisible();
    });

    test('1.4 Standard user API token must be rejected with 403 Forbidden on privileged admin API endpoints', async ({ page }) => {
      await loginUserViaUI(page, testUser.email, testUser.password);

      const token = await page.evaluate(() => localStorage.getItem('orion_access_token'));
      expect(token).toBeTruthy();

      // Test 1: Admin packages endpoint
      const resAdminPackages = await page.request.get('/api/v1/credit/admin/packages', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resAdminPackages.status()).toBe(403);

      // Test 2: Admin credit adjustment endpoint
      const resAdminAdjust = await page.request.post('/api/v1/credit/admin/adjust', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          userId: '00000000-0000-0000-0000-000000000000',
          dailyDelta: 0,
          purchasedDelta: 1000,
          reason: 'Unauthorized attempt',
        },
      });
      expect(resAdminAdjust.status()).toBe(403);
    });
  });

  test.describe('2. Administrator (SUPER_ADMIN Role) Privileged Access', () => {
    test('2.1 Admin OTP challenge and login should unlock full Monarch Admin Console', async ({ page }) => {
      await loginAdminViaUI(page, KNOWN_ADMIN.email, KNOWN_ADMIN.defaultOtp);

      // Verify admin console header / dashboard
      await expect(page.getByRole('heading', { name: /operations dashboard/i }).or(page.getByText(/ORION ADMIN|DATA PLATFORM/i)).first()).toBeVisible({ timeout: 10000 });

      // Verify admin navigation tabs exist
      const navContainer = page.locator('aside, nav, div').filter({ hasText: /Business Records|Users & Customers|Credits/i }).first();
      await expect(navContainer).toBeVisible();
    });
  });

  test.describe('3. IDOR / Multi-Tenant Isolation', () => {
    test('3.1 User A token cannot read or mutate User B private resources', async ({ page, request }) => {
      const userA = generateTestUser();
      const userB = generateTestUser();

      // Register both users via direct API
      const regA = await registerUserViaApi(request, userA);
      expect(regA.status).toBe(201);
      const tokenA = regA.body.data.tokens.accessToken;

      const regB = await registerUserViaApi(request, userB);
      expect(regB.status).toBe(201);
      const tokenB = regB.body.data.tokens.accessToken;

      // User B creates a saved search using valid CreateSavedSearchDto
      const createSearchRes = await request.post('/api/v1/saved-searches', {
        headers: { Authorization: `Bearer ${tokenB}` },
        data: {
          name: 'Private Search B',
          filters: { state: 'Maharashtra', city: 'Mumbai', query: 'Fintech' },
        },
      });
      expect(createSearchRes.status()).toBe(201);
      const searchB = (await createSearchRes.json()).data;
      const searchIdB = searchB.id;

      // User A attempts to access User B's saved search
      const getSearchByA = await request.get(`/api/v1/saved-searches/${searchIdB}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      // Should be 403 Forbidden or 404 Not Found (tenant isolation)
      expect([403, 404]).toContain(getSearchByA.status());

      // User A attempts to delete User B's saved search
      const deleteSearchByA = await request.delete(`/api/v1/saved-searches/${searchIdB}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect([403, 404]).toContain(deleteSearchByA.status());

      // Verify User B's search still exists and wasn't tampered with
      const verifySearchB = await request.get(`/api/v1/saved-searches/${searchIdB}`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      expect(verifySearchB.status()).toBe(200);
    });
  });
});
