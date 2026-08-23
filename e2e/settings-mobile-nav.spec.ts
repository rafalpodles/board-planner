import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { ADMIN_PASSWORD, ADMIN_USERNAME, PROJECT_KEY, seed } from "./seed";

/**
 * BP-365. The fix that pinned the section switcher to the top of a phone screen was written
 * twice — once on project settings, once on account settings — and only landed on the first.
 * Both surfaces now wear the same shell, and this is what stops them drifting apart again.
 *
 * The scroll container is the app's `main`, not the window, so `window.scrollY` stays 0 no
 * matter how far the page has moved; every measurement here is taken against `main`.
 */

test.use({ viewport: { width: 390, height: 780 } });

test.beforeEach(seed);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

/** How far the pill row sits below the top of the scrollport, and how far the page has moved */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const main = document.getElementById("main-content")!;
    const nav = document.querySelector('[data-settings-nav="pills"]')!;
    return {
      scrollTop: Math.round(main.scrollTop),
      room: Math.round(main.scrollHeight - main.clientHeight),
      navOffset: Math.round(
        nav.getBoundingClientRect().top - main.getBoundingClientRect().top,
      ),
    };
  });
}

/** A freshly seeded account has one token and a page too short to scroll, which would pass by
 *  accident. Six is enough to fill a phone screen twice over. */
async function fillTheTokenList(request: APIRequestContext) {
  for (let i = 0; i < 6; i++) {
    const response = await request.post("/api/tokens", {
      headers: ADMIN_AUTH,
      data: { name: `mobile-nav-filler-${i}` },
    });
    expect(response.status(), await response.text()).toBe(201);
  }
}

const SURFACES = [
  {
    name: "project settings",
    url: `/projects/${PROJECT_KEY}/settings?section=board`,
    // The height comes from content the page fetches after it mounts, so measuring on
    // "the pills are visible" measures an empty page and finds nothing to scroll
    ready: "Drag to reorder",
  },
  {
    name: "account settings",
    url: "/settings/tokens",
    prepare: fillTheTokenList,
    ready: "mobile-nav-filler-0",
  },
];

for (const surface of SURFACES) {
  test(`the section switcher stays on screen while ${surface.name} scrolls`, async ({ page, request }) => {
    await surface.prepare?.(request);
    await signIn(page);
    await page.goto(surface.url);
    await expect(page.getByText(surface.ready, { exact: false })).toBeVisible();

    const before = await geometry(page);
    // Without room to scroll, everything below would pass by accident
    expect(before.room).toBeGreaterThan(150);
    // The control: unscrolled, the row is where the page put it — below the header
    expect(before.navOffset).toBeGreaterThan(0);

    await page.locator("#main-content").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    const after = await geometry(page);
    expect(after.scrollTop).toBeGreaterThan(150);
    expect(after.navOffset).toBe(0);
  });
}

test("the pill you tap is the pill you can still see", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/settings`);

  const row = page.locator('[data-settings-nav="pills"]');
  await row.getByRole("button", { name: "Audit log" }).click();

  await expect(page).toHaveURL(/section=audit/);
  const visible = await row.evaluate((nav) => {
    const active = nav.querySelector("[aria-current]")!.getBoundingClientRect();
    const strip = nav.getBoundingClientRect();
    return active.left >= strip.left - 1 && active.right <= strip.right + 1;
  });
  expect(visible).toBe(true);
});
