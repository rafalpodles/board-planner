import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-576. The palette of emoji was a sibling revealed by `group-hover`, and the `+` had no
 * `onClick` — so a touch screen, which never satisfies `:hover`, and a keyboard could toggle a
 * reaction somebody had already left but never start one.
 *
 * Driven with the keyboard alone and with a tap: a `click()` would have passed before the fix too,
 * because Playwright's click hovers first.
 */

const TASK = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

test.beforeEach(seed);

const addReaction = (page: Page) => page.getByRole("button", { name: "Add a reaction" });

/**
 * Leaves one comment, so there is a row to react to. Below lg the composer is the bar pinned to
 * the bottom rather than the wide form, and they carry different controls.
 */
async function comment(page: Page, body: string) {
  await page.goto(TASK);
  const wide = page.getByRole("textbox", { name: "Write a comment, @mention someone…" });
  const phone = page.getByRole("textbox", { name: "Add a comment" });
  // `count()` does not wait, so asking which composer is here before either has rendered answers
  // "the phone one" on every width
  await expect(wide.or(phone).first()).toBeVisible();
  const onPhone = (await wide.count()) === 0;
  const box = onPhone ? phone : wide;
  await expect(box).toBeVisible();
  await box.fill(body);
  const posted = page.waitForResponse(
    (r) => r.url().includes("/comments") && r.request().method() === "POST" && r.ok()
  );
  const submit = onPhone
    ? page.getByRole("button", { name: "Post comment" })
    : page.getByRole("button", { name: "Comment", exact: true });
  await submit.click();
  await posted;
  await expect(page.getByText(body)).toBeVisible();
}

test("a reaction can be started from the keyboard alone", async ({ page }) => {
  await signIn(page);
  await comment(page, "A remark to react to");

  // No pointer anywhere in this test: focus the control and press it
  await addReaction(page).focus();
  await expect(addReaction(page)).toBeFocused();
  await expect(addReaction(page)).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("Enter");

  await expect(addReaction(page)).toHaveAttribute("aria-expanded", "true");
  const cheer = page.getByRole("button", { name: "React with 🎉" });
  await expect(cheer).toBeVisible();

  const reacted = page.waitForResponse(
    (r) => r.url().includes("/comments/") && r.request().method() === "PATCH" && r.ok()
  );
  await cheer.focus();
  await page.keyboard.press("Enter");
  await reacted;

  // The reaction is on the comment, and the palette has gone
  await expect(page.getByRole("button", { name: /🎉/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "React with 🎉" })).toHaveCount(0);
});

test("Escape closes the palette and hands focus back", async ({ page }) => {
  await signIn(page);
  await comment(page, "A remark to think better of");

  await addReaction(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "React with 🎉" })).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page.getByRole("button", { name: "React with 🎉" })).toHaveCount(0);
  await expect(addReaction(page)).toBeFocused();
  await expect(addReaction(page)).toHaveAttribute("aria-expanded", "false");
});

