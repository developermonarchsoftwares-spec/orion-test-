import { test, expect } from '../fixtures/test-fixtures';
import { generateTestUser, loginViaApi, registerUserViaApi } from '../fixtures/auth-helpers';

/**
 * Google sign-in, session and logout, against the local test stack (API on :4000 with NODE_ENV=test).
 * A real Google consent screen cannot be automated, so the redirect to Google is checked up to the point it leaves our site, and the return
 * trip uses the API's test-mode simulated provider (code `sim_google_<email>`), which is honoured only for NODE_ENV=test with a local database.
 */
const API = 'http://127.0.0.1:4000/api/v1';

async function googleState(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.get(`${API}/auth/google`, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  const state = new URL(res.headers()['location']).searchParams.get('state');
  expect(state).toBeTruthy();
  return state as string;
}

test.describe('PHASE 14: Google sign-in, sessions and logout', () => {
  test('14.1 The API starts a Google authorization request with client id, callback, scope and state', async ({ request }) => {
    const res = await request.get(`${API}/auth/google`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const url = new URL(res.headers()['location']);
    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/auth\/google\/callback$/);
    expect(url.searchParams.get('scope')).toMatch(/email/);
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  test('14.2 "Continue with Google" on /login sends the browser to accounts.google.com', async ({ page }) => {
    await page.route('https://accounts.google.com/**', (route) => route.abort()); // stop at Google's door: the consent screen is not automatable
    await page.goto('/login');
    const toGoogle = page.waitForRequest((r) => r.url().startsWith('https://accounts.google.com/'));
    await page.getByRole('button', { name: /continue with google/i }).click();
    const sent = new URL((await toGoogle).url());
    expect(sent.searchParams.get('client_id')).toBeTruthy();
    expect(sent.searchParams.get('state')).toBeTruthy();
  });

  test('14.3 Google returns a new user: signed in to the dashboard, session survives a reload, Sign Out ends it everywhere', async ({ page, request }) => {
    const email = `pw.google.${Date.now()}@orion-qa.io`;
    const state = await googleState(request);
    await page.goto(`${API}/auth/google/callback?code=${encodeURIComponent('sim_google_' + email)}&state=${encodeURIComponent(state)}`);
    await page.waitForURL('**/dashboard', { timeout: 20000 });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    const tokens = await page.evaluate(() => ({ access: localStorage.getItem('orion_access_token'), refresh: localStorage.getItem('orion_refresh_token') }));
    expect(tokens.access).toBeTruthy();
    expect(tokens.refresh).toBeTruthy();

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.locator('header button.rounded-full').last().click();
    await page.getByRole('button', { name: 'Sign Out' }).click();
    await page.waitForURL('**/login', { timeout: 15000 });
    const after = await page.evaluate(() => localStorage.getItem('orion_access_token'));
    expect(after).toBeNull();

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);

    // the refresh token that was issued before Sign Out must be dead on the server, not just forgotten by the browser
    const refresh = await request.post('/api/v1/auth/refresh', { data: { refreshToken: tokens.refresh } });
    expect(refresh.status(), 'a refresh token must not work after Sign Out').toBe(401);
  });

  test('14.4 A forged or reused Google state is refused', async ({ page, request }) => {
    const email = `pw.google.${Date.now()}@orion-qa.io`;
    await page.goto(`${API}/auth/google/callback?code=${encodeURIComponent('sim_google_' + email)}&state=forged-state`);
    await expect(page).toHaveURL(/\/login\?error=/);
    const state = await googleState(request);
    const first = await request.get(`${API}/auth/google/callback?code=${encodeURIComponent('sim_google_' + email)}&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
    expect(first.headers()['location']).toMatch(/\/auth\/callback\?accessToken=/);
    const replay = await request.get(`${API}/auth/google/callback?code=${encodeURIComponent('sim_google_' + email)}&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
    expect(replay.headers()['location']).toMatch(/\/login\?error=/);
  });

  test('14.5 Google sign-in for an address that already has a password account signs into that account (no duplicate)', async ({ request }) => {
    const user = generateTestUser();
    const reg = await registerUserViaApi(request, user);
    expect(reg.status).toBe(201);
    const state = await googleState(request);
    const res = await request.get(`${API}/auth/google/callback?code=${encodeURIComponent('sim_google_' + user.email)}&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
    const location = res.headers()['location'];
    expect(location).toMatch(/\/auth\/callback\?accessToken=/);
    expect(location).toMatch(/isNewUser=false/);
  });

  test('14.6 Logout revokes the refresh token on the server (API and web gateway agree)', async ({ request }) => {
    const user = generateTestUser();
    expect((await registerUserViaApi(request, user)).status).toBe(201);
    const login = await loginViaApi(request, user.email, user.password);
    expect(login.status()).toBe(200);
    const { accessToken, refreshToken } = (await login.json()).data.tokens;
    const out = await request.post('/api/v1/auth/logout', { headers: { Authorization: `Bearer ${accessToken}` }, data: { refreshToken } });
    expect(out.status()).toBe(200);
    expect((await request.post('/api/v1/auth/refresh', { data: { refreshToken } })).status()).toBe(401);
    expect((await request.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } })).status()).toBe(401);
  });
});
