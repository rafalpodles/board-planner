import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  E2E_MONGODB_URI,
  MEMBER_ID,
  MEMBER_MACHINE_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  DECOY_TASK_ID,
  WORKER_CREDENTIAL,
  seed,
  seedMachine,
} from "./seed";
import { ADMIN_AUTH, MEMBER_AUTH, SAME_ORIGIN } from "./api";
import { signIn, signInContext } from "./session";

/**
 * BP-832. An administrator deactivates an account instead of deleting it: it keeps its history,
 * and from that moment it signs in by no path, every credential it held stops, its machines stop
 * with it, nobody can hand it work, and nothing is sent to it. Reactivating lets it sign in again
 * without bringing back what was revoked.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function machineStatus(request: APIRequestContext) {
  const response = await request.post(`/api/workers/${MEMBER_MACHINE_ID}/heartbeat`, {
    headers: {
      Authorization: `Bearer ${WORKER_CREDENTIAL}`,
      "x-worker-id": String(MEMBER_MACHINE_ID),
      "x-cp-protocol": "1",
    },
    data: {},
  });
  return response.status();
}

async function memberContext(browser: Browser) {
  const context = await browser.newContext();
  await signInContext(context, "member");
  return { context, page: await context.newPage() };
}

async function openMember(page: Page) {
  await page.goto("/settings/users");
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function passwordSignIn(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Username").fill(MEMBER_USERNAME);
  await page.getByLabel("Password").fill(MEMBER_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  return { context, page };
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a deactivated account loses every credential at once, its machine too, and reactivating brings back sign-in but not them", async ({
  page,
  request,
  browser,
}) => {
  await seedMachine("git@github.com:e2e/deactivated.git");
  const member = await memberContext(browser);
  // The control: everything works before
  expect((await member.page.request.get("/api/auth/me")).status()).toBe(200);
  expect((await request.get("/api/auth/me", { headers: MEMBER_AUTH })).status()).toBe(200);
  expect(await machineStatus(request)).not.toBe(401);

  await signIn(page);
  await openMember(page);
  await page.getByRole("button", { name: "Deactivate", exact: true }).click();
  await page.getByRole("dialog", { name: "Deactivate account" }).getByRole("button", { name: "Deactivate", exact: true }).click();
  await expect(page.getByText(`${MEMBER_USERNAME} is deactivated`)).toBeVisible();
  await expect(page.getByText("Deactivated", { exact: true })).toBeVisible();

  expect((await member.page.request.get("/api/auth/me")).status()).toBe(401);
  expect((await request.get("/api/auth/me", { headers: MEMBER_AUTH })).status()).toBe(401);
  expect(await machineStatus(request)).toBe(401);
  const refused = await passwordSignIn(browser);
  // Answered as an unknown account is, so the password says nothing about the account
  await expect(refused.page.getByText("Invalid credentials")).toBeVisible();
  await refused.context.close();

  // Still on the board, and marked so
  await page.goto(`/projects/${PROJECT_KEY}/settings`);
  await expect(page.getByText("Deactivated", { exact: true })).toBeVisible();

  // Nobody can hand them work
  const assignable = await request.get(`/api/projects/${PROJECT_ID}/assignable-users`, { headers: ADMIN_AUTH });
  expect((await assignable.json()).map((u: { username: string }) => u.username)).not.toContain(MEMBER_USERNAME);

  await openMember(page);
  // It would only unlink the providers deactivation keeps for the way back
  await expect(page.getByRole("button", { name: "Sign out everywhere" })).toHaveCount(0);
  await page.getByRole("button", { name: "Reactivate" }).click();
  await expect(page.getByText(`${MEMBER_USERNAME} can sign in again`)).toBeVisible();

  const back = await passwordSignIn(browser);
  await expect(back.page).toHaveURL(/\/projects/);
  await back.context.close();
  // What deactivation revoked stays revoked
  expect((await request.get("/api/auth/me", { headers: MEMBER_AUTH })).status()).toBe(401);
  expect(await machineStatus(request)).toBe(401);
  await member.context.close();
});

test("a deactivated watcher is told nothing about the task", async ({ request }) => {
  await (await db()).collection("tasks").updateOne({ _id: DECOY_TASK_ID }, { $set: { watchers: [MEMBER_ID] } });
  const comment = (body: string) =>
    request.post(`/api/projects/${PROJECT_ID}/tasks/${DECOY_TASK_ID}/comments`, {
      headers: ADMIN_AUTH,
      data: { body },
    });
  const toldMember = () => db().then((handle) => handle.collection("notifications").countDocuments({ recipient: MEMBER_ID }));

  // The control: a watcher hears about a comment
  expect((await comment("Before")).status()).toBe(201);
  await expect.poll(toldMember).toBe(1);

  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { deactivatedAt: new Date() } });
  expect((await comment("After")).status()).toBe(201);
  // Long enough for the fire-and-forget write that used to land
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(await toldMember()).toBe(1);
});

test("an administrator is offered no way to deactivate themselves", async ({ page }) => {
  // A second administrator, so the last-administrator rule is not what refuses it
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { role: "admin" } });
  await signIn(page);
  await page.goto("/settings/users");
  await page.getByText("@admin", { exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await expect(page.getByRole("button", { name: "Deactivate", exact: true })).toHaveCount(0);
  const refused = await page.request.put(`/api/users/${await adminId(page)}`, {
    headers: SAME_ORIGIN,
    data: { deactivate: true },
  });
  expect(refused.status()).toBe(400);
});

async function adminId(page: Page) {
  return (await (await page.request.get("/api/auth/me")).json())._id as string;
}
