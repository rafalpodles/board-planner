import { test, expect, type Page } from "@playwright/test";
import {
  NEWEST_PROJECT_ID,
  PROJECT_ID,
  NEWEST_PROJECT_KEY,
  PROJECT_KEY,
  SECOND_PROJECT_ID,
  SECOND_PROJECT_KEY,
  grantMemberOn,
  seed,
  seedNewestProject,
  seedSecondProject,
} from "./seed";
import { SAME_ORIGIN } from "./api";
import { signIn } from "./session";

test.beforeEach(async () => {
  await seed();
  await seedSecondProject();
  await seedNewestProject();
});

const announced = (page: Page) =>
  page.locator('[id^="DndLiveRegion"]').filter({ hasText: /./ }).last();

const sortableRows = (page: Page) => page.locator('aside [aria-roledescription="sortable"]');

async function keysInSidebar(page: Page): Promise<string[]> {
  return sortableRows(page).evaluateAll((rows) =>
    rows.map((row) => row.querySelector("a span:last-child")?.textContent?.trim() ?? "")
  );
}

async function storedOrder(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/projects");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { key: string }[]).map((project) => project.key);
}

async function dragFirstRowDown(
  page: Page,
  overFirst: { toString(): string },
  overNext: { toString(): string }
) {
  await sortableRows(page).first().focus();
  await page.keyboard.press("Space");
  await expect(announced(page)).toContainText(`over droppable area ${overFirst}`);

  await expect(async () => {
    const over = await announced(page).textContent();
    if (over?.includes(`over droppable area ${overFirst}`)) {
      await page.keyboard.press("ArrowDown");
    }
    await expect(announced(page)).toContainText(`over droppable area ${overNext}`, {
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  await page.keyboard.press("Space");
  await expect(announced(page)).toContainText(/was dropped/i);
}

function holdNextProjectsRead(page: Page) {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let answered = false;
  let taken = false;

  const arm = page.route(
    (url) => url.pathname === "/api/projects",
    async (route) => {
      if (taken || route.request().method() !== "GET") return route.fallback();
      taken = true;
      const response = await route.fetch();
      answered = true;
      await released;
      await route.fulfill({ response });
    }
  );

  return {
    arm,
    release: () => release(),
    issued: () =>
      expect
        .poll(() => answered, {
          message: "no GET /api/projects was issued — did the preference save re-read the list?",
          timeout: 15_000,
        })
        .toBe(true),
  };
}

test("a board dragged down the sidebar stays there, for everybody, after a reload", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/projects");
  await expect(sortableRows(page)).toHaveCount(3);

  await expect(keysInSidebar(page)).resolves.toEqual([
    NEWEST_PROJECT_KEY,
    PROJECT_KEY,
    SECOND_PROJECT_KEY,
  ]);

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects/reorder") && response.request().method() === "PUT"
  );

  await dragFirstRowDown(page, NEWEST_PROJECT_ID, PROJECT_ID);

  expect((await saved).status()).toBe(200);

  await expect
    .poll(() => keysInSidebar(page))
    .toEqual([PROJECT_KEY, NEWEST_PROJECT_KEY, SECOND_PROJECT_KEY]);

  expect(await storedOrder(page)).toEqual([
    PROJECT_KEY,
    NEWEST_PROJECT_KEY,
    SECOND_PROJECT_KEY,
  ]);

  await page.reload();
  await expect(sortableRows(page)).toHaveCount(3);
  await expect(keysInSidebar(page)).resolves.toEqual([
    PROJECT_KEY,
    NEWEST_PROJECT_KEY,
    SECOND_PROJECT_KEY,
  ]);
});

test("a member has no rows to drag, and reordering is refused if they ask anyway", async ({
  page,
}) => {
  await grantMemberOn(NEWEST_PROJECT_ID);

  await signIn(page, "member");
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.locator('aside a[href^="/projects/"]')).toHaveCount(2);

  await expect(sortableRows(page)).toHaveCount(0);

  const asMember = await page.request.put("/api/projects/reorder", {
    headers: SAME_ORIGIN,
    data: { order: [] },
  });
  expect(asMember.status()).toBe(403);

  await signIn(page, "admin");
  const asAdmin = await page.request.put("/api/projects/reorder", {
    headers: SAME_ORIGIN,
    data: { order: [] },
  });
  expect(asAdmin.status()).toBe(200);
});

const PREFERENCE = "Collapse empty columns";

test("a project read still in flight does not undo a reorder", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/preferences");
  await expect(sortableRows(page)).toHaveCount(3);
  await expect(keysInSidebar(page)).resolves.toEqual([
    NEWEST_PROJECT_KEY,
    PROJECT_KEY,
    SECOND_PROJECT_KEY,
  ]);
  await page.waitForLoadState("networkidle");

  const late = holdNextProjectsRead(page);
  await late.arm;

  await page.getByLabel(PREFERENCE).click();
  await expect(page.getByText("Preference saved")).toBeVisible();
  await late.issued();

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects/reorder") && response.request().method() === "PUT"
  );
  await dragFirstRowDown(page, NEWEST_PROJECT_ID, PROJECT_ID);
  expect((await saved).status()).toBe(200);

  const reordered = [PROJECT_KEY, NEWEST_PROJECT_KEY, SECOND_PROJECT_KEY];
  await expect.poll(() => keysInSidebar(page)).toEqual(reordered);

  const delivered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/projects" &&
      response.request().method() === "GET"
  );
  late.release();
  await delivered;

  for (let sample = 0; sample < 10; sample += 1) {
    expect(await keysInSidebar(page)).toEqual(reordered);
    await page.waitForTimeout(100);
  }

  expect(await storedOrder(page)).toEqual(reordered);

  const again = [SECOND_PROJECT_KEY, PROJECT_KEY, NEWEST_PROJECT_KEY];
  const rewritten = await page.request.put("/api/projects/reorder", {
    headers: SAME_ORIGIN,
    data: { order: [SECOND_PROJECT_ID, PROJECT_ID, NEWEST_PROJECT_ID] },
  });
  expect(rewritten.status()).toBe(200);

  const secondRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/projects" &&
      response.request().method() === "GET"
  );
  await page.getByLabel(PREFERENCE).click();
  await secondRead;

  await expect.poll(() => keysInSidebar(page)).toEqual(again);
});

test("a project read that nothing overtook is still applied", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/preferences");
  await expect(sortableRows(page)).toHaveCount(3);
  await page.waitForLoadState("networkidle");

  const reordered = [PROJECT_KEY, NEWEST_PROJECT_KEY, SECOND_PROJECT_KEY];
  const written = await page.request.put("/api/projects/reorder", {
    headers: SAME_ORIGIN,
    data: { order: [PROJECT_ID, NEWEST_PROJECT_ID, SECOND_PROJECT_ID] },
  });
  expect(written.status()).toBe(200);
  expect(await storedOrder(page)).toEqual(reordered);

  const late = holdNextProjectsRead(page);
  await late.arm;

  await page.getByLabel(PREFERENCE).click();
  await late.issued();

  await expect(keysInSidebar(page)).resolves.toEqual([
    NEWEST_PROJECT_KEY,
    PROJECT_KEY,
    SECOND_PROJECT_KEY,
  ]);

  late.release();
  await expect.poll(() => keysInSidebar(page)).toEqual(reordered);
});
