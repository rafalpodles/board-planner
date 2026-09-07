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
  // The bar slides open over 200ms (`transition-[max-height]`), and until it has finished the
  // button is clipped below its own container — `elementFromPoint` answers null there, which
  // would read as "nothing covers it". Settle on the height rather than on a timer.
  await expect
    .poll(async () => {
      const box = await saveButton(page).boundingBox();
      const viewport = page.viewportSize()!.height;
      return !!box && box.y + box.height <= viewport;
    })
    .toBe(true);
}

/** What a tap on the button's right-hand edge would actually reach */
async function rightEdgeOf(page: Page) {
  return saveButton(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.right - 3, r.top + r.height / 2);
    if (!at) return "nothing";
    if (at === el || el.contains(at)) return "Save changes";
    // The launcher's own svg is what a point lands on, so name the control rather than the tag
    return at.closest("[aria-label]")?.getAttribute("aria-label") ?? at.tagName;
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

    // The boxes, not only the probed point: a launcher that overlapped Save somewhere other than
    // its right edge would pass the check above. `:last-of-type` reads the section-jump link here
    // — the only button among its own siblings — so the assertion is made through the locator.
    const overlap = await saveButton(page).evaluate((el) => {
      const s = el.getBoundingClientRect();
      const f = document.querySelector('[aria-label="Open PM chat"]')!.getBoundingClientRect();
      return Math.max(0, Math.min(s.bottom, f.bottom) - Math.max(s.top, f.top));
    });
    expect(overlap).toBe(0);
  });
}

/**
 * A control rather than the proof: measured, this click reaches Save with the fix reverted too —
 * Playwright re-checks actionability and the overlap band does not cover the button's vertical
 * centre at every width. What discriminates is the four geometry tests above, which read the
 * point a finger actually lands on. This one is here so the save flow itself stays covered at a
 * width where the two controls are close.
 */
test("the click at that edge still saves", async ({ page }) => {
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

// The panel's own half of the raise: without it the panel ends where the raised launcher begins,
// and the launcher sits on Send — the same defect BP-591 measured over the phone comment bar
test("the PM panel clears the launcher while the save bar is open", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await signIn(page);
  await makeDirty(page);

  await launcher(page).click();
  await page.getByPlaceholder(/Message the PM/).fill("A message worth not losing");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeVisible();

  const keeps = await send.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const owns = (x: number, y: number) => {
      const at = document.elementFromPoint(x, y);
      return at === el || el.contains(at);
    };
    return {
      centre: owns(r.left + r.width / 2, r.top + r.height / 2),
      bottomEdge: owns(r.left + r.width / 2, r.bottom - 3),
      bottomRight: owns(r.right - 3, r.bottom - 3),
    };
  });
  expect(keeps).toEqual({ centre: true, bottomEdge: true, bottomRight: true });

  const panelTop = await page
    .getByTestId("pm-chat-panel")
    .evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(panelTop).toBeGreaterThanOrEqual(0);
});
