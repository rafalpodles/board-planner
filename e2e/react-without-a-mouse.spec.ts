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
