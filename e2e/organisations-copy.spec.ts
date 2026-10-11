import { test, expect } from "@playwright/test";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { ACME, GLOBEX, ORGANISATIONS_API, asOrganisation, originOf, seedTwoOrganisations, signInOn } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

/**
 * BP-922. What somebody in the cloud is told about where they are: the sign-in page names the organisation it
 * belongs to, the settings header names the one an admin runs, and neither says "instance".
 */
test("the host says which organisation it is, to somebody who has not signed in", async ({ request }) => {
  for (const [who, name] of [
    [ACME, "Acme"],
    [GLOBEX, "Globex"],
  ] as const) {
    const answer = await request.get(`${ORGANISATIONS_API}/api/auth/instance`, { headers: asOrganisation(who) });
    expect(await answer.json(), who.slug).toMatchObject({ cloud: true, organisation: name });
  }
});

test("the sign-in page of an organisation is signed in to by name, and the other's is its own", async ({ browser }) => {
  for (const [who, name] of [
    [ACME, "Acme"],
    [GLOBEX, "Globex"],
  ] as const) {
    const page = await browser.newPage();
    await page.goto(`${originOf(who)}/login`);
    await expect(page.getByRole("heading", { name: `Sign in to ${name}` })).toBeVisible();
    await page.close();
  }
});

test("an admin's settings header names the organisation, not the instance", async ({ browser }) => {
  const context = await browser.newContext();
  await signInOn(context, ACME);
  const page = await context.newPage();
  await page.goto(`${originOf(ACME)}/settings/profile`);

  await expect(page.getByText("Your account and Acme", { exact: true })).toBeVisible();
  await expect(page.getByText("This account and this instance")).toHaveCount(0);
  await context.close();
});
