import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Phase 17 §12.5 — the bounded critical-flow set over the real stack (D1(a)).
 *
 * Division of labor: jsdom smokes (§12.4) cover every dashboard area's
 * presentation with a stubbed API; API e2e (§12.3) owns HTTP-level depth and
 * both auth modes; this suite proves only what genuinely requires a browser —
 * cookies, redirects, real security headers, real error envelopes, route
 * protection — against api + worker + web + PG + Redis.
 *
 * Rules honored here (§4/§9):
 * - state is built through the UI/API with per-run unique data (D4) — no DB
 *   seeding, no reused credentials;
 * - condition-based waiting with bounded deadlines only — no fixed sleeps;
 * - the last test deliberately exhausts the shared write budget to surface a
 *   real 429, so it is declared last in this serial file.
 */

/** Loopback API origin; matches `playwright.config.ts` (`apiEnv.PORT`). */
const API = 'http://localhost:3000/api/v1';

/** Per-run unique identity — no credential is ever reused across runs (§8). */
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const password = `Browser-Session-${runId}`;
const journeyEmail = `journey-${runId}@example.com`;
const loginEmail = `login-${runId}@example.com`;
const isolationOwnerEmail = `owner-${runId}@example.com`;
const isolationViewerEmail = `viewer-${runId}@example.com`;
const headersEmail = `headers-${runId}@example.com`;
const throttleEmail = `throttle-${runId}@example.com`;

function dashboardNav(page: Page) {
  return page.getByRole('navigation', { name: 'Dashboard' });
}

/** Registers through the API (D4 allows UI/API setup) and returns the token. */
async function registerViaApi(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.post(`${API}/auth/register`, {
    data: { email, password },
  });
  expect(response.ok(), `register ${email} → ${response.status()}`).toBeTruthy();
  const session = (await response.json()) as { access_token?: string };
  expect(session.access_token).toBeTruthy();
  return session.access_token as string;
}

