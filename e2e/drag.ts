import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A drag the browser actually runs.
 *
 * Two specs used to dispatch `dragstart`/`dragover`/`drop` by hand with a `DataTransfer` built in
 * page script, above docblocks asserting that Chromium runs drags on the OS and Playwright's mouse
 * cannot drive them. That is false, and it was measured false: `page.mouse` produces the whole
 * chain — `dragstart → dragenter → dragover → drop → dragend` — and the server writes the move.
 * What the synthetic version tested was that the app's own handlers do what the app's own handlers
 * do; it would have stayed green with dragging broken in the browser (BP-493).
 *
 * One helper rather than two, because the two copies had already drifted into contradicting each
 * other about the same browser.
 */

/** Where in the target to release. `atTop` puts the pointer above a card's midpoint, which is how
 * the column computes an insertion position before it rather than after. */
export interface DragOptions {
  atTop?: boolean;
  /** Runs while the button is still down, so it can assert what the page shows mid-drag. */
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

  // The board scrolls horizontally and seven columns do not fit in 1280: ready_to_test sits at
  // x=1357 on a fresh board, so a drag aimed at it lands outside the window, the chain ends at
  // `dragenter:main` with no `drop`, and the spec reads exactly like the product being broken.
  // A person scrolls to see where they are dropping, so the drag does too.
  await target.scrollIntoViewIfNeeded();

  const to = await box(target, "the drop target");
  const from = await box(card, "the card being dragged");

  // Named rather than left to look like a failed drop: if the two cannot share the screen, no
  // amount of aiming fixes it and the spec needs a wider viewport.
  const viewport = page.viewportSize();
  if (viewport) {
    for (const [what, rect] of [["card", from], ["target", to]] as const) {
      if (rect.x < 0 || rect.x + rect.width > viewport.width) {
        throw new Error(
          `the ${what} is off-screen (x ${Math.round(rect.x)}..${Math.round(rect.x + rect.width)} ` +
            `against a ${viewport.width}px viewport) — a real drag cannot reach it`
        );
      }
    }
  }

  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width / 2;
  const endY = atTop ? to.y + 3 : to.y + Math.min(to.height / 2, 80);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // A short first move opens the drag session; jumping straight to the target can be taken as a
  // click that happened to end elsewhere.
  await page.mouse.move(startX + 20, startY + 10, { steps: 6 });
  await page.mouse.move(endX, endY, { steps: 20 });
  // Twice at the destination: the last `dragover` is what leaves the column's insertion state in
  // the shape the drop reads.
  await page.mouse.move(endX, endY);

  if (duringDrag) await duringDrag();

  await page.mouse.up();
}
