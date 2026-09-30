import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { signIn } from "./session";
import {
  E2E_MONGODB_URI,
  FINISHED_TASK_ID,
  HELD_TASK_ID,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_ID,
  seed,
} from "./seed";

/** BP-799. The instance run history cut off its last columns and scrolled sideways at 1280 px. */

const LONG_PROJECT = "Customer onboarding and billing platform migration board";
const LONG_AGENT = "Implement, review twice, run the full end-to-end suite and merge";
const LONG_MACHINE = "rafal-macbook-pro-m3-max-studio-office-second-desk";
const LONG_DETAIL =
  "the diff-size gate refused the change: 2140 lines across 38 files is more than the 800 lines this agent allows";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { name: LONG_PROJECT } });
  await handle.collection("workers").updateOne({ _id: WORKER_ID }, { $set: { name: LONG_MACHINE } });
  const finishedAt = new Date();
  const startedAt = new Date(finishedAt.getTime() - 83 * 60_000);
  const record = {
    project: PROJECT_ID,
    worker: WORKER_ID,
    agent: null,
    agentName: LONG_AGENT,
    startedAt,
    finishedAt,
    costUsd: 12.34,
    createdAt: finishedAt,
    updatedAt: finishedAt,
  };
  await handle.collection("agentruns").insertMany([
    {
      ...record,
      task: HELD_TASK_ID,
      taskKey: `${PROJECT_KEY}-1`,
      outcome: "refused",
      refusedBy: "diff-size",
      detail: LONG_DETAIL,
    },
    {
      ...record,
      task: FINISHED_TASK_ID,
      taskKey: `${PROJECT_KEY}-4`,
      outcome: "delivered",
      refusedBy: "",
      detail: "opened a pull request",
    },
  ]);
});

async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement!;
    const card = document.querySelector('[data-testid="fleet-runs"]') as HTMLElement;
    const scrollers = [card, ...Array.from(card.querySelectorAll<HTMLElement>("*"))].filter(
      (el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowX) && el.tagName !== "P"
    );
    return {
      page: doc.scrollWidth - doc.clientWidth,
      card: card.scrollWidth - card.clientWidth,
      cardRight: card.getBoundingClientRect().right,
      viewport: doc.clientWidth,
      scrollers: scrollers.map((el) => el.scrollWidth - el.clientWidth),
    };
  });
}

async function expectAllOnScreen(page: Page, locator: ReturnType<Page["getByText"]>) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`every column fits without sideways scroll at ${viewport.width} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signIn(page);
    await page.goto("/settings/workers/runs");
    await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
    await expect(page.getByTestId("run-detail").first()).toBeVisible();

    const measured = await overflow(page);
    expect(measured.page).toBeLessThanOrEqual(0);
    expect(measured.card).toBeLessThanOrEqual(0);
    expect(measured.cardRight).toBeLessThanOrEqual(measured.viewport);
    for (const excess of measured.scrollers) expect(excess).toBeLessThanOrEqual(0);

    const refused = page.getByTestId("fleet-run").filter({ hasText: `${PROJECT_KEY}-1` });
    await expectAllOnScreen(page, refused.getByText("Refused: diff-size"));
    await expectAllOnScreen(page, page.getByText("Pull request open"));
    await expectAllOnScreen(page, refused.getByText("$12.34"));
    await expectAllOnScreen(page, refused.getByText("83 min"));
    await expectAllOnScreen(page, page.getByText(LONG_DETAIL));

    for (const text of [LONG_PROJECT, LONG_AGENT, LONG_MACHINE]) {
      const cell = refused.getByTitle(text);
      await expect(cell).toBeVisible();
      const box = await cell.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    }
  });
}

test("the desktop table keeps its column headers for assistive technology", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await page.goto("/settings/workers/runs");

  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Ended" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Cost" })).toBeVisible();
  const refused = table.getByRole("row").filter({ hasText: `${PROJECT_KEY}-1` });
  await expect(refused.getByRole("cell", { name: "Refused: diff-size" })).toBeVisible();
});

test("the phone layout labels each value it shows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/settings/workers/runs");

  const refused = page.getByTestId("fleet-run").filter({ hasText: `${PROJECT_KEY}-1` });
  for (const label of ["Project", "Agent", "Machine", "Took", "Cost"]) {
    await expect(refused.getByText(label, { exact: true })).toBeVisible();
  }
});
