import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-597. The corner a toast lands in is shared with the PM launcher, a pinned bar and the PM
 * panel, and where each of those is depends on the viewport: `bottom-6`, `100vh - 8rem`,
 * `min(30rem, 100vw - 2rem)`. Four fixed offsets were tried before the placement was measured, and
 * each failed a viewport the others passed — so the viewports here are those four, height first,
 * because the height is what broke them.
 *
 * The measurement is `elementFromPoint` at each control's own centre: whether a finger meant for it
 * would reach it.
 */

test.beforeEach(seed);

const launcher = (page: Page) => page.getByRole("button", { name: /PM chat$/ });

async function raiseAToast(page: Page) {
  // Below lg the property rail is gone and Delete lives in the top bar's overflow (BP-298).
  // Settled on before the branch is chosen: a non-retrying count taken a tick early picks the
  // wrong one and then waits thirty seconds for a control that was never going to be there.
  const rail = page.getByRole("button", { name: /^Delete task$/ });
  const overflow = page.getByRole("button", { name: "More actions" });
  await expect(rail.or(overflow).first()).toBeVisible();
  if (await rail.isVisible()) await rail.click();
  else {
    await overflow.click();
    await page.getByRole("option", { name: "Delete task" }).click();
  }
  await page.getByRole("dialog").getByRole("button", { name: /^Delete$/ }).click();
  await expect(page.getByTestId("toast").first()).toBeVisible();
}

/** Which of the page's own controls, if any, the toast is standing on */
function covered(page: Page) {
  return page.evaluate(() => {
    const tray = document.querySelector('[data-testid="toast-tray"]')!;
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[aria-label="Open PM chat"], [aria-label="Close PM chat"], [data-corner-panel] button, [data-corner-panel] a, [data-corner-panel] textarea, [aria-label="Post comment"]'
      )
    ).filter((el) => el.getBoundingClientRect().height > 0);
    return {
      seen: controls.length,
      under: controls
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit !== null && tray.contains(hit);
        })
        .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 16) ?? "?"),
      onScreen: (() => {
        const t = tray.getBoundingClientRect();
        return t.top >= 0 && t.bottom <= window.innerHeight;
      })(),
    };
  });
}

for (const [width, height] of [
  [1280, 800],
  [1280, 960],
  [430, 932],
  [390, 844],
] as const) {
  for (const withPanel of [false, true]) {
    test(`a toast covers no control at ${width}×${height}, panel ${
      withPanel ? "open" : "closed"
    }`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await signIn(page);
      await page.route(/\/api\/projects\/[^/]+\/tasks\/[^/?]+$/, async (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"no"}' });
      });
      await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
      await expect(launcher(page)).toBeVisible();

      // Frozen before the toast is raised, so its own three seconds cannot expire while the panel
      // is opened over it and the geometry read. `Date.now()` is taken here, in the test process:
      // once the fake clock is installed the page's own clock starts from it, and pausing at an
      // instant behind that is refused.
      // A second ahead of the origin, not at it: real time flows between `install` and `pauseAt`,
      // and pausing at an instant the page has already passed is refused. Nothing is on screen yet
      // to be affected by the jump.
      const now = Date.now();
      await page.clock.install({ time: now });
      await page.clock.pauseAt(now + 1_000);

      // The toast first, then the panel: with the panel open it covers the controls that raise one
      await raiseAToast(page);
      if (withPanel) {
        await launcher(page).click();
        await expect(page.getByTestId("pm-chat-panel")).toBeVisible();
      }

      const geometry = await covered(page);
      expect(geometry.seen, "there were controls to cover").toBeGreaterThan(0);
      expect(geometry.under, "no control is under the toast").toEqual([]);
      expect(geometry.onScreen, "and the toast is still readable").toBe(true);
    });
  }
}
