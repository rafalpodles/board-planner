import { test, expect, type APIRequestContext } from "@playwright/test";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import {
  ACME,
  GLOBEX,
  PLATFORM_HOST,
  SHARED_KEY,
  ORGANISATIONS_API,
  USERNAME,
  asOrganisation,
  bearer,
  oauthBearer,
  hostOf,
  originOf,
  seedTwoOrganisations,
  signInOn,
} from "./organisations";

const SKIP_REASON = "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1";
test.skip(!RUN_ORGANISATIONS_SERVER, SKIP_REASON);

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

const get = (request: APIRequestContext, path: string, headers: Record<string, string>) =>
  request.get(`${ORGANISATIONS_API}${path}`, { headers });

test.describe("BP-670: two organisations on one instance, each on its own subdomain", () => {
  test("a token lists its own organisation's projects on its own host", async ({ request }) => {
    for (const [who, other] of [
      [ACME, GLOBEX],
      [GLOBEX, ACME],
    ] as const) {
      const res = await get(request, "/api/projects", { ...asOrganisation(who), ...bearer(who) });
      expect(res.status(), who.slug).toBe(200);
      const names = ((await res.json()) as { name: string }[]).map((p) => p.name);
      expect(names, who.slug).toContain(who.projectName);
      expect(names, who.slug).not.toContain(other.projectName);
    }
  });

  test("an OAuth access token works on its own organisation's host and is no credential on the other's", async ({ request }) => {
    const own = await get(request, "/api/projects", { ...asOrganisation(ACME), ...oauthBearer(ACME) });
    expect(own.status()).toBe(200);
    expect(JSON.stringify(await own.json())).toContain(ACME.projectName);

    expect((await get(request, "/api/projects", { ...asOrganisation(GLOBEX), ...oauthBearer(ACME) })).status()).toBe(401);
  });

  test("notifications: each person's bell holds only their own organisation's, and nobody marks another's read", async ({ request }) => {
    const bell = async (who: typeof ACME) =>
      JSON.stringify(await (await get(request, "/api/notifications", { ...asOrganisation(who), ...bearer(who) })).json());

    expect(await bell(ACME)).toContain("acme notice");
    expect(await bell(GLOBEX)).not.toContain("acme notice");

    const marked = await request.patch(`${ORGANISATIONS_API}/api/notifications/read`, {
      headers: { ...asOrganisation(GLOBEX), ...bearer(GLOBEX), "content-type": "application/json" },
      data: { id: String(ACME.notificationId) },
    });
    expect(marked.status()).toBeLessThan(500);
    const acmeRows = JSON.parse(await bell(ACME)) as { notifications?: { _id: string; read: boolean }[] } | { _id: string; read: boolean }[];
    const rows = Array.isArray(acmeRows) ? acmeRows : acmeRows.notifications ?? [];
    expect(rows.find((row) => row._id === String(ACME.notificationId))?.read).toBe(false);
  });

  test("a token is no credential on another organisation's host", async ({ request }) => {
    const res = await get(request, "/api/projects", { ...asOrganisation(GLOBEX), ...bearer(ACME) });
    expect(res.status()).toBe(401);
  });

  test("a host that names no organisation, and the platform host, answer 404 before anything else", async ({ request }) => {
    for (const host of [`nobody.organisations.localhost:${hostOf(ACME).split(":")[1]}`, PLATFORM_HOST]) {
      const res = await get(request, "/api/projects", { host, "sec-fetch-site": "same-origin", ...bearer(ACME) });
      expect(res.status(), host).toBe(404);
    }
  });

  test("the same project key in both organisations names each one's own board", async ({ request }) => {
    for (const who of [ACME, GLOBEX]) {
      const res = await get(request, `/api/projects/${SHARED_KEY}`, { ...asOrganisation(who), ...bearer(who) });
      expect(res.status(), who.slug).toBe(200);
      expect((await res.json()).name, who.slug).toBe(who.projectName);
    }
  });

  test("another organisation's project id is not there, even for an admin", async ({ request }) => {
    const foreign = await get(request, `/api/projects/${GLOBEX.projectId}`, { ...asOrganisation(ACME), ...bearer(ACME) });
    const missing = await get(request, "/api/projects/e2e0000000000000000ff0ff", { ...asOrganisation(ACME), ...bearer(ACME) });
    expect(foreign.status()).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
  });

  test("the same username signs in to each organisation with that organisation's password only", async ({ request }) => {
    const login = (who: typeof ACME, password: string) =>
      request.post(`${ORGANISATIONS_API}/api/auth/login`, {
        headers: { ...asOrganisation(who), origin: originOf(who), "content-type": "application/json" },
        data: { username: USERNAME, password },
      });

    expect((await login(ACME, ACME.password)).status()).toBe(200);
    expect((await login(GLOBEX, GLOBEX.password)).status()).toBe(200);
    expect((await login(ACME, GLOBEX.password)).status()).toBe(401);
    expect((await login(GLOBEX, ACME.password)).status()).toBe(401);
  });

  test("/me answers on its own host and refuses the session on another", async ({ request }) => {
    const cookie = (who: typeof ACME) => ({ cookie: `__Host-bp_session=${who.sessionToken}` });

    const home = await get(request, "/api/auth/me", { ...asOrganisation(ACME), ...cookie(ACME) });
    expect(home.status()).toBe(200);
    expect((await home.json()).username).toBe(USERNAME);

    expect((await get(request, "/api/auth/me", { ...asOrganisation(GLOBEX), ...cookie(ACME) })).status()).toBe(401);
  });

  test("on screen: signed in to one organisation, its board is there and the other's is not", async ({ page }) => {
    await signInOn(page.context(), ACME);

    await page.goto(`${originOf(ACME)}/projects`);
    await expect(page.getByText(ACME.projectName).first()).toBeVisible();
    await expect(page.getByText(GLOBEX.projectName)).toHaveCount(0);
  });

  test("on screen: the session cookie of one organisation is not sent to the other's host", async ({ page }) => {
    await signInOn(page.context(), ACME);

    await page.goto(`${originOf(GLOBEX)}/projects`);
    await expect(page).toHaveURL(/\/login/);
  });

  test("on screen: signing in through the form on one host lands on that organisation", async ({ page }) => {
    await page.goto(`${originOf(GLOBEX)}/login`);
    await page.getByLabel("Username").fill(USERNAME);
    await page.getByLabel("Password").fill(GLOBEX.password);
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page).not.toHaveURL(/\/login/);
    await page.goto(`${originOf(GLOBEX)}/projects`);
    await expect(page.getByText(GLOBEX.projectName).first()).toBeVisible();
    await expect(page.getByText(ACME.projectName)).toHaveCount(0);
  });
});
