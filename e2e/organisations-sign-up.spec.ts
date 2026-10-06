import { test, expect, type Page } from "@playwright/test";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { ACME, ORGANISATIONS_API, asOrganisation, originOf, seedTwoOrganisations } from "./organisations";
import { apiCode, freshAddress, provideAddressAndCode, withDb } from "./platform-sign-in";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const PASSWORD = "initech-password-1";

async function fillTheForm(page: Page, name: string, fields: { slug?: string; username?: string } = {}) {
  await page.getByRole("button", { name: "Create an organisation" }).click();
  await page.getByLabel("Organisation name").fill(name);
  if (fields.slug !== undefined) await page.getByLabel("Address").fill(fields.slug);
  await page.getByLabel("Your name").fill("Bill Lumbergh");
  if (fields.username !== undefined) await page.getByLabel("Username").fill(fields.username);
  await page.getByLabel("Password").fill(PASSWORD);
}

const organisationWithSlug = (slug: string) => withDb((db) => db.collection("organisations").findOne({ slug }));

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

// BP-673: a stranger with a proven address gets an organisation of their own and is its administrator
test.describe("BP-673: creating an organisation from the platform host", () => {
  test("a new address proves itself, names an organisation, and lands in it as its administrator, with the agent catalog seeded", async ({ page }) => {
    const email = freshAddress("bill");
    await provideAddressAndCode(page, email);
    await expect(page.getByTestId("no-organisations")).toBeVisible();

    await fillTheForm(page, "Initech Systems");
    await expect(page.getByLabel("Address")).toHaveValue("initech-systems");
    await expect(page.getByLabel("Username")).toHaveValue(/^bill-/);
    await page.screenshot({ path: "e2e/.artifacts/bp673-form.png" });
    await page.getByRole("button", { name: "Create the organisation" }).click();

    await page.waitForURL(`${originOf("initech-systems")}/projects`);
    await expect(page.getByRole("button", { name: /Account menu/ })).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp673-landed.png" });

    const organisation = await organisationWithSlug("initech-systems");
    expect(organisation?.name).toBe("Initech Systems");
    const admin = await withDb((db) => db.collection("users").findOne({ organisation: organisation!._id, email }));
    expect(admin).toMatchObject({ role: "admin", kind: "human", emailVouchedByAdmin: false });
    expect(admin?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await withDb((db) => db.collection("agents").countDocuments({ organisation: organisation!._id }))).toBeGreaterThan(0);

    const me = await page.request.get(`${originOf("initech-systems")}/api/projects`);
    expect(me.status()).toBe(200);
    expect(JSON.stringify(await me.json())).not.toContain(ACME.projectName);
  });

  test("an address already taken, or reserved, is unavailable in the same words, and a malformed one says the rule", async ({ page }) => {
    const email = freshAddress("taken");
    await provideAddressAndCode(page, email);

    for (const slug of [ACME.slug, "login"]) {
      await fillTheForm(page, "Copycat", { slug });
      await page.getByRole("button", { name: "Create the organisation" }).click();
      await expect(page.getByTestId("sign-in-error")).toHaveText("That address is not available. Try another.");
      await page.getByRole("button", { name: "Back" }).click();
    }

    await fillTheForm(page, "Copycat", { slug: "-x" });
    await page.getByRole("button", { name: "Create the organisation" }).click();
    await expect(page.getByTestId("sign-in-error")).toHaveText(/3 to 40 lowercase letters/);
    expect(await withDb((db) => db.collection("organisations").countDocuments({ name: "Copycat" }))).toBe(0);
  });

  test("someone with an organisation already can create another, and both stay theirs", async ({ page }) => {
    const email = freshAddress("both");
    await withDb((db) => db.collection("users").updateOne({ _id: ACME.adminId }, { $set: { email, emailVerifiedAt: new Date() } }));

    await provideAddressAndCode(page, email);
    await expect(page.getByText("Signing in to Acme")).toBeVisible();
    await page.getByRole("button", { name: "Create another organisation" }).click();
    await page.getByLabel("Organisation name").fill("Second Shop");
    await page.getByLabel("Your name").fill("Boss");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create the organisation" }).click();
    await page.waitForURL(`${originOf("second-shop")}/projects`);
  });

  test("it exists on the platform host only, needs a proven address, and an address creates three a day", async ({ request }) => {
    expect((await request.post(`${ORGANISATIONS_API}/api/sign-in/organisation`, { headers: asOrganisation(ACME), data: {} })).status()).toBe(404);

    const email = freshAddress("many");
    for (let n = 1; n <= 4; n++) {
      const signedIn = await apiCode(request, email);
      const created = await request.post(`${ORGANISATIONS_API}/api/sign-in/organisation`, {
        headers: signedIn,
        data: { name: `Shop ${n}`, slug: `shop-${n}-${Date.now()}`, fullName: "Owner", username: "owner", password: PASSWORD },
      });
      expect(created.status(), `organisation ${n}`).toBe(n <= 3 ? 201 : 429);
      const again = await request.post(`${ORGANISATIONS_API}/api/sign-in/organisation`, {
        headers: signedIn,
        data: { name: "Again", slug: `again-${n}-${Date.now()}`, fullName: "Owner", username: "owner", password: PASSWORD },
      });
      if (n <= 3) expect(again.status(), "a sign-in is spent by the organisation it created").toBe(401);
    }
  });

  test("on a phone the form fits the screen", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await provideAddressAndCode(page, freshAddress("phone"));
    await fillTheForm(page, "A Very Long Organisation Name For A Small Screen");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: "e2e/.artifacts/bp673-phone.png" });
  });
});
