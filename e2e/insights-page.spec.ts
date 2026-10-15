import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-879. The page is driven as a person sees it: signed in, on a board whose history was written
 * by the real status route, on Pro and on Free.
 */

const ORGANISATION_ID = new mongoose.Types.ObjectId("000000000000000000000001");
const SHOTS = process.env.INSIGHTS_SHOTS_DIR;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

async function setPlan(plan: "free" | "pro") {
  await (await db())
    .collection("organisations")
    .updateOne({ _id: ORGANISATION_ID }, { $set: { "entitlements.plan": plan, "entitlements.features": [] } }, { upsert: true });
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  await (await db()).collection("organisations").deleteOne({ _id: ORGANISATION_ID });
  await mongoose.disconnect();
});

async function boardWithHistory(request: APIRequestContext, key: string) {
  const created = await request.post("/api/projects", { headers: ADMIN_AUTH, data: { name: `Insights ${key}`, key } });
  expect(created.status(), await created.text()).toBe(201);
  const { _id: projectId } = (await created.json()) as { _id: string };

  const move = async (taskId: string, status: string) => {
    const res = await request.patch(`/api/projects/${projectId}/tasks/${taskId}/status`, { headers: ADMIN_AUTH, data: { status } });
    expect(res.status(), await res.text()).toBe(200);
  };
  const ids: Record<string, string> = {};
  for (const [title, category] of [
    ["Ship the export", "bug"],
    ["Write the guide", "doc"],
    ["Fix the redirect", "bug"],
    ["Still being built", "bug"],
  ] as const) {
    const task = await request.post(`/api/projects/${projectId}/tasks`, {
      headers: ADMIN_AUTH,
      data: { title, status: "todo", category },
    });
    expect(task.status(), await task.text()).toBe(201);
    ids[title] = ((await task.json()) as { _id: string })._id;
  }
  for (const title of ["Ship the export", "Write the guide", "Fix the redirect"]) {
    await move(ids[title], "in_progress");
    await move(ids[title], "done");
  }
  await move(ids["Still being built"], "in_progress");
  return { projectId };
}

function insightsRequests(page: Page) {
  const seen: string[] = [];
  page.on("request", (req) => {
    if (/\/api\/projects\/[^/]+\/insights/.test(req.url())) seen.push(req.url());
  });
  return seen;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: 2000 });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  await page.setViewportSize(size);
}

test("on Pro every panel draws the board's own figures, and the filters ask the server again", async ({ page, request }) => {
  await setPlan("pro");
  await boardWithHistory(request, "INS");
  await signIn(page);

  const answered = page.waitForResponse((res) => /\/insights\?/.test(res.url()));
  await page.goto("/projects/INS/insights");
  expect((await answered).status()).toBe(200);

  const live = page.getByTestId("insights-live");
  await expect(live).toBeVisible();
  await expect(page.getByTestId("insights-upsell")).toHaveCount(0);
  await expect(page.getByRole("main").locator("header")).toHaveCount(1);
  await expect(page.getByRole("main").locator("header").getByRole("link")).toHaveCount(0);
  await expect(page.getByTestId("insights-tiles")).toContainText("Throughput3finished in 12 weeks");
  await expect(page.getByTestId("insights-tiles")).toContainText("In progress1");
  await expect(page.getByTestId("insights-scatter").locator("circle")).toHaveCount(3);
  await expect(page.getByTestId("insights-throughput").locator("rect")).toHaveCount(1);
  const aging = page.getByTestId("insights-aging");
  await expect(aging.getByRole("link", { name: "INS-4" })).toHaveAttribute("href", "/projects/INS/tasks/4");
  await expect(aging).toContainText("Still being built");
  await expect(page.getByTestId("insights-dora")).toContainText("not measured yet");
  await expect(page.getByText("Sample data")).toHaveCount(0);

  await page.getByTestId("insights-throughput").getByText("Show as table").click();
  const weekRows = page.getByTestId("insights-throughput").getByRole("table").locator("tbody tr");
  await expect(weekRows).toHaveCount(12);
  await expect(weekRows.last().locator("td").nth(1)).toHaveText("3");

  const narrowed = page.waitForResponse((res) => /\/insights\?.*category=doc/.test(res.url()));
  await page.getByLabel("Category").selectOption("doc");
  expect((await narrowed).status()).toBe(200);
  await expect(page.getByTestId("insights-tiles")).toContainText("Throughput1finished", { timeout: 2_000 });

  const fourWeeks = page.waitForResponse((res) => /\/insights\?.*weeks=4/.test(res.url()));
  await page.getByLabel("Window").selectOption("4");
  expect((await fourWeeks).status()).toBe(200);
  await expect(page.getByTestId("insights-tiles")).toContainText("finished in 4 weeks", { timeout: 2_000 });

  await page.getByLabel("Category").selectOption("");
  await expect(page.getByTestId("insights-tiles")).toContainText("Throughput3", { timeout: 2_000 });
  await shot(page, "pro-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.getByTestId("insights-live")).toBeVisible();
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll).toBeLessThanOrEqual(0);
  await shot(page, "pro-phone");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(page.getByTestId("insights-live")).toBeVisible();
  await shot(page, "pro-dark");
});

