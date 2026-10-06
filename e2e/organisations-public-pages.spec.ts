import { test, expect, type APIRequestContext } from "@playwright/test";
import { ORGANISATION_DOMAIN, ORGANISATIONS_PORT, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { E2E_PLATFORM_REQUEST_KEY } from "./licence-key";
import { GLOBEX, ORGANISATIONS_API, PLATFORM_HOST, asOrganisation, originOf, seedTwoOrganisations } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const SIGN_IN = `http://login.${ORGANISATION_DOMAIN}:${ORGANISATIONS_PORT}`;

function suspend(request: APIRequestContext) {
  const path = `/api/platform/organisations/${GLOBEX.organisation.toHexString()}/suspend`;
  const body = Buffer.from(JSON.stringify({ reason: "unpaid" }));
  const headers = signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path, body }, E2E_PLATFORM_REQUEST_KEY);
  return request.post(`${ORGANISATIONS_API}${path}`, { headers: { host: PLATFORM_HOST, "content-type": "application/json", ...headers }, data: body });
}

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

// BP-921: these pages took a 404 from a host with no organisation for "passwords are on" and offered a form that could only fail
test.describe("BP-921: public pages on a host that serves no organisation", () => {
  for (const path of ["/login", "/forgot", "/reset?token=x", "/invite?token=x"]) {
    test(`${path} on an address with no organisation says so and points at the sign-in by e-mail`, async ({ page }) => {
      await page.goto(`${originOf("nosuch")}${path}`);
      const screen = page.getByTestId("no-organisation-here");
      await expect(screen.getByRole("heading")).toHaveText(`There is no organisation at nosuch.${ORGANISATION_DOMAIN}:${ORGANISATIONS_PORT}`);
      await expect(screen.getByRole("link", { name: "Sign in with your e-mail address" })).toHaveAttribute("href", SIGN_IN);
      await expect(page.getByLabel("Password")).toHaveCount(0);
    });
  }

  test("the platform's own /login sends people to its front page", async ({ page }) => {
    await page.goto(`${SIGN_IN}/login`);
    await expect(page.getByTestId("no-organisation-here").getByRole("link")).toHaveAttribute("href", "/");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${originOf("nosuch")}/login`);
    await expect(page.getByTestId("no-organisation-here")).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp921-no-organisation-phone.png" });
  });

  test("a suspended organisation's public pages say it is suspended, and so do its public endpoints", async ({ page, request }) => {
    expect((await suspend(request)).status()).toBe(200);

    for (const path of ["/login", "/forgot", "/invite?token=x"]) {
      await page.goto(`${originOf(GLOBEX)}${path}`);
      await expect(page.getByRole("heading", { name: "This organisation is suspended" })).toBeFocused();
    }
    const instance = await request.get(`${ORGANISATIONS_API}/api/auth/instance`, { headers: asOrganisation(GLOBEX) });
    expect(instance.status()).toBe(503);
    for (const [endpoint, data] of [["/api/invitations/lookup", { token: "x" }], ["/api/auth/forgot", { identifier: "boss" }]] as const) {
      const answer = await request.post(`${ORGANISATIONS_API}${endpoint}`, { headers: asOrganisation(GLOBEX), data });
      expect(answer.status(), endpoint).toBe(503);
      expect(await answer.json()).toMatchObject({ suspended: true });
    }
  });
});
