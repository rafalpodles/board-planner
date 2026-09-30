import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { signIn } from "./session";
import {
  E2E_MONGODB_URI,
  FINISHED_TASK_ID,
  HELD_TASK_ID,
  PROJECT_ID,
  WORKER_ID,
  seed,
} from "./seed";

/** BP-799. The instance run history cut off its last columns and scrolled sideways at 1280 px. */

const LONG_PROJECT = "Customer onboarding and billing platform migration board";
const LONG_AGENT = "Implement, review twice, run the full end-to-end suite and merge";
const LONG_MACHINE = "rafal-macbook-pro-m3-max-studio-office-second-desk";
const LONG_DETAIL =
  "the diff-size gate refused the change: 2140 lines across 38 files is more than the 800 lines this agent allows";
const RECENT_KEY = "RECURRODEMOBOARD-1234";
const OLD_KEY = "RECURRODEMOBOARD-987";
const OLD_FINISHED_AT = new Date(Date.now() - 45 * 24 * 60 * 60_000);

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
  const run = (finishedAt: Date) => ({
    project: PROJECT_ID,
    worker: WORKER_ID,
    agent: null,
    agentName: LONG_AGENT,
    startedAt: new Date(finishedAt.getTime() - 125 * 60_000),
    finishedAt,
    costUsd: 123.45,
    createdAt: finishedAt,
    updatedAt: finishedAt,
  });
  await handle.collection("agentruns").insertMany([
    {
      ...run(new Date()),
      task: HELD_TASK_ID,
      taskKey: RECENT_KEY,
      outcome: "refused",
      refusedBy: "diff-size",
      detail: LONG_DETAIL,
    },
    {
      ...run(OLD_FINISHED_AT),
      task: FINISHED_TASK_ID,
      taskKey: OLD_KEY,
      outcome: "delivered",
      refusedBy: "",
      detail: "opened a pull request",
    },
  ]);
});

async function measure(page: Page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement!;
    const card = document.querySelector('[data-testid="fleet-runs"]') as HTMLElement;
    const rowBoxes = ["table-row", "table-row-group", "table-header-group"];
    const inside = Array.from(card.querySelectorAll<HTMLElement>("*")).filter(
      (el) => !rowBoxes.includes(getComputedStyle(el).display)
    );
    const describe = (el: HTMLElement) => `${el.tagName} "${el.textContent?.slice(0, 40)}"`;
    return {
      page: doc.scrollWidth - doc.clientWidth,
      card: card.scrollWidth - card.clientWidth,
      cardRight: card.getBoundingClientRect().right,
      viewport: doc.clientWidth,
      cutWide: inside.filter((el) => el.scrollWidth > el.clientWidth).map(describe),
      cutTall: inside.filter((el) => el.scrollHeight > el.clientHeight).map(describe),
    };
  });
}

async function expectWhollyOnScreen(page: Page, locator: ReturnType<Page["getByText"]>) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1330, height: 900 },
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`every value is shown whole, with no sideways scroll, at ${viewport.width} px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signIn(page);
    await page.goto("/settings/workers/runs");
    await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
    await expect(page.getByTestId("run-detail").first()).toBeVisible();

    const measured = await measure(page);
    expect(measured.page).toBeLessThanOrEqual(0);
    expect(measured.card).toBeLessThanOrEqual(0);
    expect(measured.cardRight).toBeLessThanOrEqual(measured.viewport);
    expect.soft(measured.cutWide).toEqual([]);
    expect.soft(measured.cutTall).toEqual([]);

    const oldDate = await page.evaluate(
      (iso) => new Date(iso).toLocaleDateString(),
      OLD_FINISHED_AT.toISOString()
    );
    const recent = page.getByTestId("fleet-run").filter({ hasText: RECENT_KEY });
    const old = page.getByTestId("fleet-run").filter({ hasText: OLD_KEY });
    await expectWhollyOnScreen(page, recent.getByText("Refused: diff-size"));
    await expectWhollyOnScreen(page, old.getByText("Pull request open"));
    await expectWhollyOnScreen(page, recent.getByText(RECENT_KEY, { exact: true }));
    await expectWhollyOnScreen(page, old.getByText(oldDate, { exact: true }));
    await expectWhollyOnScreen(page, recent.getByText("$123.45"));
    await expectWhollyOnScreen(page, recent.getByText("125 min"));
    await expectWhollyOnScreen(page, page.getByText(LONG_DETAIL));
    for (const text of [LONG_PROJECT, LONG_AGENT, LONG_MACHINE]) {
      await expectWhollyOnScreen(page, recent.getByText(text, { exact: true }));
    }
  });
}

test("the wide table keeps its column headers for assistive technology", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/settings/workers/runs");

  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Ended" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Cost" })).toBeVisible();
  const refused = table.getByRole("row").filter({ hasText: RECENT_KEY });
  await expect(refused.getByRole("cell", { name: "Refused: diff-size" })).toBeVisible();
});

test("the phone layout labels each value it shows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/settings/workers/runs");

  const refused = page.getByTestId("fleet-run").filter({ hasText: RECENT_KEY });
  for (const label of ["Project", "Agent", "Machine", "Took", "Cost"]) {
    await expect(refused.getByText(label, { exact: true })).toBeVisible();
  }
});
