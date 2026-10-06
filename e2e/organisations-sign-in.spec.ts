import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ORGANISATIONS_PLATFORM_ORIGIN, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { mailFor } from "./mailbox";
import { ACME, GLOBEX, ORGANISATIONS_API, PLATFORM_HOST, asOrganisation, hostOf, originOf, seedTwoOrganisations, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

const onPlatform = { host: PLATFORM_HOST, "sec-fetch-site": "same-origin" };

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

const giveAddress = (who: OrganisationFixture, email: string, emailVerifiedAt: Date | null = new Date()) =>
  withDb((db) => db.collection("users").updateOne({ _id: who.adminId }, { $set: { email, emailVerifiedAt } }));

let sequence = 0;
const freshAddress = (name: string) => `${name}-${Date.now()}-${sequence++}@people.example`;

async function codeSentTo(email: string, previous = 0): Promise<string> {
  let code = "";
  await expect
    .poll(async () => {
      const messages = await mailFor(email);
      const match = messages.length > previous ? /(\d{6}) is your/.exec(messages[messages.length - 1].data) : null;
      code = match?.[1] ?? "";
      return code;
    })
    .toMatch(/^\d{6}$/);
  return code;
}

async function provideAddressAndCode(page: Page, email: string) {
  const before = (await mailFor(email)).length;
  await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
  await page.getByLabel("E-mail address").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(`We sent a code to ${email}`)).toBeVisible();
  await page.getByLabel("Code").fill(await codeSentTo(email, before));
  await page.getByRole("button", { name: "Continue" }).click();
}

// The cookie is Secure, which a browser sends to *.localhost and an API client never sends over http
async function apiCode(request: APIRequestContext, email: string): Promise<Record<string, string>> {
  const before = (await mailFor(email)).length;
  const started = await request.post(`${ORGANISATIONS_API}/api/sign-in/start`, { headers: onPlatform, data: { email } });
  expect(started.status()).toBe(200);
  const binder = /bp_platform_signin=([^;]+)/.exec(started.headers()["set-cookie"] ?? "")![1];
  const withBinder = { ...onPlatform, cookie: `__Host-bp_platform_signin=${binder}` };
  const code = await codeSentTo(email, before);
  expect((await request.post(`${ORGANISATIONS_API}/api/sign-in/verify`, { headers: withBinder, data: { code } })).status()).toBe(200);
  return withBinder;
}

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