/** Creates a project for the caller's default organization and returns it. */
async function createProjectViaApi(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const organizations = await request.get(`${API}/organizations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(organizations.ok()).toBeTruthy();
  const orgs = (await organizations.json()) as { data: { id: string }[] };
  const organizationId = orgs.data[0]?.id;
  expect(organizationId).toBeTruthy();

  const created = await request.post(`${API}/projects`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { organization_id: organizationId, name },
  });
  expect(created.ok(), `project create → ${created.status()}`).toBeTruthy();
  const project = (await created.json()) as { id: string; name: string };
  expect(project.id).toBeTruthy();
  return project;
}

test.describe('browser critical flows (phase 17 §12.5, C7)', () => {
  test('public home navigates to product and docs (§12.5: public → docs)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'BrinnPay' })).toBeVisible();

    await page.getByRole('navigation', { name: 'Public' }).getByRole('link', { name: 'Product' }).click();
    await expect(page).toHaveURL(/\/product$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Product' })).toBeVisible();

    await page.getByRole('navigation', { name: 'Public' }).getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Documentation' })).toBeVisible();

    // A docs guide is reachable from the documentation surface (C8 target).
    await page
      .getByRole('navigation', { name: 'Documentation' })
      .getByRole('link', { name: 'Quickstart', exact: true })
      .click();
    await expect(page).toHaveURL(/\/docs\/quickstart$/);
    await expect(page.getByRole('heading', { level: 1, name: /quickstart/i })).toBeVisible();
  });

  test('register → dashboard → project → payment with scenario → API key once → logout', async ({
    page,
  }) => {
    const projectName = `Browser journey ${runId}`;

    // §12.5: register through the public flow.
    await page.goto('/register');
    await page.getByLabel(/email/i).fill(journeyEmail);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /register/i }).click();
    await page.waitForURL(/\/dashboard$/);
    await expect(dashboardNav(page)).toBeVisible();

    // Dashboard → Projects → create a project (state through the UI, D4).
    await dashboardNav(page).getByRole('link', { name: 'Projects' }).click();
    await expect(page).toHaveURL(/\/dashboard\/projects$/);
    await page.getByLabel('Name', { exact: true }).fill(projectName);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const projectLink = page.getByRole('link', { name: projectName });
    await expect(projectLink).toBeVisible();
    await projectLink.click();
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();

    // A customer, so the payment form has a customer to select.
    await page.getByRole('link', { name: 'Customers', exact: true }).click();
    await expect(page).toHaveURL(/\/customers(\?|$)/);
    await page.getByLabel(/^email$/i).fill(journeyEmail);
    await page.getByRole('button', { name: 'Create customer', exact: true }).click();
    await expect(page.getByText(journeyEmail)).toBeVisible();

    // Payments: create with the scenario field exercised, then observe the
    // terminal status through the page's own polling (condition-based, no
    // sleeps — the simulation delays are near-zero for this run).
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
    await page.getByRole('link', { name: 'Payments', exact: true }).click();
    await expect(page).toHaveURL(/\/payments(\?|$)/);
    const createForm = page.getByRole('form', { name: 'Create payment' });
    await expect(createForm).toBeVisible();

    const scenario = createForm.getByRole('combobox', { name: 'Scenario' });
    await expect(scenario).toBeVisible();
    const scenarioValues = await scenario
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(scenarioValues).toEqual(['succeed', 'decline', 'timeout']);
    await scenario.selectOption('succeed');
    await createForm.getByRole('combobox', { name: 'Customer' }).selectOption({
      label: journeyEmail,
    });
    await createForm.getByLabel('Amount (USD)').fill('12.50');
    await createForm.getByRole('button', { name: 'Create payment' }).click();

    // Status observed: pending → succeeded via the page's interval refresh.
    await expect(page.getByText('succeeded')).toBeVisible({ timeout: 20_000 });

    // API key: created and shown exactly once, then never again.
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
    await page.getByRole('link', { name: 'API keys', exact: true }).click();
    await expect(page).toHaveURL(/\/api-keys(\?|$)/);
    await page.getByRole('button', { name: 'Create key' }).click();
    const revealed = page.getByRole('region', { name: 'New API key' });
    await expect(revealed).toBeVisible();
    const plaintext = (await revealed.locator('code').textContent()) ?? '';
    expect(plaintext).toMatch(/^sk_test_/);
    await expect(revealed).toContainText(/only time this key is shown/i);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(revealed).toHaveCount(0);

    // Reload: the key is never re-fetched or re-displayed (shown-once rule).
    await page.reload();
    await expect(page.locator('body')).not.toContainText(plaintext);
    await expect(page.locator('body')).toContainText(/create api key/i);

    // §12.5: logout returns to the public login surface.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible();
  });

  test('an existing account logs in from the public form (§12.5: login)', async ({
    page,
    request,
  }) => {
    // Self-contained state: its own account, created through the API (D4).
    await registerViaApi(request, loginEmail);

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(loginEmail);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /log in/i }).click();

    await page.waitForURL(/\/dashboard$/);
    await expect(dashboardNav(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('the dashboard redirects to login without a session (§12.5: 401/redirect)', async ({
    page,
  }) => {
    // Fresh context: no cookies, no token — the guard must bounce the visit
    // to the login surface and never render authenticated content.
    await page.goto('/dashboard');
    await page.waitForURL(/\/login$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible();
    await expect(dashboardNav(page)).toHaveCount(0);
  });

  test('a second user cannot reach another tenant\'s project (§9 rule 6: isolation)', async ({
    page,
    request,
  }) => {
    // Owner side (API): an account and its project — the protected resource.
    const ownerToken = await registerViaApi(request, isolationOwnerEmail);
    const ownerProject = await createProjectViaApi(
      request,
      ownerToken,
      `Owner only ${runId}`,
    );

    // Viewer side (browser): a different user, registered through the UI.
    await page.goto('/register');
    await page.getByLabel(/email/i).fill(isolationViewerEmail);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /register/i }).click();
    await page.waitForURL(/\/dashboard$/);

    // Direct URL to the other tenant's project: the API's 404 semantics are
    // presented as not-found, without disclosing the resource (no IDOR leak).
    await page.goto(`/dashboard/projects/${ownerProject.id}`);
    await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(ownerProject.name);
    await expect(page.locator('body')).not.toContainText(isolationOwnerEmail);
  });

  /**
   * §9 rule 3 — the posture the suite exists to protect is **asserted**, not
   * assumed: the refresh cookie's flags as the API really sets them, and the
   * security headers as the built web app really serves them (phase 14 §7.5,
   * ADR-0028), on a public route and on an authenticated dashboard route.
   */
  test('sets a hardened refresh cookie and serves the security headers (§9 rule 3)', async ({
    page,
    request,
  }) => {
    // Self-contained session (D4): its own account, registered through the API.
    await registerViaApi(request, headersEmail);

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(headersEmail);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /log in/i }).click();
    await page.waitForURL(/\/dashboard$/);

    // Cookie posture (phase 3 §5): read from the browser context for the API
    // origin — Playwright sees `HttpOnly` cookies, the page itself never does.
    const cookies = await page.context().cookies(`${API}/auth/refresh`);
    const refreshCookie = cookies.find((cookie) => cookie.name === 'brinnpay_refresh');
    expect(refreshCookie, 'the refresh cookie is set after login').toBeTruthy();
    expect(refreshCookie?.httpOnly).toBe(true);
    expect(refreshCookie?.sameSite).toBe('Lax');
    expect(refreshCookie?.secure).toBe(true);

    // Headers as served on the public surface and on an authenticated
    // dashboard route (the document response, before any client-side work).
    for (const path of ['/', '/dashboard']) {
      const response = await page.goto(path);
      expect(response, `document response for ${path}`).toBeTruthy();
      const headers = response?.headers() ?? {};
      expect(headers['x-content-type-options'], `X-Content-Type-Options on ${path}`).toBe(
        'nosniff',
      );
      expect(headers['x-frame-options'], `X-Frame-Options on ${path}`).toBe('DENY');
      expect(headers['referrer-policy'], `Referrer-Policy on ${path}`).toBe(
        'strict-origin-when-cross-origin',
      );
      expect(headers['content-security-policy'], `Content-Security-Policy on ${path}`).toContain(
        "default-src 'self'",
      );
    }
  });

  // Declared last on purpose: it exhausts the shared per-IP write budget
  // (RATE_LIMIT_WRITE_MAX for this run) to surface a real throttled response.
  // No test depends on its output, and nothing runs after it in this file.
  test('a throttled write is presented as retryable with the delay (§12.5: 429)', async ({
    page,
    request,
  }) => {
    // Self-contained session for the hammering that follows.
    await registerViaApi(request, throttleEmail);

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(throttleEmail);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /log in/i }).click();
    await page.waitForURL(/\/dashboard$/);

    await page.goto('/dashboard/organizations');
    const nameInput = page.getByLabel('Name', { exact: true });
    const throttleAlert = page
      .getByRole('alert')
      .filter({ hasText: /too many requests/i });

    // Attempt until the real 429 surfaces through the UI. Each attempt waits
    // on the condition (bounded deadline) — no sleeps; the bounded loop
    // guarantees termination either way and the final assertion is the test.
    let presented = false;
    for (let attempt = 0; attempt < 15 && !presented; attempt += 1) {
      await nameInput.fill(`Throttle probe ${runId}-${attempt}`);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      presented = await throttleAlert
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
    }

    await expect(throttleAlert).toBeVisible();
    // Phase 14 §7.3: 429 reads as retryable and transient, carrying the
    // indicated delay — never as an authorization or data failure.
    await expect(page.getByRole('alert').filter({ hasText: /try again/i })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/session has expired/i);
  });
});
