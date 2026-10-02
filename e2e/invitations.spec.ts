import { test, expect, type Browser, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { bodyOf, mailFor, refuseMailFor, stopRefusing } from "./mailbox";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
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
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
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

  await expect(stranger.page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}`));
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

  await page.reload();
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
    row.getByRole("button", { name: `Send the invitation for ${email} again` }).click(),
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
  await expect(stranger.page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}`));
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
    await expect(stranger.page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}`));
    await stranger.context.close();
  } finally {
    await stopRefusing();
  }
});
