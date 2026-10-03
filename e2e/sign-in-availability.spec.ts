import { test, expect, type Browser } from "@playwright/test";
import { randomBytes } from "crypto";
import mongoose from "mongoose";
import { OIDC_STUB_LABEL, OIDC_STUB_URL } from "../playwright.config";
import { E2E_MONGODB_URI, MEMBER_ID, MEMBER_USERNAME, seed } from "./seed";
import { pkce, redirectReceiver } from "./mcp";

/**
 * BP-840. Signing in through a provider stays possible for everybody: an anonymous flood of bogus
 * callbacks throttles nobody else, and an account with no password reaches the MCP consent too.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

/** The member, made password-less with a proven address, is who the stub signs in next. */
async function memberSignsInThroughTheStub() {
  const email = `member-${randomBytes(4).toString("hex")}@example.com`;
  await (await db())
    .collection("users")
    .updateOne({ _id: MEMBER_ID }, { $set: { email, emailVerifiedAt: new Date() }, $unset: { password: "" } });
  const res = await fetch(`${OIDC_STUB_URL}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub: `sub-${randomBytes(4).toString("hex")}`, email, email_verified: true, name: "Member" }),
  });
  expect(res.ok, "the OIDC stub refused its script").toBe(true);
}

async function fresh(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a flood of bogus callbacks from unknown addresses throttles nobody's sign-in", async ({ browser, request }) => {
  // Past what one shared bucket allowed (60 a source, times 20 with no address)
  const bogus = Array.from({ length: 1250 }, (_, i) => `/api/auth/oidc/oidc/callback?code=x${i}&state=y`);
  for (let i = 0; i < bogus.length; i += 50) {
    await Promise.all(bogus.slice(i, i + 50).map((path) => request.get(path, { maxRedirects: 0 })));
  }

  await memberSignsInThroughTheStub();
  const member = await fresh(browser);
  await member.page.goto("/login");
  await member.page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();
  await expect(member.page).toHaveURL(/\/projects/);
  expect((await (await member.page.request.get("/api/auth/me")).json()).username).toBe(MEMBER_USERNAME);
  await member.context.close();
});

test("an account with no password connects an MCP client through a provider", async ({ browser }) => {
  const receiver = await redirectReceiver();
  const member = await fresh(browser);
  try {
    const registration = await member.page.request.post("/oauth/register", {
      data: { client_name: "E2E MCP Client", redirect_uris: [receiver.url] },
    });
    expect(registration.status(), await registration.text()).toBe(201);
    const { client_id: clientId } = await registration.json();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: receiver.url,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      state: "s",
    });
    await memberSignsInThroughTheStub();

    await member.page.goto(`/oauth/authorize?${query}`);
    await expect(member.page.locator('input[type="password"]')).toBeVisible();
    await member.page.getByRole("button", { name: "Sign in with a provider instead" }).click();
    await expect(member.page).toHaveURL(/\/login\?next=/);
    await member.page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();

    await expect(member.page).toHaveURL(/\/oauth\/authorize\?/);
    await member.page.check('input[name="access"][value="all"]');
    await member.page.click('button[name="decision"][value="allow"]');
    expect((await receiver.waitForRedirect()).get("code")).toBeTruthy();
  } finally {
    await receiver.close();
    await member.context.close();
  }
});
