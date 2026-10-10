import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { ACME, ORGANISATIONS_API, asOrganisation, originOf, seedTwoOrganisations } from "./organisations";
import { apiCode, freshAddress, provideAddressAndCode, withDb } from "./platform-sign-in";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const VERSION = "2026-10-15";
const REFUSAL = "Accept the Terms of Service and the Privacy Policy to create an account.";
const PASSWORD = "initech-password-1";
const SHOTS = "e2e/.artifacts";

const publish = async (request: APIRequestContext, version: string | undefined) =>
  expect((await request.post(`${ORGANISATIONS_API}/api/e2e/legal-terms`, { data: { version } })).status()).toBe(204);

async function invite(email: string) {
  const token = `cpi_${randomBytes(32).toString("hex")}`;
  await withDb((db) =>
    db.collection("invitations").insertOne({
      organisation: ACME.organisation,
      email,
      role: "member",
      boards: [],
      invitedBy: ACME.adminId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      status: "pending",
      acceptedBy: null,
      acceptedAt: null,
      deliveredAs: "email",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );
  return token;
}

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  await publish(request, VERSION);
});

test.afterAll(async ({ request }) => {
  await publish(request, undefined);
});

test.describe("BP-939: the cloud terms", () => {
  test("creating an organisation asks for an unticked box, the server refuses without it, and the acceptance is stored", async ({ page, request }) => {
    const refusedEmail = freshAddress("refused");
    const refused = await request.post(`${ORGANISATIONS_API}/api/sign-in/organisation`, {
      headers: await apiCode(request, refusedEmail),
      data: { name: "No Terms", slug: `no-terms-${Date.now()}`, fullName: "Owner", username: "owner", password: PASSWORD },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toBe(REFUSAL);
    expect(await withDb((db) => db.collection("organisations").countDocuments({ name: "No Terms" }))).toBe(0);

    const email = freshAddress("bill");
    await provideAddressAndCode(page, email);
    await page.getByRole("button", { name: "Create an organisation" }).click();
    await page.getByLabel("Organisation name").fill("Initech Terms");
    await page.getByLabel("Your name").fill("Bill Lumbergh");
    await page.getByLabel("Password").fill(PASSWORD);

    const box = page.getByTestId("accept-terms").getByRole("checkbox");
    await expect(box).not.toBeChecked();
    await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "https://board-planner.com/legal/terms");
    await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "https://board-planner.com/legal/privacy");
    await expect(page.getByRole("link", { name: "Polski" })).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/bp939-sign-up.png`, fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: `${SHOTS}/bp939-sign-up-phone.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByRole("button", { name: "Create the organisation" }).click();
    expect(await box.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    await expect(page.getByTestId("create-organisation")).toBeVisible();

    await box.check();
    const created = page.waitForResponse((r) => r.url().endsWith("/api/sign-in/organisation"));
    await page.getByRole("button", { name: "Create the organisation" }).click();
    expect((await created).status()).toBe(201);
    await page.waitForURL(`${originOf("initech-terms")}/projects`);

    const [organisation, admin] = await withDb(async (db) => {
      const row = await db.collection("organisations").findOne({ slug: "initech-terms" });
      return [row, await db.collection("users").findOne({ organisation: row!._id, email })];
    });
    expect(admin).toMatchObject({ termsAcceptedVersion: VERSION });
    expect(admin!.termsAcceptedAt).toBeInstanceOf(Date);
    expect(organisation).toMatchObject({ termsAcceptedVersion: VERSION, termsAcceptedAt: admin!.termsAcceptedAt });
    expect(String(organisation!.termsAcceptedBy)).toBe(String(admin!._id));
  });

  test("accepting an invitation asks for the box, the server refuses without it and keeps the link, and stores the version", async ({ page, request }) => {
    const email = freshAddress("invitee");
    const token = await invite(email);

    const refused = await request.post(`${ORGANISATIONS_API}/api/invitations/accept`, {
      headers: asOrganisation(ACME),
      data: { token, username: "invitee", fullName: "In Vitee", password: "a-long-password" },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toBe(REFUSAL);
    expect(await withDb((db) => db.collection("invitations").findOne({ email }))).toMatchObject({ status: "pending" });

    await page.goto(`${originOf(ACME)}/invite?token=${token}`);
    await page.getByLabel("Username").fill("invitee");
    await page.getByLabel("Full name").fill("In Vitee");
    await page.getByLabel("Password", { exact: true }).fill("a-long-password");
    await page.getByLabel("Confirm password").fill("a-long-password");
    const box = page.getByTestId("accept-terms").getByRole("checkbox");
    await expect(box).not.toBeChecked();
    await box.check();
    const accepted = page.waitForResponse((r) => r.url().endsWith("/api/invitations/accept"));
    await page.getByRole("button", { name: "Create my account" }).click();
    expect((await accepted).status()).toBe(201);
    await page.waitForURL(/\/projects/);

    const user = await withDb((db) => db.collection("users").findOne({ organisation: ACME.organisation, email }));
    expect(user).toMatchObject({ username: "invitee", termsAcceptedVersion: VERSION });
    expect(user!.termsAcceptedAt).toBeInstanceOf(Date);
  });
});
