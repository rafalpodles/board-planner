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
 * spec did was ask either *breakpoint* what it does: the drawer had been opened once, in
 * `search-page.spec.ts` at phone width, only to reach the search row inside it, and the sprint
 * select had never been touched at any width at all.
 *
 * So the tests below are at three widths and only two of them are about the band. 800 is where the
 * sidebar has stopped being a drawer; 900 is where the sprint picker has not yet stopped being a
 * select; 390 is a phone, and the two tests there are the drawer's own behaviour and the comment
 * bar, neither of which the band has anything to say about. Each has its control at a width on the
 * other side of the breakpoint it names, because a test that only ever looks at one width cannot
 * tell a rule from a coincidence.
 *
 * What is driven here is the half that happy-dom cannot answer for. `Sidebar.test.tsx` already
 * covers the drawer's Escape, its focus trap and its focus return; `SprintHeader.test.tsx` covers
 * the select's options and its navigation; `MobileCommentBar.test.tsx` covers posting and `⌘↵`.
 * None of them can say whether the CSS puts those controls on the screen at the width where they
 * are supposed to exist, or whether `inert` really takes the page behind the drawer away.
 *
 * The task detail's mobile summary sheet is not here: BP-474 names it. Its "More actions" menu is
 * not here either, and not for that reason — `board-irreversible.spec.ts` already drives it at 900,
 * which is worth knowing before BP-474 writes it a third time.
 */

const PHONE = { width: 390, height: 844 };
/** Just past `md`: the sidebar is part of the layout again, and nothing had ever checked that */
const PAST_THE_DRAWER = { width: 800, height: 800 };
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
    // outside the drawer, so a click on it is a click on nothing. Aimed from the drawer's own box
    // rather than at a pair of numbers that would quietly start landing on the drawer if it ever
    // got wider.
    const box = (await drawer.boundingBox())!;
    await page.mouse.click((box.x + box.width + PHONE.width) / 2, box.y + box.height / 2);
    await expect(drawer).toHaveCount(0);
    expect(await focusable(page, BEHIND_THE_DRAWER)).toBe("took the focus");
  });
});

test.describe("the sidebar, once the drawer is over", () => {
  test("at 800 there is no hamburger and the sidebar is not a dialog", async ({ page }) => {
    await page.setViewportSize(PAST_THE_DRAWER);
    await signIn(page);
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

    // Above md the sidebar is part of the layout and owes the page nothing: no way to open it,
    // because it was never shut, and none of the modal contract it wears as a drawer
    await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
    // And it is there as layout rather than as something waiting to be opened. Not asserted as
    // "no dialog": above md the role is never set, so that check could only fail once the line
    // above already had — `Sidebar.test.tsx` pins the modal contract itself.
    await expect(page.getByRole("link", { name: "My Tasks" })).toBeVisible();
  });

  // The control, one breakpoint down: the same page owes exactly the opposite
  test("at 700 the hamburger is back", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await signIn(page);
    await page.goto("/projects");

    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
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
    // Counted first: `toBeHidden` is equally happy with a picker that stopped being rendered at
    // all, which is a different bug wearing this test's green
    const picker = page.locator('[data-testid="sprint-name"] ~ select[aria-label="Sprint"]');
    await expect(picker).toHaveCount(1);
    await expect(picker).toBeHidden();
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

  // The control the CSS actually needs: the bar is `lg:hidden`, and without this the rule could be
  // deleted and the bar would sit on top of the desktop composer with every test still green
  test("and is not offered on a desktop, where the page has its own composer", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    // The desktop composer, which is both the gate for "the comments have rendered" and the thing
    // the bar would be sitting on top of if the rule below were dropped. Not the heading: the task
    // screen renders `<Comments hideHeading>`, so that branch could never match.
    await expect(page.getByPlaceholder("Write a comment, @mention someone…")).toBeVisible();

    const bar = page.getByLabel("Add a comment");
    await expect(bar).toHaveCount(1);
    await expect(bar).toBeHidden();
  });
});
