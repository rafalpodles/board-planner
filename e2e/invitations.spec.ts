import { test, expect, type Browser, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { SAME_ORIGIN } from "./api";
import { signIn, signInContext } from "./session";
import { bodyOf, mailFor, refuseMailFor, stopRefusing } from "./mailbox";
import {
  BOARD_URL,
  E2E_MONGODB_URI,
  MEMBER_USERNAME,
  PROJECT_ID,
  PROJECT_NAME,
  seed,
} from "./seed";

/**
 * BP-826. An admin invites somebody by address, the invitation arrives by mail, and the person it
 * reached makes their own account from the link and lands on the board they were invited to.
 * Both sides are driven in the browser; the link is read out of the message the mail server got.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

// The stub keeps every message of the run, so each test invites an address nobody else has used
function freshAddress(label: string) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function signInAsAdmin(page: Page) {
  await signIn(page, "admin");
}

async function invite(page: Page, email: string) {
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByRole("checkbox", { name: new RegExp(PROJECT_NAME) }).check();
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/invitations") && r.request().method() === "POST"),
    dialog.getByRole("button", { name: "Send invitation" }).click(),
  ]);
  return { dialog, response };
}

async function linksMailedTo(email: string): Promise<string[]> {
  const messages = await mailFor(email);
  return messages.map((m) => {
    const match = bodyOf(m).match(/https?:\/\/[^\s"<>]+\/invite\?token=[A-Za-z0-9_%-]+/);
    expect(match, "no invitation link in the message").not.toBeNull();
    return match![0];
  });
}

async function latestLink(email: string, count = 1): Promise<string> {
  let links: string[] = [];
  await expect
    .poll(async () => (links = await linksMailedTo(email)).length, { timeout: 10_000 })
    .toBe(count);
  return links[count - 1];
}

// Next's route announcer is a role=alert too, and empty
const alertOn = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

async function asStranger(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function accept(page: Page, link: string, username: string, password = "chosen-by-the-invitee") {
  await page.goto(link);
  await expect(page.getByRole("heading", { name: /^Join / })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Full name").fill("Invited Person");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create my account" }).click();
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an invitation arrives by mail and its link makes an account on the invited board", async ({ page, browser }) => {
  const email = freshAddress("invitee");
  await signInAsAdmin(page);

  const { dialog, response } = await invite(page, email);
  expect(response.status()).toBe(201);
  await expect(dialog.getByRole("status")).toContainText(`Invitation sent to ${email}`);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("pending-invitation").filter({ hasText: email })).toBeVisible();

  const link = await latestLink(email);
  const stranger = await asStranger(browser);
  await expect(async () => {
    await stranger.page.goto(link);
    await expect(stranger.page.getByText(`invited ${email}`)).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await expect(stranger.page.getByText(PROJECT_NAME)).toBeVisible();

  await accept(stranger.page, link, "invited-person");

  await expect(stranger.page).toHaveURL(BOARD_URL);
  const account = await (await db()).collection("users").findOne({ username: "invited-person" });
  expect(account).toMatchObject({ email, role: "member" });
  const grant = await (await db())
    .collection("grants")
    .findOne({ subject: account!._id, object: PROJECT_ID });
  expect(grant).toMatchObject({ relation: "member" });

  // Spent: the same link a second time is refused, and says why
  const again = await asStranger(browser);
  await again.page.goto(link);
  await expect(alertOn(again.page)).toHaveText(
    "This invitation has already been used. Sign in instead."
  );

  const [listed] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/invitations") && r.request().method() === "GET"),
    page.reload(),
  ]);
  expect(await listed.json()).toEqual([]);
  await expect(page.getByText("@invited-person")).toBeVisible();
  await expect(page.getByTestId("pending-invitation")).toHaveCount(0);

  await stranger.context.close();
  await again.context.close();
});

test("resend kills the previous link, and revoke kills the current one", async ({ page, browser }) => {
  const email = freshAddress("resent");
  await signInAsAdmin(page);
  const { dialog } = await invite(page, email);
  await dialog.getByRole("button", { name: "Done" }).click();
  const first = await latestLink(email, 1);

  const row = page.getByTestId("pending-invitation").filter({ hasText: email });
  const [resent] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/resend")),
    row.getByRole("button", { name: `Resend the invitation for ${email}` }).click(),
  ]);
  expect(resent.status()).toBe(200);
  const second = await latestLink(email, 2);
  expect(second).not.toBe(first);

  const stranger = await asStranger(browser);
  await stranger.page.goto(first);
  await expect(alertOn(stranger.page)).toHaveText(
    "This invitation link is not valid. Ask whoever invited you for a new one."
  );
  // The control: the new link is the one that works
  await stranger.page.goto(second);
  await expect(stranger.page.getByRole("heading", { name: /^Join / })).toBeVisible();

  await row.getByRole("button", { name: `Revoke the invitation for ${email}` }).click();
  const [revoked] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/invitations/")),
    page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click(),
  ]);
  expect(revoked.status()).toBe(200);

  await stranger.page.goto(second);
  await expect(alertOn(stranger.page)).toHaveText(
    "This invitation was withdrawn. Ask whoever invited you for a new one."
  );
  await stranger.context.close();
});

test("an address that already has an account is not invited", async ({ page }) => {
  const handle = await db();
  const existing = freshAddress("member");
  await handle.collection("users").updateOne({ username: MEMBER_USERNAME }, { $set: { email: existing } });
  await signInAsAdmin(page);

  const { dialog, response } = await invite(page, existing);

  expect(response.status()).toBe(409);
  await expect(dialog.getByRole("alert")).toHaveText(
    "That address already has an account. Add them to a board instead."
  );
  expect(await handle.collection("invitations").countDocuments()).toBe(0);
});

test("a username already taken keeps the link usable for another try", async ({ page, browser }) => {
  const email = freshAddress("taken");
  await signInAsAdmin(page);
  const { dialog } = await invite(page, email);
  await dialog.getByRole("button", { name: "Done" }).click();
  const link = await latestLink(email);

  const stranger = await asStranger(browser);
  await accept(stranger.page, link, MEMBER_USERNAME);
  await expect(alertOn(stranger.page)).toHaveText("Username already exists");

  await stranger.page.getByLabel("Username").fill("second-choice");
  await stranger.page.getByRole("button", { name: "Create my account" }).click();
  await expect(stranger.page).toHaveURL(BOARD_URL);
  await stranger.context.close();
});

test("a mail server that refuses the invitation leaves the admin holding the link", async ({ page, browser }) => {
  const email = freshAddress("refused");
  await refuseMailFor(email);
  try {
    await signInAsAdmin(page);
    const { dialog, response } = await invite(page, email);
    expect(response.status()).toBe(201);

    await expect(dialog.getByText(`The email to ${email} could not be sent.`)).toBeVisible();
    const link = (await dialog.getByTestId("invitation-link").textContent())!.trim();
    expect(link).toMatch(/\/invite\?token=cpi_[0-9a-f]+$/);
    expect(await mailFor(email)).toHaveLength(0);

    const stranger = await asStranger(browser);
    await accept(stranger.page, link, "linked-person");
    await expect(stranger.page).toHaveURL(BOARD_URL);
    await stranger.context.close();
  } finally {
    await stopRefusing();
  }
});

/** What the app would have stored for an invitation it had sent, with the raw link in hand */
async function plantInvitation(email: string, fields: Record<string, unknown> = {}) {
  const token = `cpi_${randomBytes(32).toString("hex")}`;
  const ghost = new mongoose.Types.ObjectId();
  await (await db()).collection("invitations").insertOne({
    email,
    role: "member",
    boards: [{ project: PROJECT_ID, relation: "member", addedBy: ghost }],
    invitedBy: ghost,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: "pending",
    acceptedBy: null,
    acceptedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
  return token;
}

test("an administrator invitation with an owned board makes an admin who owns it", async ({ page, browser }) => {
  const email = freshAddress("admin-invitee");
  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByRole("button", { name: "Admin" }).click();
  await dialog.getByRole("checkbox", { name: new RegExp(PROJECT_NAME) }).check();
  await dialog.getByLabel(`Role on ${PROJECT_NAME}`).selectOption("owner");
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog.getByRole("status")).toContainText(`Invitation sent to ${email}`);

  const stranger = await asStranger(browser);
  await accept(stranger.page, await latestLink(email), "new-admin");
  await expect(stranger.page).toHaveURL(BOARD_URL);

  const account = await (await db()).collection("users").findOne({ username: "new-admin" });
  expect(account).toMatchObject({ email, role: "admin" });
  expect(
    await (await db()).collection("grants").findOne({ subject: account!._id, object: PROJECT_ID })
  ).toMatchObject({ relation: "owner" });
  await stranger.context.close();
});

// Acceptance checks the people an invitation names, so a resend that kept a deleted inviter would
// mail a link refused only after the invitee filled in the form
test("an invitation whose inviter was deleted works once another admin resends it", async ({ page, browser }) => {
  const email = freshAddress("orphan");
  const oldToken = await plantInvitation(email);
  await signInAsAdmin(page);
  await page.goto("/settings/users");

  const row = page.getByTestId("pending-invitation").filter({ hasText: email });
  await expect(row).toContainText("by a deleted account");
  const [resent] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/resend")),
    row.getByRole("button", { name: `Resend the invitation for ${email}` }).click(),
  ]);
  expect(resent.status()).toBe(200);
  const link = await latestLink(email);

  const stranger = await asStranger(browser);
  await stranger.page.goto(`/invite?token=${oldToken}`);
  await expect(alertOn(stranger.page)).toHaveText(
    "This invitation link is not valid. Ask whoever invited you for a new one."
  );
  await accept(stranger.page, link, "rescued-person");
  await expect(stranger.page).toHaveURL(BOARD_URL);
  await stranger.context.close();
});

