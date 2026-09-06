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

/**
 * Picks the first sortable row up from the keyboard and drops it one place down.
 *
 * `overFirst` is the row's own droppable: a sortable starts over itself, so waiting for that line
 * — rather than for either of "picked up"/"was moved" — is what proves the sensor is live and has
 * settled. `overNext` is where the row has to be before the drop, or it goes back where it came
 * from.
 */
async function dragFirstRowDown(
  page: Page,
  overFirst: { toString(): string },
  overNext: { toString(): string }
) {
  await sortableRows(page).first().focus();
  await page.keyboard.press("Space");
  await expect(announced(page)).toContainText(`over droppable area ${overFirst}`);

  // The press is retried because an arrow can still be swallowed while dnd-kit is between ticks,
  // and a lost keystroke is indistinguishable from a broken drag until the announcement names the
  // row it is now over. Retried only while the announcement still names the starting droppable,
  // though: pressing again after a press that landed walks the row past the target, and from the
  // bottom of the list no further press can bring it back
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
  // The drag is finished, not merely keyed: the drop announcement is dnd-kit's own commit signal
  await expect(announced(page)).toContainText(/was dropped/i);
}

/**
 * Lets the server answer the next `GET /api/projects` straight away — with the order it holds at
 * that moment — and hands that answer to the page only when the test releases it.
 *
 * `issued` resolves once the server has answered, which is the moment the payload is frozen: a
 * drag performed after it is a drag the read cannot have seen.
 */
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
    // Named rather than a bare hang: a read that never fires is a different failure from a read
    // that lands at the wrong moment, and the test timeout cannot tell them apart
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

  await dragFirstRowDown(page, NEWEST_PROJECT_ID, PROJECT_ID);

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

/**
 * BP-551: a `GET /api/projects` issued before the drop and delivered after it.
 *
 * `useProjectsProvider.reload()` had no sequence guard, so that read's payload — the order the
 * server held before the reorder — reached `setProjects` after the drop had already been applied,
 * and the person watched their drag undo itself. The write landed either way, so a refresh showed
 * it had been saved all along; the two disagreed only on screen.
 *
 * The read is triggered the way a person triggers one, rather than by a test-only hook: saving a
 * preference calls `refreshUser()`, which hands the provider a new `user` object and re-runs its
 * fetch effect.
 */
const PREFERENCE = "Collapse empty columns";

test("a project read still in flight does not undo a reorder", async ({ page }) => {
  await signIn(page);
  // Any screen in the shell carries the sidebar; this one because it is where a save that
  // re-reads the project list lives
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
  // The server has answered that read, so its payload predates everything below
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

  // An absence needs a window rather than one read: the revert lands a tick after the response, so
  // a single check here passes before it has rendered
  for (let sample = 0; sample < 10; sample += 1) {
    expect(await keysInSidebar(page)).toEqual(reordered);
    await page.waitForTimeout(100);
  }

  expect(await storedOrder(page)).toEqual(reordered);

  // And the drag did not stop the sidebar reading. Without this a guard that simply froze reads
  // once a reorder had happened would pass everything above, and the sidebar would show neither a
  // rename nor a new board for the rest of the session
  const again = [SECOND_PROJECT_KEY, PROJECT_KEY, NEWEST_PROJECT_KEY];
  const rewritten = await page.request.put("/api/projects/reorder", {
    headers: SAME_ORIGIN,
    data: { order: [SECOND_PROJECT_ID, PROJECT_ID, NEWEST_PROJECT_ID] },
  });
  expect(rewritten.status()).toBe(200);

  // Waited on the response, not on the toast: the first save's toast is still on screen and would
  // satisfy an assertion about the second one (BP-554)
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

  // Reordered behind the page's back, so the held read carries an order the sidebar has never
  // seen. This is the control the test above needs: a guard that dropped every read after the
  // first would keep that one green and this one red.
  //
  // Written before the hold is armed on purpose. These requests go through Playwright's own
  // context rather than the browser's network stack, so `page.route` does not see them — but that
  // is not visible here, and if it ever changed this GET would consume the hold and the test would
  // deadlock rather than fail.
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

  // Held, so the screen has not caught up — and the assertion below is about it catching up
  await expect(keysInSidebar(page)).resolves.toEqual([
    NEWEST_PROJECT_KEY,
    PROJECT_KEY,
    SECOND_PROJECT_KEY,
  ]);

  late.release();
  await expect.poll(() => keysInSidebar(page)).toEqual(reordered);
});
