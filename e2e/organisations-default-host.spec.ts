import { test, expect } from "@playwright/test";
import { ORGANISATIONS_DEFAULT_HOST, ORGANISATIONS_PORT, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { ADMIN_PASSWORD, ADMIN_USERNAME, API_TOKEN, PROJECT_KEY, PROJECT_NAME } from "./seed";
import { ACME, ORGANISATIONS_API, SHARED_KEY, asOrganisation, bearer, originOf, seedTwoOrganisations } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const DEFAULT_HOST = `${ORGANISATIONS_DEFAULT_HOST}:${ORGANISATIONS_PORT}`;
const DEFAULT_ORIGIN = `http://${DEFAULT_HOST}`;
const onDefault = { host: DEFAULT_HOST };

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

// BP-671: production keeps app.board-planner.com when organisations move to subdomains, so nobody notices
test.describe("BP-671: the default organisation keeps its host", () => {
  test("on screen: its people sign in on app. as before and see their boards, and only theirs", async ({ page }) => {
    await page.goto(`${DEFAULT_ORIGIN}/login`);
    await page.getByLabel("Username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/projects/);

    await page.goto(`${DEFAULT_ORIGIN}/projects/${PROJECT_KEY}`);
    await expect(page.getByText(PROJECT_NAME).first()).toBeVisible();
    await page.goto(`${DEFAULT_ORIGIN}/projects/${SHARED_KEY}`);
    await expect(page.getByText(ACME.projectName)).toHaveCount(0);
    await page.screenshot({ path: "e2e/.artifacts/bp671-default-host.png" });
  });

  test("its tokens work on app. and nowhere else, and another organisation's work nowhere on app.", async ({ request }) => {
    const own = await request.get(`${ORGANISATIONS_API}/api/projects`, { headers: { ...onDefault, authorization: `Bearer ${API_TOKEN}` } });
    expect(own.status()).toBe(200);
    expect(JSON.stringify(await own.json())).toContain(PROJECT_NAME);

    expect((await request.get(`${ORGANISATIONS_API}/api/projects`, { headers: { ...asOrganisation(ACME), authorization: `Bearer ${API_TOKEN}` } })).status()).toBe(401);
    expect((await request.get(`${ORGANISATIONS_API}/api/projects`, { headers: { ...onDefault, ...bearer(ACME) } })).status()).toBe(401);
  });

  test("the documents an MCP client follows, and the links the app builds, name app.", async ({ request }) => {
    const discovery = await request.get(`${ORGANISATIONS_API}/.well-known/oauth-protected-resource`, { headers: onDefault });
    expect(discovery.status()).toBe(200);
    expect((await discovery.json()).resource).toBe(DEFAULT_ORIGIN);

    const acme = await request.get(`${ORGANISATIONS_API}/.well-known/oauth-protected-resource`, { headers: asOrganisation(ACME) });
    expect((await acme.json()).resource).toBe(originOf(ACME));
  });

  test("app. is an organisation's host, not the platform's", async ({ request }) => {
    expect((await request.get(`${ORGANISATIONS_API}/api/platform/organisations`, { headers: onDefault })).status()).toBe(404);
  });
});
