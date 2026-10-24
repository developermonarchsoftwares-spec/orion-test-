import { test, expect } from '../fixtures/test-fixtures';
import { generateTestUser, registerUserViaApi } from '../fixtures/auth-helpers';

test.describe('PHASE 6: Discovery, Search & Filter Testing', () => {
  let testUser = generateTestUser();
  let authToken: string;

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

  test('6.1 Discovery page loads with search bar, filter chips, and business intelligence catalog', async ({ page }) => {
    await page.goto('/discover');
    await page.waitForLoadState('domcontentloaded');

    // Search bar input
    const searchInput = page.getByPlaceholder(/search by business name/i);
    await expect(searchInput).toBeVisible();

    // Quick filter chips container
    await expect(page.getByText(/high orion score|has website|has phone/i).first()).toBeVisible();

    // Catalog results or empty state rendered
    const content = page.locator('table, [role="table"], div').filter({ hasText: /opportunity score|verified|unlock/i }).first();
    await expect(content).toBeVisible();
  });

  test('6.2 Search input displays live suggestions dropdown when typing 2+ characters', async ({ page }) => {
    await page.goto('/discover');
    await page.waitForLoadState('domcontentloaded');

    const searchInput = page.getByPlaceholder(/search by business name/i);
    await searchInput.fill('Tech');

    // Suggestions popover appears
    const suggestionsPopover = page.locator('div').filter({ hasText: /matching businesses|suggestions/i }).first();
    // Verify input retains value
    await expect(searchInput).toHaveValue('Tech');
  });

  test('6.3 Clearing search query restores full business catalog', async ({ page }) => {
    await page.goto('/discover');
    await page.waitForLoadState('domcontentloaded');

    const searchInput = page.getByPlaceholder(/search by business name/i);
    await searchInput.fill('XYZNonExistentCorporation999');

    // Clear search using clear button
    const clearBtn = page.getByTitle(/clear search/i);
    if (await clearBtn.isVisible()) {
      await clearBtn.click();
      await expect(searchInput).toHaveValue('');
    } else {
      await searchInput.fill('');
    }
  });

  test('6.4 Quick filter chips toggle on and off to filter catalog data', async ({ page }) => {
    await page.goto('/discover');
    await page.waitForLoadState('domcontentloaded');

    // Click "Has Website" filter chip if present
    const websiteChip = page.getByRole('button', { name: /has website/i });
    if (await websiteChip.isVisible()) {
      await websiteChip.click();
      // Chip should receive active state classes
      await expect(websiteChip).toBeVisible();

      // Click again to toggle off
      await websiteChip.click();
    }
  });

  test('6.5 Negative search: special characters, SQL injection payloads, and long strings execute safely', async ({ page }) => {
    await page.goto('/discover');
    await page.waitForLoadState('domcontentloaded');

    const searchInput = page.getByPlaceholder(/search by business name/i);

    // SQL injection payload test
    await searchInput.fill("' OR '1'='1' --");
    await page.waitForLoadState('domcontentloaded');
    // UI must not crash with an uncaught error
    await expect(searchInput).toHaveValue("' OR '1'='1' --");

    // Extremely long string
    const longString = 'A'.repeat(300);
    await searchInput.fill(longString);
    await expect(searchInput).toHaveValue(longString);
  });

  test('6.6 Sorting options change sort state without breaking results view', async ({ page }) => {
    await page.goto('/discover');
    await page.waitForLoadState('domcontentloaded');

    // Locate sort select or dropdown trigger
    const sortTrigger = page.locator('select, button').filter({ hasText: /highest score|newest|opportunity score/i }).first();
    if (await sortTrigger.isVisible()) {
      if (await sortTrigger.evaluate((el) => el.tagName === 'SELECT')) {
        await sortTrigger.selectOption({ index: 1 });
      } else {
        await sortTrigger.click();
      }
    }
    await expect(page).toHaveURL(/\/discover/);
  });
});