test("an expired invitation says so, and is marked expired for the admin", async ({ page, browser }) => {
  const email = freshAddress("late");
  const token = await plantInvitation(email, { expiresAt: new Date(Date.now() - 60_000) });

  const stranger = await asStranger(browser);
  await stranger.page.goto(`/invite?token=${token}`);
  await expect(alertOn(stranger.page)).toHaveText(
    "This invitation has expired. Ask whoever invited you for a new one."
  );
  await stranger.context.close();

  await signInAsAdmin(page);
  await page.goto("/settings/users");
  await expect(page.getByTestId("pending-invitation").filter({ hasText: email })).toContainText("Expired");
});

// The gate itself: every invitation route but the two a link opens is for an administrator, and
// a member has no screen that would call them, so the requests are the member's own session's
test("a member cannot list, send, resend or revoke invitations", async ({ browser }) => {
  const planted = await plantInvitation(freshAddress("gated"));
  const row = await (await db()).collection("invitations").findOne({
    tokenHash: createHash("sha256").update(planted).digest("hex"),
  });
  const context = await browser.newContext();
  await signInContext(context, "member");
  const api = context.request;

  const answers = await Promise.all([
    api.get("/api/invitations", { headers: SAME_ORIGIN }),
    api.post("/api/invitations", {
      headers: SAME_ORIGIN,
      data: { email: freshAddress("by-member"), role: "admin" },
    }),
    api.post(`/api/invitations/${row!._id}/resend`, { headers: SAME_ORIGIN }),
    api.delete(`/api/invitations/${row!._id}`, { headers: SAME_ORIGIN }),
  ]);

  expect(answers.map((a) => a.status())).toEqual([403, 403, 403, 403]);
  expect(await (await db()).collection("invitations").countDocuments({ status: "pending" })).toBe(1);
  await context.close();

  // The control: the same request, with the same headers, from an administrator's session goes
  // through — so the four refusals above are the role check, not a provenance refusal
  const adminContext = await browser.newContext();
  await signInContext(adminContext, "admin");
  const allowed = await adminContext.request.delete(`/api/invitations/${row!._id}`, {
    headers: SAME_ORIGIN,
  });
  expect(allowed.status()).toBe(200);
  await adminContext.close();
});

