import { expect, type Locator, type Page } from "@playwright/test";

export interface HorizontalBox {
  x: number;
  width: number;
}

/** Why a box is not wholly between `left` and `right`, or null when it is. */
export function horizontalMiss(
  box: HorizontalBox | null,
  left: number,
  right: number
): string | null {
  if (!box) return "it has no box: not rendered, or display:none";
  if (box.width <= 0) return "it has no width";
  // Half a pixel either way: subpixel layout reports 390.0001 for an edge that sits on 390
  if (box.x < left - 0.5) return `it starts at ${box.x}, left of ${left}`;
  if (box.x + box.width > right + 0.5) return `it ends at ${box.x + box.width}, right of ${right}`;
  return null;
}

// The app scrolls `#main-content`, not the window, so a page that is too wide can leave the
// document itself exactly as wide as the viewport
export async function expectNoHorizontalPageScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => {
    const main = document.getElementById("main-content");
    return {
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      main: main?.scrollWidth ?? 0,
      mainVisible: main?.clientWidth ?? 0,
    };
  });
  expect(widths.document, "the document scrolls sideways").toBeLessThanOrEqual(widths.viewport);
  expect(widths.main, "the page's scrollport scrolls sideways").toBeLessThanOrEqual(widths.mainVisible);
}

/** How far the page's own heading starts above the top of the scrollport, which nothing can scroll back. */
export async function headingClippedAtTheTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.getElementById("main-content")!;
    main.scrollTop = 0;
    const heading = main.querySelector("h1");
    if (!heading) return 0;
    return Math.max(0, main.getBoundingClientRect().top - heading.getBoundingClientRect().top);
  });
}

/** Elements in the scrollport whose right edge is past the viewport, outside any sideways scroller. */
export async function cutOffAtTheRight(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = window.innerWidth + 0.5;
    const scrollsSideways = (node: Element) => {
      const overflowX = getComputedStyle(node).overflowX;
      return overflowX === "auto" || overflowX === "scroll";
    };
    const offenders: string[] = [];
    const main = document.getElementById("main-content") ?? document.body;
    for (const el of Array.from(main.querySelectorAll("*"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1 || rect.right <= limit) continue;
      let scrolled = false;
      for (let node = el.parentElement; node && node !== main; node = node.parentElement) {
        if (scrollsSideways(node)) {
          scrolled = true;
          break;
        }
      }
      if (scrolled) continue;
      const text = (el.textContent ?? "").trim().slice(0, 40);
      offenders.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}"> right=${Math.round(rect.right)} "${text}"`);
    }
    return offenders;
  });
}

async function markNearestSideScroller(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    document.querySelectorAll("[data-reachable-scroller]").forEach((node) =>
      node.removeAttribute("data-reachable-scroller")
    );
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth) {
        node.setAttribute("data-reachable-scroller", "");
        return true;
      }
    }
    return false;
  });
}

/**
 * Reachable on this screen: either inside the viewport as it loads, or inside a sideways scroller
 * and inside both the scroller and the viewport once scrolled to. Returns which, so a caller can
 * hold a table to the scrolled case and ask for the sign that it scrolls.
 */
export async function expectReachable(
  page: Page,
  target: Locator,
  name: string
): Promise<"in-place" | "scrolled"> {
  const viewportWidth = page.viewportSize()!.width;
  const miss = horizontalMiss(await target.boundingBox(), 0, viewportWidth);
  if (miss === null) return "in-place";

  expect(await markNearestSideScroller(target), `${name} is off the screen (${miss}) with nothing to scroll`).toBe(
    true
  );
  const scroller = page.locator("[data-reachable-scroller]");
  await target.evaluate((el) => el.scrollIntoView({ block: "nearest", inline: "nearest" }));

  const edges = await scroller.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  });
  const box = await target.boundingBox();
  expect(horizontalMiss(box, 0, viewportWidth), `${name}, scrolled to, is still off the screen`).toBeNull();
  expect(
    horizontalMiss(box, edges.left, edges.right),
    `${name}, scrolled to, is clipped by its scroller`
  ).toBeNull();
  return "scrolled";
}
