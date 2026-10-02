import { test, expect, type Browser, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import mongoose from "mongoose";
import { bodyOf, mailFor } from "./mailbox";
import { SAME_ORIGIN } from "./api";
import { signIn, signInContext } from "./session";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  OWNER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  SECOND_PROJECT_ID,
  seed,
} from "./seed";

/**
 * BP-827. A board's owner — no standing on the instance, only an owner grant on one board —
 * invites somebody by address from that board's settings, and only to that board.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

function freshAddress(label: string) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

const alertOn = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

async function inviteFromBoard(page: Page, email: string, relation: "member" | "owner" = "member") {
  await page.goto(`/projects/${PROJECT_KEY}/settings`);
  const card = page.locator("section").filter({ hasText: "Invite by email" });
  await card.getByLabel("Email to invite").fill(email);
  await card.getByLabel("Role on this board").selectOption(relation);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        /\/api\/projects\/[^/]+\/invitations$/.test(new URL(r.url()).pathname) &&
        r.request().method() === "POST"
    ),
    card.getByRole("button", { name: "Invite", exact: true }).click(),
  ]);
  return { card, response };
}

async function linkMailedTo(email: string): Promise<string> {
  let link = "";
  await expect
    .poll(
      async () => {
        const [message] = await mailFor(email);
        const match = message && bodyOf(message).match(/https?:\/\/[^\s"<>]+\/invite\?token=[A-Za-z0-9_%-]+/);
        link = match ? match[0] : "";
        return link;
      },
      { timeout: 10_000 }
    )
    .not.toBe("");
  return link;
}

async function accept(browser: Browser, link: string, username: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  await expect(page.getByRole("heading", { name: /^Join / })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Full name").fill("Invited By An Owner");
  await page.getByLabel("Password", { exact: true }).fill("chosen-by-the-invitee");
  await page.getByLabel("Confirm password").fill("chosen-by-the-invitee");
  await page.getByRole("button", { name: "Create my account" }).click();
  return { context, page };
}

async function plantAdminInvitation(email: string, deliveredAs: "email" | "link" = "email") {
  const token = `cpi_${randomBytes(32).toString("hex")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  await (await db()).collection("invitations").insertOne({
    email,
    role: "admin",
    boards: [],
    invitedBy: ADMIN_ID,
    tokenHash,
    expiresAt,
    status: "pending",
    acceptedBy: null,
    acceptedAt: null,
    deliveredAs,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { token, tokenHash, expiresAt };
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an owner invites somebody to their board, who joins it as a member of the instance", async ({ page, browser }) => {
  const email = freshAddress("owners-guest");
  await signIn(page, "owner");

  const { card, response } = await inviteFromBoard(page, email, "owner");
  expect(response.status()).toBe(201);
  await expect(card.getByTestId("board-invitation").filter({ hasText: email })).toContainText("Owner");

  const { context, page: guest } = await accept(browser, await linkMailedTo(email), "owners-guest");
  await expect(guest).toHaveURL(new RegExp(`/projects/${PROJECT_ID}`));

  const account = await (await db()).collection("users").findOne({ username: "owners-guest" });
  expect(account).toMatchObject({ email, role: "member" });
  expect(
    await (await db()).collection("grants").findOne({ subject: account!._id, object: PROJECT_ID })
  ).toMatchObject({ relation: "owner" });
  await context.close();
});

test("an owner cannot invite to a board they do not own", async ({ browser }) => {
  const context = await browser.newContext();
  await signInContext(context, "owner");

  const refused = await context.request.post(`/api/projects/${SECOND_PROJECT_ID}/invitations`, {
    headers: SAME_ORIGIN,
    data: { email: freshAddress("elsewhere"), relation: "owner" },
  });
  // The control: the same request to the board they do own goes through
  const allowed = await context.request.post(`/api/projects/${PROJECT_ID}/invitations`, {
    headers: SAME_ORIGIN,
    data: { email: freshAddress("here"), relation: "owner" },
  });

  expect([refused.status(), allowed.status()]).toEqual([403, 201]);
  expect(
    await (await db()).collection("invitations").countDocuments({ "boards.project": SECOND_PROJECT_ID })
  ).toBe(0);
  await context.close();
});

// An administrator's invitation may carry the administrator role: an owner adds their board to it
// and touches nothing else — no new link, no new expiry, nothing mailed
test("an owner's board joins an administrator's pending invitation without changing it", async ({ page, browser }) => {
  const email = freshAddress("admin-invited");
  const planted = await plantAdminInvitation(email);
  await signIn(page, "owner");

  const { response } = await inviteFromBoard(page, email, "owner");
  expect(response.status()).toBe(200);
  await expect(page.getByText(`${email} already had an invitation waiting; this board was added to it`)).toBeVisible();

  const row = await (await db()).collection("invitations").findOne({ email, status: "pending" });
  expect(row).toMatchObject({ role: "admin", tokenHash: planted.tokenHash, expiresAt: planted.expiresAt });
  expect(row!.boards).toEqual([{ project: PROJECT_ID, relation: "owner", addedBy: OWNER_ID }]);
  expect(await mailFor(email)).toHaveLength(0);

  const { context, page: guest } = await accept(browser, `/invite?token=${planted.token}`, "admin-with-board");
  await expect(guest).toHaveURL(new RegExp(`/projects/${PROJECT_ID}`));
  const account = await (await db()).collection("users").findOne({ username: "admin-with-board" });
  expect(account).toMatchObject({ role: "admin" });
  expect(
    await (await db()).collection("grants").findOne({ subject: account!._id, object: PROJECT_ID })
  ).toMatchObject({ relation: "owner" });
  await context.close();
});

test("an owner who loses the board before the link is used grants nothing through it", async ({ page, browser }) => {
  const email = freshAddress("too-late");
  await signIn(page, "owner");
  await inviteFromBoard(page, email);
  const link = await linkMailedTo(email);

  await (await db())
    .collection("grants")
    .updateOne({ subject: OWNER_ID, object: PROJECT_ID }, { $set: { relation: "member" } });

  const { context, page: guest } = await accept(browser, link, "never-joined");
  await expect(alertOn(guest)).toHaveText("This invitation was withdrawn. Ask whoever invited you for a new one.");
  expect(await (await db()).collection("users").findOne({ username: "never-joined" })).toBeNull();
  await context.close();
});

test("an owner withdraws an invitation from the board, and its link stops working", async ({ page, browser }) => {
  const email = freshAddress("withdrawn");
  await signIn(page, "owner");
  const { card } = await inviteFromBoard(page, email);
  const link = await linkMailedTo(email);

  await card.getByRole("button", { name: `Withdraw the invitation for ${email}` }).click();
  const [withdrawn] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/invitations/")),
    page.getByRole("dialog").getByRole("button", { name: "Withdraw" }).click(),
  ]);
  expect(withdrawn.status()).toBe(200);
  await expect(card.getByText("Invite by email")).toBeVisible();
  await expect(card.getByTestId("board-invitation")).toHaveCount(0);
  await expect(alertOn(page)).toHaveCount(0);

  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(link);
  await expect(alertOn(guest)).toHaveText("This invitation was withdrawn. Ask whoever invited you for a new one.");
  await context.close();
});

// A link somebody was shown could be in anybody's hands, and this board would go wherever it does
test("an owner cannot add the board to an invitation whose link somebody holds", async ({ page }) => {
  const email = freshAddress("link-held");
  const planted = await plantAdminInvitation(email, "link");
  await signIn(page, "owner");

  const { card, response } = await inviteFromBoard(page, email);

  expect(response.status()).toBe(409);
  await expect(card.getByRole("alert")).toHaveText(
    `${email} has an invitation out as a link from admin. Ask them to add this board, or wait until it is used or withdrawn.`
  );
  const row = await (await db()).collection("invitations").findOne({ email, status: "pending" });
  expect(row).toMatchObject({ tokenHash: planted.tokenHash, boards: [] });
});
