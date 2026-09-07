import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-593. The settings save bar is pinned to the bottom and its **Save changes** button sits at
 * the right-hand end — where the PM launcher is painted. Both are `z-40` and the launcher is
 * rendered after the page, so it won: measured before the fix, a tap on the button's right edge
 * opened the PM chat at every width from 420 up, 31–37px of the button deep.
 *
 * The launcher steps over the bar while it is open. Unlike the phone comment bar there is no
 * width scope: this bar knows when it is open, and the collision was at every width.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

test.beforeEach(seed);

const launcher = (page: Page) => page.getByRole("button", { name: /PM chat$/ });
const saveButton = (page: Page) => page.getByRole("button", { name: "Save changes" });

/** Dirties the section so the bar opens, without saving anything */
async function makeDirty(page: Page) {
  await page.goto(SETTINGS);
  const field = page.getByRole("textbox").first();
  await expect(field).toBeVisible();
  await field.fill("Dirtied by the spec");
  await expect(saveButton(page)).toBeVisible();
  // The bar is sticky inside the settings column, which is taller than the window here: a reader
  // scrolls to it, and `elementFromPoint` answers null for anything past the viewport's edge
  await saveButton(page).scrollIntoViewIfNeeded();
  await expect
    .poll(async () => {
      const box = await saveButton(page).boundingBox();
      return box ? box.y + box.height <= 800 : false;
    })
    .toBe(true);
}

/** What a tap on the button's right-hand edge would actually reach */
async function rightEdgeOf(page: Page) {
  return saveButton(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.right - 3, r.top + r.height / 2);
    if (!at) return "nothing";
    return at === el || el.contains(at) ? "Save changes" : at.getAttribute("aria-label") ?? at.tagName;
  });
}

// 700px is where the overlap measured 36px before the fix; 1023 and 1280 collided too
for (const width of [420, 700, 1023, 1280]) {
  test(`Save changes keeps its own right edge at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await makeDirty(page);
    await expect(launcher(page)).toBeVisible();

    expect(await rightEdgeOf(page)).toBe("Save changes");

    const overlap = await page.evaluate(() => {
      const save = document.querySelector('[data-pinned-save-bar] button:last-of-type')!;
      const fab = document.querySelector('[aria-label="Open PM chat"]')!;
      const s = save.getBoundingClientRect();
      const f = fab.getBoundingClientRect();
      return Math.max(0, Math.min(s.bottom, f.bottom) - Math.max(s.top, f.top));
    });
    expect(overlap).toBe(0);
  });
}

// A real click, at the point the launcher used to own: it has to save rather than open the chat
test("a click on that edge saves rather than opening the chat", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await signIn(page);
  await makeDirty(page);

  const box = await saveButton(page).boundingBox();
  const saved = page.waitForResponse(
    (r) => r.url().includes(`/api/projects/${PROJECT_KEY}`) && r.request().method() === "PUT"
  );
  await saveButton(page).click({ position: { x: (box?.width ?? 10) - 4, y: (box?.height ?? 10) / 2 } });
  await saved;

  await expect(page.getByText(/^🤖 PM — /)).toHaveCount(0);
});

// The control: with nothing to save the bar is collapsed, and the launcher stays where it was
test("a settings page with nothing to save does not raise the launcher", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await signIn(page);
  await page.goto(SETTINGS);
  await expect(launcher(page)).toBeVisible();
  await expect(saveButton(page)).toHaveCount(0);

  const bottom = await page.evaluate(
    () => getComputedStyle(document.querySelector('[aria-label="Open PM chat"]')!).bottom
  );
  expect(bottom).toBe("24px");
});
