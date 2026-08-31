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
 * One helper rather than two. The two copies did not disagree — both carried the same false claim —
 * but they had drifted on how strictly each checked the result, which is the same maintenance
 * problem arriving quietly.
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

  // Named rather than left to look like a failed drop: if either end is off the screen, no amount
  // of aiming fixes it and the spec needs a wider viewport or a scroll of its own. Both axes,
  // because a card below the fold produces the same silent no-drag as one off to the right.
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
  // Low in the target, not in the middle of it. The column appends at the end only when the drop
  // lands on the body itself — `closest("[data-column-body]") === e.target` in Column's dragover;
  // the sibling test there is against the column, not the body — and the middle of a column that
  // holds cards is a card, which computes an insertion index beside that card instead. The
  // hand-dispatched version aimed its dragover straight at the body and so never had to choose.
  //
  // Six pixels rather than three on the `atTop` path: rendering the insertion marker shifts the
  // card down two, and three left about one pixel of headroom for the dragover that follows.
  //
  // The clamp is for a body running past the fold, which no current spec produces. It keeps the
  // pointer on screen; it does NOT keep it on the body's empty part, so a spec that hits it wants
  // to check where its drop actually landed.
  const endY = atTop
    ? to.y + 6
    : Math.min(to.y + to.height - 20, (viewport?.height ?? to.y + to.height) - 10);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Neither of the next two lines is load-bearing here — removing either leaves all 25 tests green,
  // because the stepped move to the target emits sixteen dragovers on its own. They are kept as
  // insurance on a slower machine, and labelled so nobody reads them as a mechanism the drop needs.
  await page.mouse.move(startX + 20, startY + 10, { steps: 6 });
  await page.mouse.move(endX, endY, { steps: 20 });
  await page.mouse.move(endX, endY);

  if (duringDrag) await duringDrag();

  await page.mouse.up();
}
