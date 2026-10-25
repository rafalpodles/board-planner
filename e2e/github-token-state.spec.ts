import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { GITHUB_STUB_URL } from "../playwright.config";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed, seedRepository } from "./seed";
import { signIn } from "./session";

/**
 * BP-1108. A token GitHub had stopped taking read "Connected" in settings while every sync tick
 * answered 401 into the log, and a new token typed into the field was not used by "Sync pull
 * requests now" until the page's Save all had stored it. These drive the panel the way the owner
 * met it: the badge, the board's notice, the save-time check and the save that precedes the sync.
 */

const REPOSITORY = "e2e-org/token-board";
const REPO_URL = `https://github.com/${REPOSITORY}`;
const DEAD = "github_pat_e2e_dead";
const FRESH = "github_pat_e2e_fresh";
const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=integrations`;
const lastToast = (page: Page) => page.getByTestId("toast").last();
const tokenField = (page: Page) => page.getByLabel("Access token");

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

async function connection(): Promise<Record<string, unknown>> {
  const project = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  return (project?.githubConnection ?? {}) as Record<string, unknown>;
}

async function markRejected(at: Date) {
  await (await db()).collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { "githubConnection.rejectedAt": at } });
}

async function stub(page: Page, control: Record<string, unknown>) {
  await page.request.post(`${GITHUB_STUB_URL}/control`, { data: { repository: REPOSITORY, pulls: [], ...control } });
}

async function openGithub(page: Page) {
  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Configure GitHub" }).click();
  await expect(tokenField(page)).toBeVisible();
}

const isPut = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}`) && r.request().method() === "PUT");
const isSync = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith(`/github/sync`) && r.request().method() === "POST");

test.beforeEach(seed);
test.afterAll(async () => {
  await mongoose.disconnect();
});

test("a rejected token is badged, told on the board, and replaced by a typed one before the sync runs on it", async ({ page }) => {
  await seedRepository({ repositoryUrl: REPO_URL, githubToken: DEAD });
  const year = new Date().getFullYear();
  await markRejected(new Date(`${year}-10-18T07:12:00Z`));
  await stub(page, { refusedTokens: [DEAD], tokenLogin: "token-owner" });
  await signIn(page);

  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole("status").filter({ hasText: "stopped updating" })).toHaveText(
    /Pull requests on this board stopped updating on 18 Oct: GitHub rejected the token\.\s*Fix in Settings/
  );

  await openGithub(page);
  await expect(page.getByText("Token rejected")).toBeVisible();
  await expect(page.getByText("Connected")).toHaveCount(0);
  await expect(page.getByText(/^GitHub rejected this token on 18 Oct/)).toBeVisible();

  await tokenField(page).fill(FRESH);
  await expect(page.getByRole("button", { name: "Sync pull requests now" })).toHaveCount(0);
  const saved = isPut(page);
  const synced = isSync(page);
  await page.getByRole("button", { name: "Save token and sync" }).click();
  expect((await saved).status()).toBe(200);
  expect((await synced).status()).toBe(200);

  const bearers: (string | null)[] = await (await page.request.get(`${GITHUB_STUB_URL}/bearers`)).json();
  expect(bearers.length).toBeGreaterThan(0);
  expect(bearers.every((bearer) => bearer === `Bearer ${FRESH}`)).toBe(true);

  await expect(page.getByText("Connected")).toBeVisible();
  await expect(page.getByText("Token rejected")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Token of" })).toContainText("Token of token-owner, with no expiry.");
  await expect(page.getByRole("status").filter({ hasText: "Last synced" })).toContainText("0 pull requests linked to 0 tasks.");
  expect(await connection()).toMatchObject({ rejectedAt: null, login: "token-owner" });

  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole("button", { name: /New task/ }).first()).toBeVisible();
  await expect(page.getByText("stopped updating")).toHaveCount(0);
});

test("a token GitHub refuses is not stored, and nothing is synced on it", async ({ page }) => {
  await seedRepository({ repositoryUrl: REPO_URL, githubToken: DEAD });
  await stub(page, { refusedTokens: [DEAD, FRESH] });
  await signIn(page);
  await openGithub(page);

  await tokenField(page).fill(FRESH);
  const saved = isPut(page);
  await page.getByRole("button", { name: "Save token and sync" }).click();
  expect((await saved).status()).toBe(400);

  await expect(lastToast(page)).toContainText("GitHub rejected this token: it is wrong, expired or revoked. Nothing was saved.");
  await expect(tokenField(page)).toHaveValue(FRESH);
  const asked: string[] = await (await page.request.get(`${GITHUB_STUB_URL}/asked`)).json();
  expect(asked).toEqual(["/user"]);
  expect((await connection()).login ?? "").toBe("");
});

test("a token that cannot read the repository is refused by name", async ({ page }) => {
  await seedRepository({ repositoryUrl: REPO_URL, githubToken: DEAD });
  await stub(page, { repository: "someone-else/board" });
  await signIn(page);
  await openGithub(page);

  await tokenField(page).fill(FRESH);
  const saved = isPut(page);
  await page.getByRole("button", { name: "Save token and sync" }).click();
  expect((await saved).status()).toBe(400);

  await expect(lastToast(page)).toContainText(`GitHub accepted this token, but it cannot read ${REPOSITORY}.`);
});

test("a person's sync on a dead token records it, and the badge turns", async ({ page }) => {
  await seedRepository({ repositoryUrl: REPO_URL, githubToken: DEAD });
  await stub(page, { refusedTokens: [DEAD] });
  await signIn(page);
  await openGithub(page);
  await expect(page.getByText("Connected")).toBeVisible();

  const synced = isSync(page);
  await page.getByRole("button", { name: "Sync pull requests now" }).click();
  expect((await synced).status()).toBe(502);

  await expect(lastToast(page)).toContainText("GitHub rejected this project's token");
  await expect(page.getByText("Token rejected")).toBeVisible();
  expect((await connection()).rejectedAt).toBeInstanceOf(Date);
});

test("a token close to its expiry is badged with the days left", async ({ page }) => {
  await seedRepository({ repositoryUrl: REPO_URL, githubToken: DEAD });
  const inThreeDays = new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000);
  const header = `${inThreeDays.toISOString().slice(0, 10)} ${inThreeDays.toISOString().slice(11, 19)} UTC`;
  await stub(page, { tokenExpiration: header });
  await signIn(page);
  await openGithub(page);

  await tokenField(page).fill(FRESH);
  const synced = isSync(page);
  await page.getByRole("button", { name: "Save token and sync" }).click();
  expect((await synced).status()).toBe(200);

  await expect(page.getByText("Expires in 3 days")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "This token expires on" })).toBeVisible();
});
