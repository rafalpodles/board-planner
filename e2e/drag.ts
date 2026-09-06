import { expect, type Locator, type Page } from "@playwright/test";

export interface DragOptions {
  atTop?: boolean;
  duringDrag?: () => Promise<void>;
}

async function box(locator: Locator, what: string) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`${what} has no box — it is not rendered, so no drag can start on it`);
  return rect;
}

export async function dragTo(
  page: Page,
  card: Locator,
  target: Locator,
  { atTop = false, duringDrag }: DragOptions = {}
) {
  await expect(card).toBeVisible();
  await expect(target).toBeVisible();

  await target.scrollIntoViewIfNeeded();

  const to = await box(target, "the drop target");
  const from = await box(card, "the card being dragged");

  const viewport = page.viewportSize();
  if (viewport) {
    for (const [what, rect] of [["card", from], ["target", to]] as const) {
      const offscreen =
        rect.x + rect.width <= 0 ||
        rect.x >= viewport.width ||
        rect.y + rect.height <= 0 ||
        rect.y >= viewport.height;
      if (offscreen) {
        throw new Error(
          `the ${what} is off-screen (x ${Math.round(rect.x)}..${Math.round(rect.x + rect.width)}, ` +
            `y ${Math.round(rect.y)}..${Math.round(rect.y + rect.height)} against ` +
            `${viewport.width}x${viewport.height}) — a real drag cannot reach it`
        );
      }
    }
  }

  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width / 2;
  const endY = atTop
    ? to.y + 6
    : Math.min(to.y + to.height - 20, (viewport?.height ?? to.y + to.height) - 10);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 20, startY + 10, { steps: 6 });
  await page.mouse.move(endX, endY, { steps: 20 });
  await page.mouse.move(endX, endY);

  if (duringDrag) await duringDrag();

  await page.mouse.up();
}
