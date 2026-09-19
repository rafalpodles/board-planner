import { test, expect, type Page } from "@playwright/test";
import {
  LIFECYCLE_CURRENT_NAME,
  LIFECYCLE_PAST_ONE_ID,
  LIFECYCLE_PAST_ONE_NAME,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  seed,
  seedSprintLifecycle,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-655, split from BP-470. This product changes its mind twice on the way down: the sidebar
 * stops being a drawer at 768 (`md`), and the sprint picker stops being a native select at 1024
 * (`lg`). Neither of those two decisions was exercised at any width.
 *
 * The ticket said "nothing runs between 768 and 1024" and that was wrong — `board-irreversible`
 * sizes to 900 and `save-bar-keeps-its-button` sweeps 1023, both for their own reasons. What no
 * spec did was ask either *breakpoint* what it does: the drawer was opened once, in
 * `search-page.spec.ts`, only to reach the search row inside it, and the sprint select had never
 * been touched at any width at all.
 *
 * What is driven here is the half that happy-dom cannot answer for. `Sidebar.test.tsx` already
 * covers the drawer's Escape, its focus trap and its focus return; `SprintHeader.test.tsx` covers
 * the select's options and its navigation; `MobileCommentBar.test.tsx` covers posting and `⌘↵`.
 * None of them can say whether the CSS puts those controls on the screen at the width where they
 * are supposed to exist, or whether `inert` really takes the page behind the drawer away.
 *
 * The task detail's mobile summary sheet and its "More actions" menu are deliberately not here:
 * they belong to BP-474, which names them.
 */

const PHONE = { width: 390, height: 844 };
/** Between `md` and `lg`: past the drawer, short of the sprint list */
const TABLET = { width: 900, height: 800 };
const DESKTOP = { width: 1280, height: 800 };

test.beforeEach(seed);

/** What the browser will actually let the keyboard reach, which is what `inert` decides */
function focusable(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return "missing";
    el.focus();
    return document.activeElement === el ? "took the focus" : "refused the focus";
  }, selector);
}

test.describe("the drawer, below md", () => {
  test("opens, takes the page behind it away, and closes on the scrim", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page);
    await page.goto("/projects");
    // Scoped to the page, because the sidebar carries a link to the same place and that one is
    // inside the drawer — focusing it would prove the opposite of what this test is about
    const BEHIND_THE_DRAWER = '#main-content a[href="/projects/new"]';
    await expect(page.locator(BEHIND_THE_DRAWER)).toBeVisible();

    // The control behind the drawer can be reached before it opens — the control for the check
    // below, which would otherwise pass on a page that simply never had that button
    expect(await focusable(page, BEHIND_THE_DRAWER)).toBe("took the focus");

    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    // `toBeVisible` is satisfied by a drawer parked at x = -260, entirely off a 390px screen —
    // measured, with the slide-in removed: every assertion below still passed, on a drawer no
    // person could see. It slides in on a transform, so the position is the thing to wait for.
    // `search-page.spec.ts` learned this first and says what it cost.
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);

    // `inert` asserted on what it does rather than on the attribute: the page behind the drawer
    // stops answering the keyboard, which is the reason it is there (Tab used to walk straight
    // past the drawer into the page under it)
    expect(await focusable(page, BEHIND_THE_DRAWER)).toBe("refused the focus");

    // The scrim is the other way out, and the only one no unit test can press: it is painted
    // outside the drawer, so a click on it is a click on nothing
    await page.mouse.click(PHONE.width - 20, PHONE.height / 2);
    await expect(drawer).toHaveCount(0);
    expect(await focusable(page, BEHIND_THE_DRAWER)).toBe("took the focus");
  });
});

test.describe("the band between md and lg", () => {
  test.beforeEach(seedSprintLifecycle);

  test("the sprint list is gone and the name itself is the picker", async ({ page }) => {
    await page.setViewportSize(TABLET);
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/sprints`);
    await expect(page.getByTestId("sprint-name")).toHaveText(LIFECYCLE_CURRENT_NAME);

    // The column of sprints is the desktop control, and at this width it renders nothing at all
    await expect(page.getByRole("navigation", { name: "Sprint list" })).toHaveCount(0);

    // What is left is a transparent native select laid over the sprint's own name
    const picker = page.locator('[data-testid="sprint-name"] ~ select[aria-label="Sprint"]');
    await expect(picker).toBeVisible();
    // By value, not by label: an option reads "Sprint 5 · 1/2", counts and all
    await picker.selectOption(String(LIFECYCLE_PAST_ONE_ID));

    await expect(page.getByTestId("sprint-name")).toHaveText(LIFECYCLE_PAST_ONE_NAME);
    await expect(page).toHaveURL(/[?&]sprint=/);
  });

  test("and on a desktop the column is back and the select is not offered", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/sprints`);
    await expect(page.getByTestId("sprint-name")).toHaveText(LIFECYCLE_CURRENT_NAME);

    await expect(page.getByRole("navigation", { name: "Sprint list" })).toBeVisible();
    await expect(
      page.locator('[data-testid="sprint-name"] ~ select[aria-label="Sprint"]')
    ).toBeHidden();
  });
});

test.describe("the comment bar, at phone width", () => {
  test("posts from the bar pinned to the bottom", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

    const bar = page.getByLabel("Add a comment");
    await expect(bar).toBeVisible();
    await bar.fill("Written on a phone");

    const posted = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.url().includes("/comments")
    );
    await page.getByRole("button", { name: "Post comment" }).click();
    expect((await posted).ok()).toBe(true);

    await expect(page.getByText("Written on a phone")).toBeVisible();
    await expect(bar).toHaveValue("");
  });
});