test("a tap opens it on a touch screen, where hover never happens", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await signIn(page);
    await comment(page, "A remark from a phone");

    await addReaction(page).tap();

    await expect(page.getByRole("button", { name: "React with ❤️" })).toBeVisible();

    const reacted = page.waitForResponse(
      (r) => r.url().includes("/comments/") && r.request().method() === "PATCH" && r.ok()
    );
    await page.getByRole("button", { name: "React with ❤️" }).tap();
    await reacted;

    await expect(page.getByRole("button", { name: /❤️/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

// The control: the chips for reactions somebody already left worked before this ticket, and the
// keyboard has to reach those too — a fix that broke them would otherwise pass everything above
test("an existing reaction still toggles from the keyboard", async ({ page }) => {
  await signIn(page);
  await comment(page, "A remark reacted to twice");

  await addReaction(page).focus();
  await page.keyboard.press("Enter");
  const added = page.waitForResponse(
    (r) => r.url().includes("/comments/") && r.request().method() === "PATCH" && r.ok()
  );
  await page.getByRole("button", { name: "React with 👍" }).focus();
  await page.keyboard.press("Enter");
  await added;

  const chip = page.getByRole("button", { name: /👍/ });
  await expect(chip).toBeVisible();

  const removed = page.waitForResponse(
    (r) => r.url().includes("/comments/") && r.request().method() === "PATCH" && r.ok()
  );
  await chip.focus();
  await page.keyboard.press("Enter");
  await removed;

  await expect(page.getByRole("button", { name: /👍/ })).toHaveCount(0);
});

/**
 * The palette is anchored to the `+`, and reaction chips push the `+` rightwards as they
 * accumulate. Measured on a phone with five chips, the last two emoji sat past the comment card's
 * clip — present in the DOM, reachable by keyboard, and untappable.
 *
 * The hard case is a chip landing *while the palette is open*: `toggleReaction` PATCHes and then
 * refetches, so the chip arrives two round-trips after the tap, and the row re-flows underneath a
 * panel whose own size never changed. Held here by delaying that refetch, so the palette is
 * certainly open when the row moves.
 */
test("every emoji stays tappable when a reaction lands while the palette is open", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await signIn(page);
    await comment(page, "A remark with a row of reactions");

    // Four chips settled, so the fifth is the one that moves the row under an open palette
    for (const emoji of ["👍", "👎", "❤️", "👀"]) {
      await addReaction(page).tap();
      // Registered before the tap that causes it: a response that arrives first is one
      // `waitForResponse` never sees
      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/comments") && r.request().method() === "GET" && r.ok()
        ),
        page.getByRole("button", { name: `React with ${emoji}` }).tap(),
      ]);
      await expect(page.getByRole("button", { name: new RegExp(emoji) })).toBeVisible();
    }

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname.endsWith("/comments"),
      async (route) => {
        await held;
        await route.fallback();
      }
    );

    await addReaction(page).tap();
    // The PATCH lands; the refetch that will grow the row is held
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/comments/") && r.request().method() === "PATCH" && r.ok()
      ),
      page.getByRole("button", { name: "React with 🎉" }).tap(),
    ]);

    await addReaction(page).tap();
    await expect(page.getByRole("button", { name: "React with 😄" })).toBeVisible();
    const before = (await addReaction(page).boundingBox())!.x;

    release();
    // The fifth chip arrives and pushes the + rightwards with the palette still open
    await expect(page.getByRole("button", { name: /🎉/ })).toBeVisible();
    // `?? before` rather than `!`: the row re-renders as the chip lands, and a momentarily
    // detached button should retry rather than throw
    await expect
      .poll(async () => (await addReaction(page).boundingBox())?.x ?? before)
      .toBeGreaterThan(before);
    await expect(page.getByRole("button", { name: "React with 😄" })).toBeVisible();

    const reach = await page.evaluate(() => {
      const out: Record<string, boolean> = {};
      const where: string[] = [];
      for (const el of document.querySelectorAll('[aria-label^="React with"]')) {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out[el.getAttribute("aria-label")!] = at === el || el.contains(at);
        where.push(
          `${el.getAttribute("aria-label")} ${Math.round(r.left)}..${Math.round(r.right)} → ${
            at ? at.tagName : "null"
          }`
        );
      }
      const panel = document
        .querySelector('[aria-label="Add a reaction"]')!
        .parentElement!.querySelector<HTMLElement>('[tabindex="-1"]')!;
      const p = panel.getBoundingClientRect();
      where.push(
        `panel ${Math.round(p.left)}..${Math.round(p.right)} shift=${panel.style.transform || "none"} vw=${document.documentElement.clientWidth}`
      );
      return { out, where };
    });

    expect(Object.values(reach.out)).toHaveLength(6);
    expect(
      Object.entries(reach.out).filter(([, ok]) => !ok),
      reach.where.join("\n")
    ).toEqual([]);
  } finally {
    await context.close();
  }
});