// BP-919: one way in for everybody, at login., without knowing an organisation's address
test.describe("BP-919: signing in on the platform host, e-mail first", () => {
  test("an address with one organisation goes straight to its password, and lands signed in on that organisation's host", async ({ page }) => {
    const email = freshAddress("ann");
    await giveAddress(ACME, email);

    await provideAddressAndCode(page, email);
    await expect(page.getByText("Signing in to Acme")).toBeVisible();
    await page.getByLabel("Password").fill(ACME.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(`${originOf(ACME)}/projects`);
    await expect(page.getByText(ACME.projectName).first()).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp919-landed.png" });

    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
    await expect(page.getByRole("link", { name: "Continue to Acme" })).toHaveAttribute("href", `${originOf(ACME)}/projects`);
  });

  test("an address with accounts in two organisations picks one, and the other is not signed in", async ({ page }) => {
    const email = freshAddress("pat");
    await giveAddress(ACME, email);
    await giveAddress(GLOBEX, email);

    await provideAddressAndCode(page, email);
    const choices = page.getByTestId("organisation-choices");
    await expect(choices.getByRole("button")).toHaveText([/Acme/, /Globex/]);
    await page.screenshot({ path: "e2e/.artifacts/bp919-choose.png" });
    await choices.getByRole("button", { name: /Globex/ }).click();
    await page.getByLabel("Password").fill(GLOBEX.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(`${originOf(GLOBEX)}/projects`);
    await expect(page.getByText(GLOBEX.projectName).first()).toBeVisible();
    const cookies = await page.context().cookies(originOf(ACME));
    expect(cookies.filter((cookie) => cookie.name.includes("bp_session"))).toEqual([]);
  });

  test("an unknown address is answered exactly as a known one, and learns it has no organisation only after the code", async ({ page, request }) => {
    const known = freshAddress("known");
    const unknown = freshAddress("nobody");
    await giveAddress(ACME, known);

    const answers = [];
    for (const email of [known, unknown]) {
      const res = await request.post(`${ORGANISATIONS_API}/api/sign-in/start`, { headers: onPlatform, data: { email } });
      answers.push({ status: res.status(), body: await res.json() });
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(await codeSentTo(unknown)).toMatch(/^\d{6}$/);

    await provideAddressAndCode(page, unknown);
    await expect(page.getByTestId("no-organisations")).toBeVisible();
  });

  test("a wrong password is refused and keeps the page; a wrong code is refused, and five of them start over", async ({ page }) => {
    const email = freshAddress("wrong");
    await giveAddress(ACME, email);

    await provideAddressAndCode(page, email);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("sign-in-error")).toHaveText("Invalid credentials");
    await expect(page).toHaveURL(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);

    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
    await page.getByLabel("E-mail address").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    const right = await codeSentTo(email, 1);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt <= 5; attempt++) {
      await page.getByLabel("Code").fill(wrong);
      await page.getByRole("button", { name: "Continue" }).click();
      if (attempt < 5) await expect(page.getByTestId("sign-in-error")).toHaveText(/not right/);
    }
    await page.getByLabel("Code").fill(right);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("sign-in-error")).toHaveText(/expired/);
    await expect(page.getByLabel("E-mail address")).toBeVisible();
  });

  test("a handoff code works once, and never on another organisation's host", async ({ request, browser }) => {
    const email = freshAddress("hand");
    await giveAddress(ACME, email);
    const signedIn = await apiCode(request, email);
    const password = await request.post(`${ORGANISATIONS_API}/api/sign-in/password`, {
      headers: signedIn,
      data: { organisation: String(ACME.organisation), password: ACME.password },
    });
    expect(password.status()).toBe(200);
    const location = new URL((await password.json()).location);
    expect(location.host).toBe(hostOf(ACME));
    const code = location.searchParams.get("code")!;

    const planted = await request.get(`${ORGANISATIONS_API}/api/auth/handoff?code=${code}`, {
      headers: { ...asOrganisation(ACME), "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
      maxRedirects: 0,
    });
    expect(planted.headers()["location"]).toContain("/login?handoff=expired");
    expect(planted.headers()["set-cookie"] ?? "").not.toContain("bp_session");

    const elsewhere = await request.get(`${ORGANISATIONS_API}/api/auth/handoff?code=${code}`, { headers: asOrganisation(GLOBEX), maxRedirects: 0 });
    expect(elsewhere.status()).toBe(303);
    expect(elsewhere.headers()["location"]).toContain("/login?handoff=expired");
    expect(elsewhere.headers()["set-cookie"] ?? "").not.toContain("bp_session");

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(location.toString());
    await page.waitForURL(`${originOf(ACME)}/projects`);
    await context.close();

    const again = await browser.newContext();
    const second = await again.newPage();
    await second.goto(location.toString());
    await second.waitForURL(/\/login\?handoff=expired/);
    await expect(second.getByRole("alert").filter({ hasText: "expired" })).toHaveText(/expired or was already used/);
    await again.close();
  });

  test("the sign-in exists on the platform host only, and an organisation's own password is the one asked for", async ({ request }) => {
    for (const path of ["start", "verify", "password"]) {
      expect((await request.post(`${ORGANISATIONS_API}/api/sign-in/${path}`, { headers: asOrganisation(ACME), data: {} })).status()).toBe(404);
    }
    expect((await request.get(`${ORGANISATIONS_API}/api/sign-in/remembered`, { headers: asOrganisation(ACME) })).status()).toBe(404);

    const email = freshAddress("cross");
    await giveAddress(ACME, email);
    await giveAddress(GLOBEX, email);
    const signedIn = await apiCode(request, email);
    const crossed = await request.post(`${ORGANISATIONS_API}/api/sign-in/password`, {
      headers: signedIn,
      data: { organisation: String(GLOBEX.organisation), password: ACME.password },
    });
    expect(crossed.status()).toBe(401);
  });

  test("an address an administrator typed onto an account, never proven, lists and opens nothing", async ({ page, request }) => {
    const email = freshAddress("typed");
    await giveAddress(GLOBEX, email, null);

    await provideAddressAndCode(page, email);
    await expect(page.getByTestId("no-organisations")).toBeVisible();

    const signedIn = await apiCode(request, email);
    const refused = await request.post(`${ORGANISATIONS_API}/api/sign-in/password`, {
      headers: signedIn,
      data: { organisation: String(GLOBEX.organisation), password: GLOBEX.password },
    });
    expect(refused.status()).toBe(401);
  });

  test("an address an administrator vouched for proves it inside that organisation only", async ({ page }) => {
    const email = freshAddress("vouched");
    await giveAddress(ACME, email);
    await giveAddress(GLOBEX, email);
    await withDb((db) => db.collection("users").updateOne({ _id: GLOBEX.adminId }, { $set: { emailVouchedByAdmin: true } }));

    await provideAddressAndCode(page, email);
    await expect(page.getByText("Signing in to Acme")).toBeVisible();
  });

  test("the password step offers the organisation's own page for every other way in, and a way back", async ({ page }) => {
    const email = freshAddress("other");
    await giveAddress(ACME, email);

    await provideAddressAndCode(page, email);
    await expect(page.getByRole("link", { name: "Sign in another way" })).toHaveAttribute("href", `${originOf(ACME)}/login`);
    await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", `${originOf(ACME)}/forgot`);
    await page.getByRole("button", { name: "Use another e-mail address" }).click();
    await expect(page.getByLabel("E-mail address")).toBeVisible();
  });

  test("an address gets five codes in fifteen minutes, then is told to wait", async ({ request }) => {
    const email = freshAddress("flood");
    for (let i = 0; i < 5; i++) {
      expect((await request.post(`${ORGANISATIONS_API}/api/sign-in/start`, { headers: onPlatform, data: { email } })).status()).toBe(200);
    }
    expect((await request.post(`${ORGANISATIONS_API}/api/sign-in/start`, { headers: onPlatform, data: { email } })).status()).toBe(429);
  });

  test("on a phone the choice of organisations fits the screen", async ({ page }) => {
    const email = freshAddress("phone");
    await withDb((db) => db.collection("organisations").updateOne({ _id: GLOBEX.organisation }, { $set: { name: "Globex Interplanetary Holdings and Doomsday Devices" } }));
    await giveAddress(ACME, email);
    await giveAddress(GLOBEX, email);
    await page.setViewportSize({ width: 375, height: 812 });

    await provideAddressAndCode(page, email);
    const choices = page.getByTestId("organisation-choices");
    await expect(choices).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
    await page.screenshot({ path: "e2e/.artifacts/bp919-phone.png" });
  });
});
