import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { ADMIN_PASSWORD, ADMIN_USERNAME, PROJECT_KEY, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

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

const signIn = arriveSignedIn;

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
    // The project page keeps every section mounted, so its switcher is a button
    pill: { role: "button" as const, name: "Audit log" },
    // The height comes from content the page fetches after it mounts, so measuring on
    // "the pills are visible" measures an empty page and finds nothing to scroll
    ready: "Drag to reorder",
  },
  {
    name: "account settings",
    url: "/settings/tokens",
    // The account sections are real routes, so the same switcher is a link — the two reach the
    // scroll from different places and both have to arrive
    pill: { role: "link" as const, name: "Profile" },
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

/**
 * BP-405. `goToSection` ended with `window.scrollTo`, and the window is not the scrollport — so
 * switching a section kept the previous offset. BP-365 made it visible rather than worse: with the
 * pill row pinned you tap a section and stay parked in the middle of the last one.
 *
 * Proved by counting the call, not by reading the resulting `scrollTop`: the destination section
 * on both surfaces happens to fit the viewport exactly (scrollHeight === clientHeight), so the
 * browser clamps `scrollTop` to 0 on its own the moment the shorter content swaps in — a version of
 * this test that read the position back passed whether or not `scrollSettingsToTop` ever ran.
 */
for (const surface of SURFACES) {
  test(`choosing a section on ${surface.name} calls the scrollport's own scrollTo`, async ({
    page,
    request,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __scrolls: number };
      w.__scrolls = 0;
      const original = Element.prototype.scrollTo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Element.prototype as any).scrollTo = function (this: Element, ...args: any[]) {
        if (this.id === "main-content") w.__scrolls++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (original as any).apply(this, args);
      };
    });

    await surface.prepare?.(request);
    await signIn(page);
    await page.goto(surface.url);
    await expect(page.getByText(surface.ready, { exact: false })).toBeVisible();

    const scrolls = () =>
      page.evaluate(() => (window as unknown as { __scrolls: number }).__scrolls);
    expect(await scrolls()).toBe(0);

    await page
      .locator('[data-settings-nav="pills"]')
      .getByRole(surface.pill.role, { name: surface.pill.name })
      .click();

    await expect.poll(scrolls).toBe(1);
  });
}

// The trap the ticket names: the desktop section search switches sections on every keystroke and
// must NOT scroll, or typing yanks the page away under the reader. This is why the scroll is a call
// the caller makes rather than an effect on the shell's `active`.
//
// Counted rather than measured. Reading scrollTop cannot tell "nothing asked it to scroll" apart
// from "the section it switched to is too short to hold the offset" — the browser clamps, and a
// version of this test that read scrollTop after the click passed a page that had simply run out
// of room to prove the point either way.
test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("searching the section list does not scroll, but choosing one does", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __scrolls: number };
      w.__scrolls = 0;
      const original = Element.prototype.scrollTo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Element.prototype as any).scrollTo = function (this: Element, ...args: any[]) {
        if (this.id === "main-content") w.__scrolls++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (original as any).apply(this, args);
      };
    });

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=board`);
    await expect(page.getByText("Drag to reorder", { exact: false })).toBeVisible();

    const scrolls = () =>
      page.evaluate(() => (window as unknown as { __scrolls: number }).__scrolls);

    await page.getByLabel("Search settings").fill("audit");
    // It really did switch section — otherwise "it did not scroll" is trivially true
    await expect(page).toHaveURL(/section=audit/);
    expect(await scrolls()).toBe(0);

    // The sidebar itself filters on the query, so "Board" is off the list until it is cleared —
    // clearing it is not the thing under test, just what makes the control clickable
    await page.getByLabel("Search settings").fill("");

    // The control, in the same test: the same shell, the same section change, made deliberately
    await page
      .locator('[data-settings-nav="sidebar"]')
      .getByRole("button", { name: "Board" })
      .click();
    await expect(page).toHaveURL(/section=board/);
    await expect.poll(scrolls).toBe(1);
  });
});