// An account taking the address withdraws the invitation for good: hidden alone, it would come
// back to life the day that account was deleted, granting what it said a week before
test("an account made for an invited address withdraws the invitation, even after it is deleted", async ({ page, browser }) => {
  const email = freshAddress("overtaken");
  await signInAsAdmin(page);
  const { dialog } = await invite(page, email);
  await dialog.getByRole("button", { name: "Done" }).click();
  const link = await latestLink(email);

  await page.getByRole("button", { name: "New User" }).click();
  const create = page.getByRole("dialog", { name: "New User" });
  await create.getByLabel("Username").fill("made-directly");
  await create.getByLabel("Password").fill("set-by-the-admin");
  await create.getByLabel("Full Name").fill("Made Directly");
  await create.getByLabel("Email").fill(email);
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/users") && r.request().method() === "POST"),
    create.getByRole("button", { name: "Create User" }).click(),
  ]);
  expect(created.status()).toBe(201);
  const account = await (await db()).collection("users").findOne({ username: "made-directly" });
  await (await db()).collection("users").deleteOne({ _id: account!._id });

  const stranger = await asStranger(browser);
  await stranger.page.goto(link);
  await expect(alertOn(stranger.page)).toHaveText(
    "This invitation was withdrawn. Ask whoever invited you for a new one."
  );
  await stranger.context.close();
});
