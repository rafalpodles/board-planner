import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_USERNAME,
  DECOY_TASK_ID,
  DECOY_TASK_TITLE,
  MEMBER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
} from "./seed";
import { signIn } from "./session";
import { avatarColorIndex } from "../src/lib/avatar-color";

/**
 * BP-1063. Every initials avatar was the same tint, so two people on a board read alike. A person's
 * colour now comes from their username, so it has to be the same on every surface that draws them.
 *
 * Compared as computed colours rather than as the `--avatar-N` string in the style attribute: the
 * string is what the code intends, the computed value is what the person sees, and a palette
 * variable that never reaches the stylesheet leaves the first intact and the second transparent.
 */

test.beforeEach(async ({ request }) => {
  await seed();
  for (const [taskId, assignee] of [
    [SIBLING_TASK_ID, ADMIN_USERNAME],
    [DECOY_TASK_ID, MEMBER_USERNAME],
  ] as const) {
    const res = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${taskId}`, {
      headers: ADMIN_AUTH,
      data: { assignee },
    });
    expect(res.ok()).toBe(true);
  }
});

const BOARD = `/projects/${PROJECT_KEY}`;

const backgroundOf = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundColor);

async function paletteColour(page: Page, username: string) {
  return page.evaluate((index) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = `var(--avatar-${index})`;
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, avatarColorIndex(username));
}

const TRANSPARENT = /^(rgba\(0, 0, 0, 0\)|transparent)$/;

async function expectPersonColour(page: Page, avatar: Locator, username: string) {
  await expect(avatar).toBeVisible();
  const shown = await backgroundOf(avatar);
  expect(shown).not.toMatch(TRANSPARENT);
  expect(shown).toBe(await paletteColour(page, username));
}

test("a person has one colour on the board card, in the list, on the task and in the sidebar", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(BOARD);

  const adminCard = page.getByRole("link", { name: new RegExp(SIBLING_TASK_TITLE) });
  const memberCard = page.getByRole("link", { name: new RegExp(DECOY_TASK_TITLE) });
  const adminOnCard = adminCard.locator('span[style*="--avatar-"]');
  const memberOnCard = memberCard.locator('span[style*="--avatar-"]');

  await expectPersonColour(page, adminOnCard, ADMIN_USERNAME);
  await expectPersonColour(page, memberOnCard, MEMBER_USERNAME);
  // The control: two different people are two different colours, not one tint
  expect(await backgroundOf(adminOnCard)).not.toBe(await backgroundOf(memberOnCard));

  await expectPersonColour(
    page,
    page.getByRole("button", { name: /^Account menu/ }).locator('span[style*="--avatar-"]'),
    ADMIN_USERNAME
  );

  await page.getByRole("button", { name: "List", exact: true }).click();
  const adminRow = page.getByRole("row", { name: new RegExp(SIBLING_TASK_TITLE) });
  const memberRow = page.getByRole("row", { name: new RegExp(DECOY_TASK_TITLE) });
  await expectPersonColour(page, adminRow.locator('span[style*="--avatar-"]').first(), ADMIN_USERNAME);
  await expectPersonColour(page, memberRow.locator('span[style*="--avatar-"]').first(), MEMBER_USERNAME);

  await page.goto(`${BOARD}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);
  await expectPersonColour(
    page,
    page.getByRole("combobox", { name: /^Assignee/ }).locator('span[style*="--avatar-"]'),
    ADMIN_USERNAME
  );
});

test("the colour follows the theme: a different shade in light than in dark", async ({ page }) => {
  await signIn(page);
  await page.goto(BOARD);
  const avatar = page
    .getByRole("link", { name: new RegExp(SIBLING_TASK_TITLE) })
    .locator('span[style*="--avatar-"]');

  await page.emulateMedia({ colorScheme: "dark" });
  await expectPersonColour(page, avatar, ADMIN_USERNAME);
  const dark = await backgroundOf(avatar);

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => backgroundOf(avatar)).not.toBe(dark);
  await expectPersonColour(page, avatar, ADMIN_USERNAME);
});
