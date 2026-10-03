import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { CODA_STUB_URL } from "../playwright.config";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";
import { SAME_ORIGIN } from "./api";
import { e2eLicence, useLicenceKey } from "./licence-key";

/**
 * BP-651. Coda is the first Pro connector: on a free instance its panel is an upsell, its sync and
 * its settings write answer 402, and a board's Coda settings are kept until the instance is on Pro
 * again. The main server runs with no LICENCE_KEY, so it is free unless a test swaps a key in.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=integrations`;
const SYNC = `/api/projects/${PROJECT_KEY}/coda/sync`;
const PROJECT = `/api/projects/${PROJECT_KEY}`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

/** The Coda row is the catalogue tile until a board has Coda, then the list row; either opens it. */
async function openCoda(page: Page) {
  await page.goto(SETTINGS);
  const picker = page.getByRole("button", { name: /Add integration/ });
  const coda = page.getByRole("button", { name: /^Coda/ });
  await expect(picker.or(coda).first()).toBeVisible();
  await expect(async () => {
    if (!(await coda.first().isVisible())) await picker.click();
    if (!(await page.getByRole("button", { name: /^Coda/, expanded: true }).isVisible())) await coda.first().click();
    await expect(page.getByRole("button", { name: /^Coda/, expanded: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

async function configureOnPro(page: Page) {
  await openCoda(page);
  await page.getByLabel("Doc ID").fill("doc-kept");
  await page.getByLabel("Table ID or name").fill("table-kept");
  await page.getByLabel("Host").fill(CODA_STUB_URL);
  await page.getByLabel("API token").fill("coda-e2e-token");
  const saved = page.waitForResponse((r) => r.url().endsWith(PROJECT) && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await saved).status()).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await seed();
  await useLicenceKey(request, undefined);
});

test.afterEach(async ({ request }) => {
  await useLicenceKey(request, undefined);
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("on a free instance the Coda panel is an upsell, and its sync and settings write answer 402", async ({ page }) => {
  await signIn(page);
  await openCoda(page);

  const upsell = page.getByTestId("pro-upsell");
  await expect(upsell).toContainText("Coda sync");
  await expect(upsell.getByRole("link", { name: /^Try Pro free for 30 days/ })).toHaveAttribute(
    "href",
    "https://board-planner.com/trial/"
  );
  await expect(page.getByLabel("Doc ID")).toHaveCount(0);

  const sync = await page.request.post(SYNC, { headers: SAME_ORIGIN, data: {} });
  expect(sync.status()).toBe(402);
  expect(await sync.json()).toMatchObject({ feature: "integrations.coda", plan: "free" });

  const write = await page.request.put(PROJECT, { headers: SAME_ORIGIN, data: { codaDocId: "doc-free" } });
  expect(write.status()).toBe(402);
  expect(await write.json()).toMatchObject({ feature: "integrations.coda", plan: "free" });
  expect((await (await db()).collection("projects").findOne({ _id: PROJECT_ID }))?.codaDocId ?? "").toBe("");

  // The control: the same write without a Coda field is not refused
  const rename = await page.request.put(PROJECT, { headers: SAME_ORIGIN, data: { description: "still saves" } });
  expect(rename.status()).toBe(200);
});

test("a configured Coda survives the drop to free, read-only, and syncs again when the key returns", async ({
  page,
  request,
}) => {
  await request.post(`${CODA_STUB_URL}/control`, { data: {} });
  await useLicenceKey(request, e2eLicence());
  await signIn(page);
  await configureOnPro(page);

  await useLicenceKey(request, undefined);
  await openCoda(page);
  await expect(page.getByTestId("pro-upsell")).toBeVisible();
  // The list says what the row is on this plan rather than "Connected"
  await expect(page.getByText("Pro feature", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
  const kept = page.getByTestId("coda-kept");
  await expect(kept).toContainText("doc-kept");
  await expect(kept).toContainText("table-kept");
  await expect(page.getByLabel("Doc ID")).toHaveCount(0);
  const refused = await page.request.post(SYNC, { headers: SAME_ORIGIN, data: {} });
  expect(refused.status()).toBe(402);
  const stored = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  expect(stored?.codaDocId).toBe("doc-kept");
  expect(stored?.codaToken).toBeTruthy();

  await useLicenceKey(request, e2eLicence());
  await openCoda(page);
  await expect(page.getByLabel("Doc ID")).toHaveValue("doc-kept");
  const synced = page.waitForResponse((r) => r.url().endsWith(SYNC));
  await page.getByRole("button", { name: "Sync tasks now" }).click();
  expect((await synced).status()).toBe(200);
  await expect(page.getByTestId("toast").last()).toHaveText(/Synced \d+ tasks? to Coda/);
});

test("a free board can still disconnect the Coda settings it kept", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence());
  await signIn(page);
  await configureOnPro(page);

  await useLicenceKey(request, undefined);
  await openCoda(page);
  await expect(page.getByTestId("coda-kept")).toContainText("doc-kept");
  const cleared = page.waitForResponse((r) => r.url().endsWith(PROJECT) && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Disconnect" }).click();
  expect((await cleared).status()).toBe(200);

  await expect(page.getByTestId("coda-kept")).toHaveCount(0);
  const stored = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  expect(stored?.codaDocId).toBe("");
  expect(stored?.codaToken ?? "").toBe("");
});

test("a plan that cannot be read is said so, not shown to a Pro board as an upsell", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence());
  await signIn(page);
  await page.route("**/api/entitlements", (route) => route.fulfill({ status: 500, body: "{}" }));

  await openCoda(page);

  await expect(page.getByRole("alert").filter({ hasText: "Couldn't check this instance's plan" })).toBeVisible();
  await expect(page.getByTestId("pro-upsell")).toHaveCount(0);
});
