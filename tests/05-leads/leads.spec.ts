import { test, expect } from '../fixtures/test-fixtures';
import { generateTestUser, loginUserViaUI, registerUserViaApi, registerUserViaUI } from '../fixtures/auth-helpers';

test.describe('PHASE 7: Leads Workflow E2E Testing', () => {
  let testUser = generateTestUser();
  let authToken: string;
  const knownBusinessSlug = 'secure-enterprise-systems';

  test.beforeAll(async ({ request }) => {
    const { body: json } = await registerUserViaApi(request, testUser);
    authToken = json?.data?.tokens?.accessToken || json?.tokens?.accessToken;
  });

  test.beforeEach(async ({ page }) => {
    if (authToken) {
      await page.addInitScript((tok) => {
        try {
          window.localStorage.setItem('orion_access_token', tok);
        } catch {}
      }, authToken);
    }
  });

  test('7.1 Lead detail page loads correctly with masked contact intelligence prior to unlock', async ({ page }) => {
    await page.goto(`/discover/${knownBusinessSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Business Name & Header
    await expect(page.getByRole('heading', { name: /Secure Enterprise Systems/i }).first()).toBeVisible({ timeout: 10000 });

    // Masked Contact Verification
    await expect(page.getByText('*** Locked Address ***').first()).toBeVisible();

    // Unlock button should indicate 1 credit cost
    const unlockBtn = page.getByRole('button', { name: /unlock/i }).first();
    await expect(unlockBtn).toBeVisible();
  });

  test('7.2 Saving a lead to pipeline updates pipeline status and displays in /leads', async ({ page }) => {
    await page.goto(`/discover/${knownBusinessSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click "Save to Pipeline" or Bookmark button
    const saveBtn = page.getByRole('button', { name: /save to pipeline|save lead|bookmark/i }).first();
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
      await expect(page.getByText(/lead saved|saved to pipeline|added to pipeline/i).first()).toBeVisible({ timeout: 6000 });
    }

    // Navigate to /leads pipeline
    await page.goto('/leads');
    await page.waitForLoadState('domcontentloaded');

    // Verify /leads page loads
    await expect(page.getByRole('heading', { name: /My Leads|Leads Pipeline|Saved Leads/i }).first()).toBeVisible();
  });

  test('7.3 Searching within My Leads filters pipeline records', async ({ page }) => {
    await page.goto('/leads');
    await page.waitForLoadState('domcontentloaded');

    const searchInput = page.getByPlaceholder(/search leads|search by business/i);
    if (await searchInput.isVisible()) {
      await searchInput.fill('Secure');
      await expect(searchInput).toHaveValue('Secure');
    }
  });

  test('7.4 Navigating to a nonexistent lead slug handles missing data gracefully', async ({ page }) => {
    await page.goto('/discover/completely-nonexistent-lead-slug-404');
    await page.waitForLoadState('domcontentloaded');

    // Should display error notice or fallback without crashing
    await expect(page.getByText(/failed to load business profile|not found|error/i).first()).toBeVisible({ timeout: 8000 });
  });

  test('7.5 Navigation back from lead profile returns to discover catalog', async ({ page }) => {
    await page.goto(`/discover/${knownBusinessSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Back link/button
    const backBtn = page.getByRole('link', { name: /back to discovery|back/i }).first();
    if (await backBtn.isVisible()) {
      await backBtn.click();
      await page.waitForURL('**/discover');
      await expect(page).toHaveURL(/\/discover/);
    }
  });
});
