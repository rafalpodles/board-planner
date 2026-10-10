import { test, expect } from "@playwright/test";
import { ORGANISATION_DOMAIN, ORGANISATIONS_PLATFORM_ORIGIN, ORGANISATIONS_PORT, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { mailFor } from "./mailbox";
import { ACME, GLOBEX, ORGANISATIONS_API, asOrganisation, hostOf, originOf, seedTwoOrganisations } from "./organisations";
import { apiCode, codeSentTo, freshAddress, giveAddress, onPlatform, provideAddressAndCode, withDb } from "./platform-sign-in";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

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
    await page.getByRole("checkbox", { name: /Open this organisation straight away/ }).check();
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(`${originOf(ACME)}/projects`);
    await expect(page.getByText(ACME.projectName).first()).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp919-landed.png" });

    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
    await page.waitForURL(`${originOf(ACME)}/projects`);
  });

  test("BP-1009: the remembered organisation outlives the browser session, and opening the platform host leads straight to it", async ({ page }) => {
    const email = freshAddress("session");
    await giveAddress(GLOBEX, email);

    await provideAddressAndCode(page, email);
    await page.getByLabel("Password").fill(GLOBEX.password);
    await page.getByRole("checkbox", { name: /Open this organisation straight away/ }).check();
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${originOf(GLOBEX)}/projects`);

    const remembered = (await page.context().cookies(ORGANISATIONS_PLATFORM_ORIGIN)).filter((cookie) => cookie.name.endsWith("bp_last_organisation"));
    expect(remembered).toHaveLength(1);
    expect(remembered[0].value).toBe(String(GLOBEX.organisation));
    const days = (remembered[0].expires - Date.now() / 1000) / (24 * 60 * 60);
    expect(days).toBeGreaterThan(179);
    expect(days).toBeLessThanOrEqual(180);

    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
    await page.waitForURL(`${originOf(GLOBEX)}/projects`);
    await expect(page.getByText(GLOBEX.projectName).first()).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp1009-straight-in.png" });
  });

  test("BP-1009: ?switch opens the sign-in instead of the remembered organisation, and leaves the memory alone", async ({ page }) => {
    const email = freshAddress("switch");
    await giveAddress(GLOBEX, email);
    await provideAddressAndCode(page, email);
    await page.getByLabel("Password").fill(GLOBEX.password);
    await page.getByRole("checkbox", { name: /Open this organisation straight away/ }).check();
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${originOf(GLOBEX)}/projects`);

    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/?switch`);
    await expect(page.getByLabel("E-mail address")).toBeVisible();
    await page.screenshot({ path: "e2e/.artifacts/bp1009-switch.png" });

    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
    await page.waitForURL(`${originOf(GLOBEX)}/projects`);
  });

  test("BP-1009: an organisation's own sign-in page leads back to the choice of organisation, past the remembered one", async ({ page }) => {
    const signIn = `http://login.${ORGANISATION_DOMAIN}:${ORGANISATIONS_PORT}`;
    const email = freshAddress("both-ways");
    await giveAddress(GLOBEX, email);
    await provideAddressAndCode(page, email, signIn);
    await page.getByLabel("Password").fill(GLOBEX.password);
    await page.getByRole("checkbox", { name: /Open this organisation straight away/ }).check();
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${originOf(GLOBEX)}/projects`);
    expect((await page.context().cookies(signIn)).some((cookie) => cookie.name.endsWith("bp_last_organisation"))).toBe(true);

    await page.goto(`${originOf(ACME)}/login`);
    const another = page.getByRole("link", { name: "Sign in to another organisation" });
    await expect(another).toHaveAttribute("href", `${signIn}/?switch`);
    await page.screenshot({ path: "e2e/.artifacts/bp1009-login-link.png" });
    await another.click();
    await page.waitForURL(`${signIn}/?switch`);
    await expect(page.getByLabel("E-mail address")).toBeVisible();
  });

  test("BP-1009: nothing is remembered unless it is asked for, and signing in again without asking withdraws it", async ({ page }) => {
    const email = freshAddress("nocookie");
    await giveAddress(GLOBEX, email);
    await provideAddressAndCode(page, email);
    await expect(page.getByRole("checkbox", { name: /Open this organisation straight away/ })).not.toBeChecked();
    await page.screenshot({ path: "e2e/.artifacts/bp1009-remember-box.png" });
    await page.getByLabel("Password").fill(GLOBEX.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${originOf(GLOBEX)}/projects`);
    const remembered = () => page.context().cookies(ORGANISATIONS_PLATFORM_ORIGIN).then((cookies) => cookies.filter((cookie) => cookie.name.endsWith("bp_last_organisation")));
    expect(await remembered()).toEqual([]);

    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
    await expect(page.getByLabel("E-mail address")).toBeVisible();

    await page.context().addCookies([
      { name: "__Host-bp_last_organisation", value: String(GLOBEX.organisation), domain: new URL(ORGANISATIONS_PLATFORM_ORIGIN).hostname, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    ]);
    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/?switch`);
    await page.getByLabel("E-mail address").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Code").fill(await codeSentTo(email, 1));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Password").fill(GLOBEX.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${originOf(GLOBEX)}/projects`);
    expect(await remembered()).toEqual([]);
  });

  test("BP-1009: the box is never carried over to another organisation or person, and the memory can be dropped without signing in", async ({ page }) => {
    const email = freshAddress("carry");
    await giveAddress(ACME, email);
    await giveAddress(GLOBEX, email);
    await provideAddressAndCode(page, email);
    await page.getByTestId("organisation-choices").getByRole("button", { name: /Acme/ }).click();
    const box = page.getByRole("checkbox", { name: /Open this organisation straight away/ });
    await expect(box).not.toBeChecked();
    await box.check();
    await page.getByRole("button", { name: "Choose another organisation" }).click();
    await page.getByTestId("organisation-choices").getByRole("button", { name: /Globex/ }).click();
    await expect(box).not.toBeChecked();
    await box.check();
    await page.getByRole("button", { name: "Use another e-mail address" }).click();
    await page.getByLabel("E-mail address").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Code").fill(await codeSentTo(email, 1));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("organisation-choices").getByRole("button", { name: /Globex/ }).click();
    await expect(box).not.toBeChecked();

    await page.context().addCookies([
      { name: "__Host-bp_last_organisation", value: String(GLOBEX.organisation), domain: new URL(ORGANISATIONS_PLATFORM_ORIGIN).hostname, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    ]);
    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
    await page.waitForURL(`${originOf(GLOBEX)}/projects`);
    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/?switch`);
    await page.screenshot({ path: "e2e/.artifacts/bp1009-forget.png" });
    await page.getByRole("button", { name: "Stop opening my last organisation automatically" }).click();
    await expect(page.getByTestId("remembered-forgotten")).toBeVisible();
    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
    await expect(page.getByLabel("E-mail address")).toBeVisible();
    expect(page.url()).toBe(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
  });

  test("BP-1009: a refused forget is reported, never confirmed", async ({ page }) => {
    await page.route("**/api/sign-in/remembered", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Forbidden" }) }));
    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/?switch`);
    await page.getByRole("button", { name: "Stop opening my last organisation automatically" }).click();
    await expect(page.getByTestId("sign-in-error")).toHaveText("Could not forget the organisation. Try again.");
    await expect(page.getByTestId("remembered-forgotten")).toHaveCount(0);
  });

  test("BP-1009: forgetting the organisation is refused from another origin and off the platform host", async ({ request }) => {
    const crossSite = await request.delete(`${ORGANISATIONS_API}/api/sign-in/remembered`, { headers: { ...onPlatform, "sec-fetch-site": "cross-site", origin: "https://evil.example" } });
    expect(crossSite.status()).toBe(403);
    expect(crossSite.headers()["set-cookie"] ?? "").not.toContain("bp_last_organisation");
    expect((await request.delete(`${ORGANISATIONS_API}/api/sign-in/remembered`, { headers: asOrganisation(ACME) })).status()).toBe(404);
  });

  test("BP-1009: a remembered organisation that is suspended or gone does not strand the platform host", async ({ page }) => {
    await page.context().addCookies([
      { name: "__Host-bp_last_organisation", value: "0123456789abcdef01234567", domain: new URL(ORGANISATIONS_PLATFORM_ORIGIN).hostname, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    ]);
    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
    await expect(page.getByLabel("E-mail address")).toBeVisible();
    expect(page.url()).toBe(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);

    await withDb((db) => db.collection("organisations").updateOne({ _id: GLOBEX.organisation }, { $set: { suspendedAt: new Date() } }));
    await page.context().addCookies([
      { name: "__Host-bp_last_organisation", value: String(GLOBEX.organisation), domain: new URL(ORGANISATIONS_PLATFORM_ORIGIN).hostname, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    ]);
    await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
    await expect(page.getByLabel("E-mail address")).toBeVisible();
    expect(page.url()).toBe(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
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
