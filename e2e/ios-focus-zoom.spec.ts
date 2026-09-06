import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

test.beforeEach(seed);

const signIn = arriveSignedIn;

const IOS_FLOOR = 16;

async function textEntryControls(page: Page) {
  return page.evaluate(() => {
    const zoomable = (el: Element) => {
      if (el.tagName === "SELECT" || el.tagName === "TEXTAREA") return true;
      const type = (el as HTMLInputElement).type;
      return !["checkbox", "radio", "range", "color", "file", "button", "submit"].includes(type);
    };
    return [...document.querySelectorAll("input, select, textarea")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return (r.width > 0 || r.height > 0) && zoomable(el);
      })
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type ?? null,
        label: el.getAttribute("aria-label") ?? (el as HTMLInputElement).placeholder ?? null,
        fontSize: parseFloat(getComputedStyle(el).fontSize),
      }));
  });
}

async function expectTouchEmulated(page: Page) {
  const coarse = await page.evaluate(
    () => matchMedia("(hover: none) and (pointer: coarse)").matches,
  );
  expect(coarse, "this run is not presenting as a touch device, so the rule cannot apply").toBe(
    true,
  );
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test("nothing the board offers is small enough for iOS to zoom", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
    await expectTouchEmulated(page);

    const controls = await textEntryControls(page);
    expect(controls.length, "no controls found — the selector, not the page, is wrong").toBeGreaterThan(0);
    expect(controls.filter((c) => c.fontSize < IOS_FLOOR)).toEqual([]);
  });

  test("nor anything in the task form, which is where the controls are", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);
    await page.getByRole("button", { name: "New task" }).click();
    await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
    await expectTouchEmulated(page);

    const controls = await textEntryControls(page);
    expect(controls.length).toBeGreaterThan(5);
    expect(controls.filter((c) => c.fontSize < IOS_FLOOR)).toEqual([]);
  });

  test("a button is left alone — it never triggered the zoom", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);

    const filters = page.getByRole("button", { name: "Filters", exact: true });
    await expect(filters).toBeVisible();
    const size = await filters.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeLessThan(IOS_FLOOR);
  });
});

test.describe("with a mouse", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the floor does not apply, so the desktop keeps its own sizes", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);

    const sort = page.locator('select[aria-label="Sort tasks by"]');
    await expect(sort).toBeVisible();
    const size = await sort.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, "the rule is gated on a coarse pointer and must not reach a desktop").toBeLessThan(
      IOS_FLOOR,
    );
  });
});
