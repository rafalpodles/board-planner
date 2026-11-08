import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { MAIL_SERVER, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { ACME, GLOBEX, makePro, originOf, seedTwoOrganisations, signInOn, type OrganisationFixture } from "./organisations";
import { bodyOf, mailFor, type StubMessage } from "./mailbox";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-899. In the cloud an organisation on Pro (or its trial) sends its people's mail through its own SMTP server, from its
 * own address, set on Settings → Email. The platform's server stays for everybody else. Both are the same SMTP stub here;
 * the login a message arrived with says which server's credentials carried it, and the envelope sender which address.
 */

const OWN = { user: "acme-mailer", password: "acme-smtp-password", fromAddress: "boards@acme.example", fromName: "Acme boards" };
const PLATFORM_FROM = MAIL_SERVER.from.match(/<(.+)>/)![1];
const addressOf = (who: OrganisationFixture) => `boss@${who.slug}.example`;

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

const storedServer = (who: OrganisationFixture) => withDb(async (db) => (await db.collection("settings").findOne({ organisation: who.organisation }))?.smtp);

async function openEmailSettings(page: Page, who: OrganisationFixture) {
  await signInOn(page.context(), who);
  const own = page.waitForResponse((response) => response.url().endsWith("/api/settings/smtp") && response.request().method() === "GET");
  await page.goto(`${originOf(who)}/settings/email`);
  expect((await own).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Your own mail server" })).toBeVisible();
}

async function fillServer(page: Page, server: { host: string; port: number; user: string; password: string; fromAddress: string; fromName: string }) {
  const form = page.getByTestId("smtp-form");
  await form.getByLabel("Host").fill(server.host);
  await form.getByLabel("Port").fill(String(server.port));
  await form.getByLabel("Username").fill(server.user);
  await form.getByLabel("Password").fill(server.password);
  await form.getByLabel("From address").fill(server.fromAddress);
  await form.getByLabel("Sender name (optional)").fill(server.fromName);
}

async function save(page: Page, label = "Save mail server") {
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/settings/smtp") && response.request().method() === "PUT");
  await page.getByRole("button", { name: label }).click();
  return answered;
}

/** The next message to arrive for an address, counted from before the action that sends it */
async function nextMailFor(address: string, send: () => Promise<unknown>): Promise<StubMessage> {
  const before = (await mailFor(address)).length;
  await send();
  await expect.poll(async () => (await mailFor(address)).length, { timeout: 15_000 }).toBeGreaterThan(before);
  return (await mailFor(address)).at(-1)!;
}

async function askForReset(page: Page, who: OrganisationFixture) {
  const visitor = await page.context().browser()!.newContext();
  const tab = await visitor.newPage();
  await tab.goto(`${originOf(who)}/forgot`);
  const answered = tab.waitForResponse((response) => response.url().endsWith("/api/auth/forgot"));
  await tab.getByLabel("Username or email").fill(addressOf(who));
  await tab.getByRole("button", { name: "Send the link" }).click();
  expect((await answered).status()).toBeLessThan(300);
  await visitor.close();
}

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

test.describe("BP-899: an organisation's own mail server", () => {
  test("an administrator of a Pro organisation sets it up, and its people's mail then leaves through it, from its address", async ({ page, request }) => {
    await makePro(request, ACME);
    await openEmailSettings(page, ACME);
    await expect(page.getByText("Not set up", { exact: true })).toBeVisible();

    await fillServer(page, { host: MAIL_SERVER.host, port: MAIL_SERVER.port, ...OWN });
    expect((await save(page)).status()).toBe(200);

    await expect(page.getByText("Mail server saved")).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
    await expect(page.getByText("Sent through your own mail server. This screen shows whether it works.")).toBeVisible();
    await expect(page.getByTestId("email-own-server")).toContainText(`${MAIL_SERVER.host}:${MAIL_SERVER.port}`);
    await expect(page.getByTestId("email-own-server")).toContainText(`${OWN.fromName} <${OWN.fromAddress}>`);
    await expect(page.getByTestId("smtp-form").getByLabel("Password")).toHaveValue("");
    await page.screenshot({ path: "e2e/.artifacts/bp899-own-mail-server.png", fullPage: true });

    // Sealed under the organisation, and nothing the page reads says the password
    const stored = await storedServer(ACME);
    expect(stored?.password).toMatch(/^enc:v3:/);
    expect(JSON.stringify(stored)).not.toContain(OWN.password);
    const answer = await page.evaluate(async () => (await fetch("/api/settings/smtp", { headers: { "x-e2e-direct": "1" } })).text());
    expect(answer).not.toContain(OWN.password);

    // The delivery test leaves through it
    const test = await nextMailFor(addressOf(ACME), async () => {
      const sent = page.waitForResponse((response) => response.url().endsWith("/api/admin/email") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Send a test message" }).click();
      expect((await sent).status()).toBe(200);
    });
    expect(test.user).toBe(OWN.user);
    expect(test.from).toBe(OWN.fromAddress);
    expect(bodyOf(test)).toContain(`${MAIL_SERVER.host}:${MAIL_SERVER.port}`);

    // So does a password reset somebody asks for on the organisation's sign-in page
    const reset = await nextMailFor(addressOf(ACME), () => askForReset(page, ACME));
    expect(reset.user).toBe(OWN.user);
    expect(reset.from).toBe(OWN.fromAddress);
    expect(reset.data).toContain(`From: ${OWN.fromName} <${OWN.fromAddress}>`);
    expect(bodyOf(reset)).toContain(`${originOf(ACME)}/reset`);

    // The control: an organisation with none of its own still sends through the platform's
    const elsewhere = await nextMailFor(addressOf(GLOBEX), () => askForReset(page, GLOBEX));
    expect(elsewhere.user).toBe(MAIL_SERVER.user);
    expect(elsewhere.from).toBe(PLATFORM_FROM);

    // Removing it, after a confirmation, puts the organisation's mail back on the platform's server
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    const removed = page.waitForResponse((response) => response.url().endsWith("/api/settings/smtp") && response.request().method() === "DELETE");
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
    expect((await removed).status()).toBe(200);
    await expect(page.getByText("Not set up", { exact: true })).toBeVisible();
    expect(await storedServer(ACME)).toBeUndefined();
    const after = await nextMailFor(addressOf(ACME), () => askForReset(page, ACME));
    expect(after.user).toBe(MAIL_SERVER.user);
    expect(after.from).toBe(PLATFORM_FROM);
  });

  test("a server that refuses the sign-in is said so, and nothing is stored", async ({ page, request }) => {
    await makePro(request, ACME);
    await openEmailSettings(page, ACME);

    await fillServer(page, { host: MAIL_SERVER.host, port: MAIL_SERVER.port, ...OWN, user: "refused" });
    expect((await save(page)).status()).toBe(400);

    await expect(page.getByRole("alert")).toContainText("535 5.7.8 Authentication credentials invalid");
    await expect(page.getByText("Not set up", { exact: true })).toBeVisible();
    expect(await storedServer(ACME)).toBeUndefined();
  });

  test("an address inside the platform's own network is refused before anything connects to it", async ({ page, request }) => {
    await makePro(request, ACME);
    await openEmailSettings(page, ACME);

    // The second is the same address written so that a decimal check reads it as public and the resolver as 10.0.0.5
    for (const host of ["10.0.0.5", "012.0.0.5"]) {
      await fillServer(page, { host, port: 587, ...OWN });
      expect((await save(page)).status(), host).toBe(400);

      await expect(page.getByRole("alert"), host).toContainText("not one this server may call");
      expect(await storedServer(ACME), host).toBeUndefined();
    }
  });

  test("a Free organisation is offered Pro instead of the form, and its save is refused", async ({ page }) => {
    await openEmailSettings(page, GLOBEX);

    await expect(page.getByTestId("smtp-upgrade")).toContainText("included in Pro and in the trial");
    await expect(page.getByTestId("smtp-form")).toHaveCount(0);
    const refused = await page.evaluate(async (server) => {
      const res = await fetch("/api/settings/smtp", { method: "PUT", headers: { "x-e2e-direct": "1", "Content-Type": "application/json" }, body: JSON.stringify(server) });
      return { status: res.status, body: await res.json() };
    }, { host: "127.0.0.1", port: 587, ...OWN });
    expect(refused).toMatchObject({ status: 402, body: { feature: "email.smtp", plan: "free" } });
    expect(await storedServer(GLOBEX)).toBeUndefined();
  });
});
