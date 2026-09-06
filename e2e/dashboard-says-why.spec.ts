import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  E2E_MONGODB_URI,
  OUTSIDER_PASSWORD,
  OUTSIDER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  seed,
  seedAssignmentOutsider,
} from "./seed";
import { signIn, signInThroughForm } from "./session";

const DASHBOARD = `/projects/${PROJECT_KEY}/dashboard`;
const STATS = new RegExp(`/api/projects/${PROJECT_KEY}/stats`);
const PROJECT_ONLY = new RegExp(`/api/projects/${PROJECT_KEY}$`);

const errorBanner = (page: Page) => page.getByTestId("dashboard-error");

const RENAMED_COLUMNS = [
  { id: "icebox", label: "Icebox", color: "#6b7280", role: "backlog", order: 0 },
  { id: "col_wip", label: "Building", color: "#e11d48", role: "active", order: 1 },
  { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 2 },
];

async function renameTheColumns() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  await handle
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $set: { columns: RENAMED_COLUMNS } });
  await handle
    .collection("tasks")
    .updateMany({ project: PROJECT_ID }, { $set: { status: "col_wip" } });
}

const inProgressCard = (page: Page) =>
  page.locator("div").filter({ hasText: /^In Progress/ }).last();

test.beforeEach(seed);

test("a reader with no grant is told that, and is not left with a spinner", async ({ page }) => {
  await seedAssignmentOutsider();
  await signInThroughForm(page, OUTSIDER_USERNAME, OUTSIDER_PASSWORD);
  await page.goto(DASHBOARD);

  await expect(errorBanner(page)).toContainText("You do not have access to this board");

  await page.waitForTimeout(3500);
  await expect(errorBanner(page)).toContainText("You do not have access to this board");
  await expect(page.locator(".animate-spin")).toHaveCount(0);
});

test("a board that does not exist says that instead — a different sentence", async ({ page }) => {
  await signIn(page);
  await page.goto("/projects/NOSUCHKEY/dashboard");

  await expect(errorBanner(page)).toContainText("There is no board here");
  await expect(errorBanner(page)).not.toContainText("do not have access");
});

test("a server that fails says what it said, and Try again picks it up", async ({ page }) => {
  await signIn(page);

  let refuse = true;
  await page.route(STATS, async (route) => {
    if (!refuse) return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the aggregation gave up" }),
    });
  });

  await page.goto(DASHBOARD);
  await expect(errorBanner(page)).toContainText("the aggregation gave up");

  await page.evaluate(() => {
    (window as unknown as { __stayedPut?: boolean }).__stayedPut = true;
  });
  refuse = false;
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();
  await expect(errorBanner(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __stayedPut?: boolean }).__stayedPut),
    "the page was reloaded rather than retried in place"
  ).toBe(true);
});

test("only the project request failing still draws the charts", async ({ page }) => {
  await renameTheColumns();
  await signIn(page);

  await page.goto(DASHBOARD);
  await expect(inProgressCard(page)).toContainText("4");

  await page.route(PROJECT_ONLY, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"nope"}' })
  );
  await page.reload();

  await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();
  await expect(errorBanner(page)).toHaveCount(0);
  const warning = page.getByTestId("dashboard-settings-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("In Progress cannot be counted");

  await expect(inProgressCard(page)).toContainText("—");
  await expect(inProgressCard(page)).not.toContainText("0");
});

test("a board with no In-progress column says the count is impossible, rather than 0", async ({
  page,
}) => {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  const OTHER_ROLES = [
    { id: "icebox", label: "Icebox", color: "#6b7280", role: "backlog", order: 0 },
    { id: "ready", label: "Ready", color: "#3b82f6", role: "approved", order: 1 },
    { id: "checking", label: "Checking", color: "#a855f7", role: "review", order: 3 },
    { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 4 },
  ];
  const IN_FLIGHT = { id: "col_wip", label: "Building", color: "#e11d48", role: "active", order: 2 };
  await handle.collection("tasks").updateMany({ project: PROJECT_ID }, { $set: { status: "icebox" } });
  await signIn(page);

  await test.step("an empty In-progress column still reads 0, and nothing warns", async () => {
    await handle
      .collection("projects")
      .updateOne({ _id: PROJECT_ID }, { $set: { columns: [...OTHER_ROLES, IN_FLIGHT] } });
    await page.goto(DASHBOARD);
    await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();

    await expect(inProgressCard(page)).toContainText("0");
    await expect(page.getByTestId("dashboard-no-active-column")).toHaveCount(0);
  });

  await test.step("without one, the count is impossible and the page says so", async () => {
    await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { columns: OTHER_ROLES } });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();

    const warning = page.getByTestId("dashboard-no-active-column");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("In Progress cannot be counted");
    await expect(page.getByTestId("dashboard-settings-warning")).toHaveCount(0);

    await expect(inProgressCard(page)).toContainText("—");
    await expect(inProgressCard(page)).not.toContainText("0");
  });
});

test("a 200 whose body is empty still says something", async ({ page }) => {
  await signIn(page);
  await page.route(STATS, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "null" })
  );

  await page.goto(DASHBOARD);

  await expect(errorBanner(page)).toContainText("The dashboard could not be loaded");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a board that loads shows the charts and nothing else", async ({ page }) => {
  await signIn(page);
  await page.goto(DASHBOARD);

  await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();
  await expect(errorBanner(page)).toHaveCount(0);
  await expect(page.getByTestId("dashboard-settings-warning")).toHaveCount(0);
  await expect(page.locator(".animate-spin")).toHaveCount(0);
});
