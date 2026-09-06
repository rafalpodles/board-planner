import { test, expect, type Page } from "@playwright/test";
import {
  NEWEST_PROJECT_ID,
  PROJECT_ID,
  NEWEST_PROJECT_KEY,
  PROJECT_KEY,
  SECOND_PROJECT_KEY,
  grantMemberOn,
  seed,
  seedNewestProject,
  seedSecondProject,
} from "./seed";
import { SAME_ORIGIN } from "./api";
import { signIn } from "./session";

/**
 * BP-469: dragging a board up or down the sidebar.
 *
 * `ProjectTree` + `use-projects` + `PUT /api/projects/reorder` had no end-to-end test and no route
 * test either — a dnd-kit regression here reverts on the next reload with nothing going red, which
 * is exactly the failure a person would report and no test would catch.
 *
 * Driven from the keyboard, because dnd-kit's KeyboardSensor is the only sensor that can be driven
 * deterministically: a pointer drag depends on the row's height and on the 5px activation
 * constraint. The live region is both the synchronisation and the evidence that the sensor
 * actually picked the row up — see BP-455, where four separate test mistakes made a working drag
 * look broken.
 */

test.beforeEach(async () => {
  await seed();
  await seedSecondProject();
  await seedNewestProject();
});

/** dnd-kit's own announcements. `.last()` because an empty region is rendered before the first. */
const announced = (page: Page) =>
  page.locator('[id^="DndLiveRegion"]').filter({ hasText: /./ }).last();

/** The draggable rows, in the order the sidebar shows them. */
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

test("a board dragged down the sidebar stays there, for everybody, after a reload", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/projects");
  await expect(sortableRows(page)).toHaveCount(3);

  // Seeded order: NB and TP share sortOrder 0 and NB is newer, IB carries sortOrder 1
  await expect(keysInSidebar(page)).resolves.toEqual([
    NEWEST_PROJECT_KEY,
    PROJECT_KEY,
    SECOND_PROJECT_KEY,
  ]);

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects/reorder") && response.request().method() === "PUT"
  );

  await sortableRows(page).first().focus();
  await page.keyboard.press("Space");
  // Awaited between keys: the sensor starts on the next tick, and an arrow pressed before that
  // arrives while nothing has been picked up
  await expect(announced(page)).toContainText(/picked up|was moved/i);

  await page.keyboard.press("ArrowDown");
  // The drop target has to have CHANGED before the drop, or the row goes back where it came from.
  // Waited for by NAME rather than "any line but the one I captured": the announcement dnd-kit
  // makes on pick-up is itself replaced a tick later by a "moved over itself" line, which would
  // satisfy a difference check while nothing had moved
  await expect(announced(page)).toContainText(String(PROJECT_ID));
  await page.keyboard.press("Space");

  expect((await saved).status()).toBe(200);

  // Polled: the list is reordered optimistically, so a one-shot read races the render rather than
  // the request it is gated on
  await expect
    .poll(() => keysInSidebar(page))
    .toEqual([PROJECT_KEY, NEWEST_PROJECT_KEY, SECOND_PROJECT_KEY]);

  // The order is one list shared by everyone, so it belongs to the server rather than the session
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
  // Two boards, because the tree hides its handles when there is only one row to move: on a
  // one-board sidebar this test would pass with the gate removed
  await grantMemberOn(NEWEST_PROJECT_ID);

  await signIn(page, "member");
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.locator('aside a[href^="/projects/"]')).toHaveCount(2);

  // Two rows they may open and neither carries the sortable attributes dnd-kit needs
  await expect(sortableRows(page)).toHaveCount(0);

  const asMember = await page.request.put("/api/projects/reorder", {
    headers: SAME_ORIGIN,
    data: { order: [] },
  });
  expect(asMember.status()).toBe(403);

  // The control, and it is the point of the assertion above: 403 is also what the provenance guard
  // answers, so without an identical request that succeeds this test would stay green with the
  // admin gate deleted and every write refused as cross-origin
  await signIn(page, "admin");
  const asAdmin = await page.request.put("/api/projects/reorder", {
    headers: SAME_ORIGIN,
    data: { order: [] },
  });
  expect(asAdmin.status()).toBe(200);
});
