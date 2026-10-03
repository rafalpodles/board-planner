import { test, expect, type Browser, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { OIDC_STUB_LABEL, OIDC_STUB_URL, PASSWORDLESS_BASE_URL, RUN_PASSWORDLESS_SERVER } from "../playwright.config";
import {
  ADMIN_ID,
  BOOTSTRAP_TOKEN,
  E2E_MONGODB_URI,
  MEMBER_ID,
  MEMBER_USERNAME,
  PROJECT_ID,
  seed,
  wipe,
} from "./seed";
import { pkce, redirectReceiver } from "./mcp";

/**
 * BP-830. An instance started with PASSWORD_SIGN_IN=off — the third app server, sharing the
 * suite's database — signs in through its providers only: no password form, no password
 * endpoint, and an empty instance set up through a provider.
 */

const SKIP_REASON =
  "needs the password-sign-in-off app server — set E2E_PASSWORDLESS_SERVER=1 (see playwright.config.ts)";
if (!RUN_PASSWORDLESS_SERVER) console.log(`password-sign-in-off.spec.ts: skipping — ${SKIP_REASON}`);
test.skip(!RUN_PASSWORDLESS_SERVER, SKIP_REASON);

const at = (path: string) => `${PASSWORDLESS_BASE_URL}${path}`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function nextPerson(person: { sub: string; email: string }) {
  const res = await fetch(`${OIDC_STUB_URL}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email_verified: true, name: "Sso Person", ...person }),
  });
  expect(res.ok, "the OIDC stub refused its script").toBe(true);
}

function freshAddress(label: string) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/** Signs `userId` in through the provider by its proven address, which links it on the way. */
async function signInAs(page: Page, userId: typeof MEMBER_ID) {
  const email = freshAddress("proven");
  await (await db()).collection("users").updateOne({ _id: userId }, { $set: { email, emailVerifiedAt: new Date() } });
  await nextPerson({ sub: `sub-${randomBytes(4).toString("hex")}`, email });
  await page.goto(at("/login"));
  await page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();
  await expect(page).toHaveURL(/\/projects/);
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

test("the sign-in page offers the providers and no password, and the password endpoint refuses", async ({
  page,
}) => {
  await page.goto(at("/login"));

  await expect(page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Forgot your password?" })).toHaveCount(0);
  const refused = await page.request.post(at("/api/auth/login"), {
    data: { username: MEMBER_USERNAME, password: "test1234" },
    headers: { origin: PASSWORDLESS_BASE_URL },
  });
  expect(refused.status()).toBe(403);

  await signInAs(page, MEMBER_ID);
  expect((await (await page.request.get(at("/api/auth/me"))).json()).username).toBe(MEMBER_USERNAME);
});

test("an MCP client is authorized through a provider sign-in that comes back to the consent", async ({
  page,
}) => {
  const receiver = await redirectReceiver();
  try {
    const registration = await page.request.post(at("/oauth/register"), {
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

    await page.goto(at(`/oauth/authorize?${query}`));
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    const email = freshAddress("admin");
    await (await db()).collection("users").updateOne({ _id: ADMIN_ID }, { $set: { email, emailVerifiedAt: new Date() } });
    await nextPerson({ sub: `mcp-${randomBytes(4).toString("hex")}`, email });
    await page.getByRole("button", { name: "Sign in to continue" }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();

    // Back at the consent, signed in — not at the board
    await expect(page).toHaveURL(/\/oauth\/authorize\?/);
    await page.check('input[name="access"][value="all"]');
    await page.click('button[name="decision"][value="allow"]');
    expect((await receiver.waitForRedirect()).get("code")).toBeTruthy();
  } finally {
    await receiver.close();
  }
});

test("an invitation is accepted with a provider only", async ({ page }) => {
  const token = `cpi_${randomBytes(32).toString("hex")}`;
  await (await db()).collection("invitations").insertOne({
    email: freshAddress("invitee"),
    role: "member",
    boards: [{ project: PROJECT_ID, relation: "member", addedBy: ADMIN_ID }],
    invitedBy: ADMIN_ID,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: "pending",
    acceptedBy: null,
    acceptedAt: null,
    deliveredAs: "email",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await page.goto(at(`/invite?token=${token}`));

  await expect(page.getByRole("button", { name: `Accept with ${OIDC_STUB_LABEL}` })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create my account" })).toHaveCount(0);
});

test("the forgotten-password and reset pages say passwords are not used", async ({ page }) => {
  for (const path of ["/forgot", "/reset?token=cpr_anything"]) {
    await page.goto(at(path));
    await expect(page.getByRole("heading", { name: "Passwords are not used here" })).toBeVisible();
    await expect(page.locator('input[type="password"], input[type="text"]')).toHaveCount(0);
  }
});

test("Security asks for no password, and will not unlink the only provider though a password remains", async ({
  page,
}) => {
  await signInAs(page, MEMBER_ID);

  await page.goto(at("/settings/security"));
  await expect(page.getByRole("button", { name: `Unlink ${OIDC_STUB_LABEL}` })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Change password" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Link GitHub" })).toBeVisible();
  await expect(page.getByLabel("Your password, to link a provider")).toHaveCount(0);

  await page.getByRole("button", { name: `Unlink ${OIDC_STUB_LABEL}` }).click();
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/identities/")),
    page.getByRole("dialog").getByRole("button", { name: "Unlink" }).click(),
  ]);
  expect(refused.status()).toBe(409);
  await expect(page.getByRole("dialog")).toContainText("Link another provider first.");
});

// With no password to ask for, a session that is not fresh may be a borrowed one: it must not be
// able to add a way in
test("linking a provider needs a sign-in made minutes ago", async ({ page }) => {
  await signInAs(page, MEMBER_ID);
  await (await db())
    .collection("sessions")
    .updateMany({ user: MEMBER_ID }, { $set: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } });

  await page.goto(at("/settings/security"));
  await page.getByRole("button", { name: "Link GitHub" }).click();

  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("sign in again first");
  await expect(page).toHaveURL(/\/settings\/security/);
});

test("an administrator is offered no account with a password and no password to hand out", async ({ page }) => {
  await signInAs(page, ADMIN_ID);

  await page.goto(at("/settings/users"));
  await expect(page.getByRole("button", { name: "Invite" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New User" })).toHaveCount(0);
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Set a new password")).toHaveCount(0);
});

test("an empty instance is set up with a provider, its first account an administrator", async ({ browser }) => {
  await wipe();
  const { context, page } = await fresh(browser);
  const email = freshAddress("operator");
  await nextPerson({ sub: `first-${randomBytes(4).toString("hex")}`, email });

  await page.goto(at("/login"));
  await page.getByRole("button", { name: "First time? Create Account" }).click();
  await page.getByLabel("Username").fill("operator");
  await page.getByLabel("Full Name").fill("Ola Operator");
  await page.getByLabel("Setup code").fill(BOOTSTRAP_TOKEN);
  await page.getByRole("button", { name: `Set up with ${OIDC_STUB_LABEL}` }).click();

  await expect(page).toHaveURL(/\/projects/);
  expect(await (await page.request.get(at("/api/auth/me"))).json()).toMatchObject({ username: "operator", role: "admin" });
  const account = await (await db()).collection("users").findOne({ username: "operator" });
  expect(account).toMatchObject({ email, role: "admin" });
  expect(account!.password).toBeUndefined();
  expect(await (await db()).collection("identities").countDocuments({ user: account!._id })).toBe(1);
  await context.close();
});

test("a wrong setup code stops the setup before the provider is asked", async ({ page }) => {
  await wipe();

  await page.goto(at("/login"));
  await page.getByRole("button", { name: "First time? Create Account" }).click();
  await page.getByLabel("Username").fill("operator");
  await page.getByLabel("Full Name").fill("Ola Operator");
  await page.getByLabel("Setup code").fill("a-plausible-guess");
  await page.getByRole("button", { name: `Set up with ${OIDC_STUB_LABEL}` }).click();

  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText(
    "The setup code is missing or wrong."
  );
  expect(await (await db()).collection("users").countDocuments()).toBe(0);
});

test("the address on the profile is the administrator's to change", async ({ page }) => {
  await signInAs(page, MEMBER_ID);

  await page.goto(at("/settings/profile"));

  await expect(page.getByText("An administrator changes it on this instance.")).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveAttribute("readonly", "");
});

// Turning passwords off on an instance whose accounts never linked a provider nor proved an
// address would otherwise leave them no way in at all
test("an account with an unproven address is let in once an administrator confirms it", async ({ browser }) => {
  const email = freshAddress("unproven");
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email, emailVerifiedAt: null } });
  const member = await fresh(browser);
  await nextPerson({ sub: `late-${randomBytes(4).toString("hex")}`, email });
  await member.page.goto(at("/login"));
  await member.page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();
  await expect(member.page).toHaveURL(/sso=unproven/);
  await expect(member.page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText(
    "Ask an administrator to confirm it."
  );

  const admin = await fresh(browser);
  await signInAs(admin.page, ADMIN_ID);
  await admin.page.goto(at("/settings/users"));
  await admin.page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();
  await admin.page.getByRole("button", { name: "Confirm address" }).click();
  await expect(admin.page.getByRole("button", { name: "Confirm address" })).toHaveCount(0);

  await member.page.goto(at("/login"));
  await member.page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();
  await expect(member.page).toHaveURL(/\/projects/);
  expect((await (await member.page.request.get(at("/api/auth/me"))).json()).username).toBe(MEMBER_USERNAME);
  await member.context.close();
  await admin.context.close();
});

test("an administrator signs somebody out everywhere, providers and all", async ({ browser }) => {
  const member = await fresh(browser);
  await signInAs(member.page, MEMBER_ID);
  const admin = await fresh(browser);
  await signInAs(admin.page, ADMIN_ID);

  await admin.page.goto(at("/settings/users"));
  await admin.page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();
  await admin.page.getByRole("button", { name: "Sign out everywhere" }).click();
  await admin.page.getByRole("dialog").getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(admin.page.getByText(`${MEMBER_USERNAME} was signed out everywhere`)).toBeVisible();

  expect((await member.page.request.get(at("/api/auth/me"))).status()).toBe(401);
  expect(await (await db()).collection("identities").countDocuments({ user: MEMBER_ID })).toBe(0);
  await member.context.close();
  await admin.context.close();
});
