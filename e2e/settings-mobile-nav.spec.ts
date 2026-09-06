import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { ADMIN_PASSWORD, ADMIN_USERNAME, PROJECT_KEY, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

test.use({ viewport: { width: 390, height: 780 } });

test.beforeEach(seed);

const signIn = arriveSignedIn;

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
    pill: { role: "button" as const, name: "Audit log" },
    ready: "Drag to reorder",
  },
  {
    name: "account settings",
    url: "/settings/tokens",
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
    expect(before.room).toBeGreaterThan(150);
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
    await expect(page).toHaveURL(/section=audit/);
    expect(await scrolls()).toBe(0);

    await page.getByLabel("Search settings").fill("");

    await page
      .locator('[data-settings-nav="sidebar"]')
      .getByRole("button", { name: "Board" })
      .click();
    await expect(page).toHaveURL(/section=board/);
    await expect.poll(scrolls).toBe(1);
  });
});