test("on Free the page shows the sample and the upsell, and never asks for insights", async ({ page, request }) => {
  await setPlan("free");
  await boardWithHistory(request, "FRE");
  await signIn(page);
  const asked = insightsRequests(page);

  await page.goto("/projects/FRE/insights");

  await expect(page.getByTestId("insights-upsell")).toContainText("part of Board Planner Pro");
  await expect(page.getByTestId("insights-upsell").getByRole("link", { name: /Try Pro free/ })).toBeVisible();
  await expect(page.getByTestId("insights-sample")).toBeVisible();
  await expect(page.getByTestId("insights-scatter").locator("circle")).not.toHaveCount(0);
  await expect(page.getByTestId("insights-filters")).toHaveCount(0);
  await expect(page.getByTestId("insights-aging").getByRole("link")).toHaveCount(0);
  await expect(page.getByTestId("insights-aging")).toContainText("DEMO-151");
  await expect(page.getByTestId("insights-aging")).not.toContainText("FRE-");
  await expect(page.getByTestId("insights-trend").getByText("Sample data")).toBeVisible();
  await expect(page.getByTestId("insights-dora").getByText("Sample data")).toHaveCount(0);
  await page.waitForTimeout(1_000);
  expect(asked).toEqual([]);
  await shot(page, "free-desktop");
});

test("the dashboard is the same on both plans, and the navigation reaches Insights from it", async ({ page, request }) => {
  await boardWithHistory(request, "DSH");
  await signIn(page);
  const dashboardHtml = async () => {
    const stats = page.waitForResponse((res) => /\/stats$/.test(res.url()));
    await page.goto("/projects/DSH/dashboard");
    await stats;
    await expect(page.getByRole("heading", { name: "Velocity (tasks done/week)" })).toBeVisible();
    return page.locator("main").innerHTML();
  };

  await setPlan("free");
  const onFree = await dashboardHtml();
  await setPlan("pro");
  const onPro = await dashboardHtml();

  expect(onPro).toBe(onFree);
  await page.getByRole("link", { name: "Insights", exact: true }).first().click();
  await expect(page).toHaveURL(/\/projects\/DSH\/insights$/);
  await expect(page.getByRole("heading", { name: "Insights" })).toBeVisible();
});

test("a new board says nothing has finished, and a board with no Done column says why", async ({ page, request }) => {
  await setPlan("pro");
  const created = await request.post("/api/projects", { headers: ADMIN_AUTH, data: { name: "Fresh", key: "NEW" } });
  const { _id: projectId } = (await created.json()) as { _id: string };
  await signIn(page);

  await page.goto("/projects/NEW/insights");
  await expect(page.getByTestId("insights-empty")).toContainText("No task finished in this window yet");
  await expect(page.getByTestId("insights-tiles")).toContainText("Cycle time (median)—");
  await expect(page.getByTestId("insights-no-done-column")).toHaveCount(0);

  await (await db()).collection("projects").updateOne(
    { _id: new mongoose.Types.ObjectId(projectId) },
    {
      $set: {
        columns: [
          { id: "todo", label: "To Do", color: "#3b82f6", role: "approved", order: 0, triggersPmReview: false },
          { id: "in_progress", label: "Doing", color: "#f59e0b", role: "active", order: 1, triggersPmReview: false },
        ],
      },
    }
  );
  await page.reload();
  await expect(page.getByTestId("insights-no-done-column")).toContainText("no column meaning Done");
  await expect(page.getByTestId("insights-tiles")).toContainText("Throughput—No Done column");
  await expect(page.getByTestId("insights-empty")).toHaveCount(0);
});
