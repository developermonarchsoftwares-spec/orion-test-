import { defineConfig, devices } from '@playwright/test';

/**
 * Orion Platform - Comprehensive Playwright E2E Test Configuration
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // Run serially to avoid database race conditions on credit balances and test accounts
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Deterministic sequential execution across test suites
  timeout: 30000,
  expect: {
    timeout: 8000,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    // Start every browser context with the privacy banner already answered ("essential only"); it otherwise covers buttons and intercepts
    // clicks. The version must match POLICY_VERSION in ownus/src/lib/consent.ts, or the banner asks again.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
          localStorage: [
            {
              name: 'orion_consent_v1',
              value: JSON.stringify({ analytics: false, marketing: false, decided: true, version: '2026-10-07', at: '2026-10-07T00:00:00.000Z' }),
            },
          ],
        },
      ],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
  // The tests need the whole stack on a DISPOSABLE database: the apps are started by tests/fixtures/start-e2e-server.cjs against orion_e2e
  // (never orion_db; see apps/api/scripts/seed-e2e-fixtures.ts for how to prepare it). The API runs with NODE_ENV=test and its mail webhook
  // pointed at a local mail sink, so no real mail is sent and the tests can read the sign-up code (tests/fixtures/mail-capture-server.mjs).
  // The API and web servers are never reused: an already running dev server could be talking to orion_db, so ports 4000 and 3000 must be free.
  webServer: [
    {
      command: 'node tests/fixtures/mail-capture-server.mjs',
      url: 'http://127.0.0.1:4455/health',
      reuseExistingServer: true,
      timeout: 15000,
    },
    {
      command: 'node tests/fixtures/start-e2e-server.cjs api',
      url: 'http://127.0.0.1:4000/api/v1/health/live',
      reuseExistingServer: false,
      timeout: 240000,
    },
    {
      command: 'node tests/fixtures/start-e2e-server.cjs web',
      url: 'http://localhost:3000',
      reuseExistingServer: false,
      timeout: 240000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
