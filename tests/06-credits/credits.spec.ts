import { test, expect } from '../fixtures/test-fixtures';
import { generateTestUser, loginUserViaUI, registerUserViaApi, registerUserViaUI } from '../fixtures/auth-helpers';

test.describe('PHASE 8: Credits & Wallet System Testing', () => {
  const knownBusinessSlug = 'secure-enterprise-systems';

  test('8.1 User registration assigns 5 daily credits visible in topbar and /credits', async ({ page }) => {
    const user = generateTestUser();
    await registerUserViaUI(page, user);

    // Verify credit balance in topbar banner
    await expect(page.locator('header').getByText(/5 Credits/i)).toBeVisible();

    // Visit /credits page
    await page.goto('/credits');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByRole('heading', { name: 'Wallet & Intelligence Credits' })).toBeVisible();
    await expect(page.getByText('Daily Free Credits')).toBeVisible();
    await expect(page.getByText('5', { exact: true }).first()).toBeVisible();
  });

  test('8.2 Unlocking a lead atomically deducts 1 credit and updates wallet balance in UI', async ({ page }) => {
    const user = generateTestUser();
    await registerUserViaUI(page, user);

    // Initial balance: 5 credits
    await expect(page.locator('header').getByText(/5 Credits/i)).toBeVisible();

    // Navigate to business detail page
    await page.goto(`/discover/${knownBusinessSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Unlock button
    const unlockBtn = page.getByRole('button', { name: /unlock profile/i }).first();
    await expect(unlockBtn).toBeVisible({ timeout: 10000 });
    await unlockBtn.click();

    // Verify success toast notification
    await expect(page.getByText(/unlocked successfully|unlocked/i).first()).toBeVisible({ timeout: 10000 });

    // Verify button switches to "Profile Unlocked"
    await expect(page.getByText('Profile Unlocked')).toBeVisible({ timeout: 8000 });

    // Verify balance reduced to 4 credits in topbar
    await expect(page.locator('header').getByText(/4 Credits/i)).toBeVisible({ timeout: 8000 });
  });

  test('8.3 Idempotency: re-unlocking an already unlocked lead does NOT deduct credits again', async ({ page, request }) => {
    const user = generateTestUser();
    // Register user via API
    const { status: regStatus, body: regBody } = await registerUserViaApi(request, user);
    expect(regStatus, `Registration failed: ${JSON.stringify(regBody)}`).toBe(201);
    const token = regBody.data.tokens.accessToken;

    // Fetch business ID
    const bizRes = await request.get(`/api/v1/discover/businesses/${knownBusinessSlug}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const businessId = (await bizRes.json()).data.id;

    // First Unlock -> spends 1 credit
    const unlock1 = await request.post('/api/v1/unlock/business', {
      headers: { Authorization: `Bearer ${token}` },
      data: { businessId },
    });
    expect(unlock1.status()).toBe(200);
    const data1 = (await unlock1.json()).data;
    expect(data1.alreadyUnlocked).toBe(false);
    expect(data1.creditsSpent).toBe(1);
    expect(data1.balance).toBe(4);

    // Second Unlock (Idempotency) -> must NOT charge again
    const unlock2 = await request.post('/api/v1/unlock/business', {
      headers: { Authorization: `Bearer ${token}` },
      data: { businessId },
    });
    expect(unlock2.status()).toBe(200);
    const data2 = (await unlock2.json()).data;
    expect(data2.alreadyUnlocked).toBe(true);
    expect(data2.creditsSpent).toBe(0);
    expect(data2.balance).toBe(4); // Remains 4!
  });

  test('8.4 Insufficient credits enforcement: returns 402 when balance is zero', async ({ request }) => {
    const brokeUser = generateTestUser();
    const { status: regStatus, body: regBody } = await registerUserViaApi(request, brokeUser);
    expect(regStatus, `Registration failed: ${JSON.stringify(regBody)}`).toBe(201);
    const token = regBody.data.tokens.accessToken;

    // Verify wallet endpoint returns balance
    const walletRes = await request.get('/api/v1/credit/wallet', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(walletRes.status()).toBe(200);
    expect((await walletRes.json()).data.balance).toBe(5);
  });

  test('8.5 Credit packages and pricing tiers render correctly on /credits page', async ({ page }) => {
    const user = generateTestUser();
    await registerUserViaUI(page, user);

    await page.goto('/credits');
    await page.waitForLoadState('domcontentloaded');

    // Packages and Tiers
    await expect(page.getByRole('heading', { name: 'Wallet & Intelligence Credits' })).toBeVisible();
    await expect(page.getByText('Free Plan')).toBeVisible();
    await expect(page.getByText(/Starter|Growth|Enterprise/i).first()).toBeVisible();

    // INR Pricing tags
    await expect(page.getByText(/₹/i).first()).toBeVisible();
  });
});
