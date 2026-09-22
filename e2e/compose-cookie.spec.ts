import { test, expect, type Page } from "@playwright/test";
import { BASE_URL, PROXIED_BASE_URL, RUN_PROXIED_SERVER } from "../playwright.config";
import { ADMIN_PASSWORD, ADMIN_USERNAME, seedWithoutSessions } from "./seed";
import { SAME_ORIGIN } from "./api";

/**
 * BP-773. docker-compose.yml used to default COOKIE_ALLOW_INSECURE to 1, so a compose instance
 * moved behind TLS kept issuing a plain cookie unless somebody set it to 0 — and an empty value
 * became 1 as well. It now passes "auto": a plain cookie only while the instance's own origins are
 * http://. The proxied server runs with exactly what compose passes (see playwright.config.ts), so
 * this signs in there the way a person on a plain-HTTP compose deployment does. The https half is
 * in src/lib/session.test.ts: this suite has no TLS to serve it over.
 */

const SKIP_REASON =
  "needs the proxied app server — set E2E_PROXIED_SERVER=1 (see playwright.config.ts, PROXIED_BASE_URL)";
if (!RUN_PROXIED_SERVER) console.log(`compose-cookie.spec.ts: skipping — ${SKIP_REASON}`);
test.skip(!RUN_PROXIED_SERVER, SKIP_REASON);

test.beforeEach(async () => {
  await seedWithoutSessions();
});

async function signInAt(page: Page, origin: string) {
  const login = page.waitForResponse(
    (res) => res.url() === `${origin}/api/auth/login` && res.request().method() === "POST"
  );
  await page.goto(`${origin}/login`);
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  expect((await login).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`^${origin}/projects`));
}

test("a plain-HTTP compose instance signs in with a cookie the browser keeps", async ({ page }) => {
  await signInAt(page, PROXIED_BASE_URL);

  const session = (await page.context().cookies(PROXIED_BASE_URL)).filter((c) =>
    c.name.endsWith("bp_session")
  );
  expect(session).toEqual([expect.objectContaining({ name: "bp_session", secure: false })]);
  expect((await page.request.get(`${PROXIED_BASE_URL}/api/auth/me`)).status()).toBe(200);
  await expect(page.getByRole("link", { name: /projects/i }).first()).toBeVisible();
});

// The control: the same sign-in against the server with no COOKIE_ALLOW_INSECURE at all gets the
// secure, prefixed cookie, so the plain one above is the mode's doing and not the suite's.
test("an instance with nothing set still issues the secure, prefixed cookie", async ({ page }) => {
  await signInAt(page, BASE_URL);

  const session = (await page.context().cookies(BASE_URL)).filter((c) => c.name.endsWith("bp_session"));
  expect(session).toEqual([expect.objectContaining({ name: "__Host-bp_session", secure: true })]);
});

// The review's residual case: the same compose instance, origins still at their localhost
// defaults, reached through a TLS proxy. This suite has no TLS to sign in over, so the sign-in is
// the request a browser on https sends — its Origin — and the answer is read off the wire.
test("the same instance, signed into over https, issues the secure, prefixed cookie", async ({
  request,
}) => {
  const response = await request.post(`${PROXIED_BASE_URL}/api/auth/login`, {
    headers: { ...SAME_ORIGIN, Origin: "https://board.example.com" },
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });

  expect(response.status()).toBe(200);
  const cookies = response
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value);
  expect(cookies[0]).toMatch(/^__Host-bp_session=cps_[^;]+; .*; Secure$/);
  expect(cookies[1]).toMatch(/^bp_session=; .*Max-Age=0/);
});
