import { test, expect, type Locator, type Page, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { db } from "./notification-grid";
import {
  ADMIN_USERNAME,
  DECOY_TASK_ID,
  DECOY_TASK_NUMBER,
  FINISHED_TASK_ID,
  FINISHED_TASK_NUMBER,
  MEMBER_ID,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-658. Linking two tasks wrote nothing anywhere: no history row, no notification, no webhook —
 * the only write to a task reachable from MCP with no entry in its own history.
 *
 * The case driven here is the one that cost somebody else something. A task has one parent, so
 * re-parenting it under a new epic pulls it out of the old one — on `main` by an `updateMany` that
 * named the old epic nowhere, and since this change by a write per parent that does. Three tasks
 * change, only two are in the request, and before this the third had no record of it at all.
 *
 * Each task's history is read on its own screen, because a row written against the wrong task is
 * exactly the defect that a single-screen assertion cannot see.
 *
 * ## Mutation registry
 *
 * Each was applied to the current implementation, run, and reverted; the tests named are the ones
 * that actually went red, not the ones that were expected to. The baseline was checked at 7 green
 * before each, because a run whose dev server never started also reports no failures.
 *
 *  1. drop the target end's row in `announce`        → 3 red: "the task that moved", and both
 *                                                      removal tests. Every screen that reads a
 *                                                      history written against the OTHER end.
 *  2. `activity/route.ts` sorts on `createdAt` alone → 1 red: "the task that moved". Read this one
 *                                                      as weaker than the others: with the tie
 *                                                      dropped the order is UNSPECIFIED, not
 *                                                      wrong, and the planner may still satisfy
 *                                                      it from the index in the order the test
 *                                                      wants. A green here later would not mean
 *                                                      the tie-break had stopped being needed.
 *  3. `logActivities` given the rows reversed        → 1 red: the same test, from the other side —
 *                                                      the tie-break is only worth something if
 *                                                      the rows are inserted in the right order.
 *  4. reverting `TaskDetail`/`TaskActivityPanel` to  → 1 red, and only that one: "appears without
 *     the branch base, alone                           a reload". The two halves are independent.
 *
 * **Three mutations this file does NOT kill, and where they are killed instead.** Every scenario
 * here gives the child exactly ONE previous parent, which is all a browser can produce, so the
 * detach loop never iterates:
 *
 *  - stopping the detach after the first parent, and dropping the loop's `_id` exclusion from its
 *    filter, both leave all 7 green. `src/lib/task-links.test.ts` builds a child with two parents
 *    and a no-op re-parent, and kills both there.
 *  - so do the two guards a concurrent request is needed to reach: the exclusion that stops an
 *    epic being detached twice when somebody else re-parents the same child mid-loop, and reading
 *    the REPLACED relation's type from the write that removed it rather than from the read before
 *    it. A browser produces neither, and both are killed in the unit test.
 *  - `returnDocument: "before"` → `"after"` in the detach kills nothing anywhere, and that is
 *    correct: the announce reads only fields `$pull` does not touch, so the two images are the
 *    same document. What the detach rests on is the match, not the image.
 *
 * An earlier draft of this block claimed a removal from the wrong end was "unreachable from a
 * browser". It is not, and the claim was being used to skip a test: `TaskLinks` folds an incoming
 * `relates` into the same removable section as an outgoing one, so the × is there for both. The
 * last test below drives it.
 *
 * Also not pinned here: the webhook. `isAllowedWebhookUrl` refuses an http destination and the
 * receiver stub is http on 127.0.0.1, so no delivery can land in this rig at all —
 * `external-integrations.spec.ts` asserts exactly that. `src/lib/task-links.test.ts` asserts the
 * payload `dispatchWebhooks` is handed, which is as close as this repo can get.
 */

const taskUrl = (n: number) => `/projects/${PROJECT_KEY}/tasks/${n}`;

/**
 * The timeline names the actor by `fullName`, the notification by `username`. Both are asserted
 * exactly, because "admin" is a substring of "E2E Admin" and `getByText` matches substrings
 * case-insensitively — so a loose assertion here passes whichever of the two the code used.
 */
const ADMIN_FULL_NAME = "E2E Admin";
const exactly = (page: Page | Locator, text: string) => page.getByText(text, { exact: true });

test.beforeEach(seed);

/**
 * The task's History tab, once its rows are really in.
 *
 * NOT `expect(panel.getByText("No history yet")).toBeHidden()`: that line is gated on
 * `!failed && !reading && logs.length === 0`, so while the read is in flight it is absent — and
 * `toBeHidden` passes on an element that is not there. The assertion held before the fetch, during
 * it and after it, which also left the "Show all" read below racing a list that had not loaded.
 * Waiting for the first row is a signal only an answered read can give.
 */
async function openHistory(page: Page, taskNumber: number) {
  await page.goto(taskUrl(taskNumber));
  await page.getByRole("tab", { name: /^History/ }).click();
  const panel = page.locator("#task-panel-history");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("time").first()).toBeVisible();
  const showAll = page.getByRole("button", { name: /Show all \d+ entries/ });
  if (await showAll.isVisible()) await showAll.click();
  return panel;
}

/** Setup, through the route the MCP tool uses: TP-4 becomes the parent of TP-3. */
async function parent(request: APIRequestContext, parentId: string, childId: string) {
  const response = await request.post(
    `/api/projects/${PROJECT_KEY}/tasks/${parentId}/links`,
    { headers: ADMIN_AUTH, data: { taskId: childId, type: "parent_of" } }
  );
  expect(response.status(), await response.text()).toBe(200);
}

/** Re-parents TP-3 under TP-2 by hand, from TP-2's own screen. */
async function reParentThroughTheUI(page: Page) {
  await signIn(page);
  await page.goto(taskUrl(DECOY_TASK_NUMBER));
  await page.getByRole("button", { name: "+ Add dependency" }).click();

  await page.getByLabel("Link type").selectOption("parent_of");
  await page.getByLabel("Search tasks to link").fill(`${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`);

  // Armed before the click: the row renders optimistically, and the history this test is about is
  // written on the server side of that write.
  const linked = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes(`/tasks/${DECOY_TASK_ID}/links`)
  );
  await page.getByRole("button", { name: new RegExp(`${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`) }).click();
  expect((await linked).status()).toBe(200);
}

test.describe("a re-parent through the UI", () => {
  test("is written on the epic it left, which the request never named", async ({
    page,
    request,
  }) => {
    await parent(request, String(FINISHED_TASK_ID), String(SIBLING_TASK_ID));
    await reParentThroughTheUI(page);

    const history = await openHistory(page, FINISHED_TASK_NUMBER);

    // The control, on the same screen and from the same run: TP-4 gaining the child is recorded
    // too, so a silence below cannot be a history panel that renders no link rows at all.
    await expect(
      exactly(history, `${ADMIN_FULL_NAME} made this task the parent of ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`)
    ).toBeVisible();
    await expect(
      exactly(
        history,
        `${ADMIN_FULL_NAME} removed ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} from this task's children`
      )
    ).toBeVisible();
  });

  test("is written on the task that moved, from its own side", async ({ page, request }) => {
    await parent(request, String(FINISHED_TASK_ID), String(SIBLING_TASK_ID));
    await reParentThroughTheUI(page);

    const history = await openHistory(page, SIBLING_TASK_NUMBER);

    await expect(
      exactly(
        history,
        `${ADMIN_FULL_NAME} made ${PROJECT_KEY}-${DECOY_TASK_NUMBER} the parent of this task`
      )
    ).toBeVisible();
    await expect(
      exactly(
        history,
        `${ADMIN_FULL_NAME} removed this task from ${PROJECT_KEY}-${FINISHED_TASK_NUMBER}'s children`
      )
    ).toBeVisible();

    // And in that order. Both rows are written inside one millisecond, so `createdAt` alone leaves
    // the pair arbitrary and half the time this screen says the task lost its old parent AFTER
    // gaining its new one. The list is newest-first, so the gain belongs above the loss.
    const gained = `${ADMIN_FULL_NAME} made ${PROJECT_KEY}-${DECOY_TASK_NUMBER} the parent of this task`;
    const lost = `${ADMIN_FULL_NAME} removed this task from ${PROJECT_KEY}-${FINISHED_TASK_NUMBER}'s children`;
    const shown = await history.innerText();
    expect(shown).toContain(gained);
    expect(shown.indexOf(gained)).toBeLessThan(shown.indexOf(lost));
  });

  // The panel is on screen when the link is made, and reloading to see what just happened is not
  // a trace the person who made it will ever look for.
  test("appears without a reload on the screen the link was made from", async ({ page }) => {
    await signIn(page);
    await page.goto(taskUrl(DECOY_TASK_NUMBER));
    await page.getByRole("tab", { name: /^History/ }).click();
    await expect(page.locator("#task-panel-history")).toBeVisible();

    await page.getByRole("button", { name: "+ Add dependency" }).click();
    await page.getByLabel("Link type").selectOption("relates");
    await page.getByLabel("Search tasks to link").fill(`${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`);
    const linked = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().includes(`/tasks/${DECOY_TASK_ID}/links`)
    );
    await page
      .getByRole("button", { name: new RegExp(`${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`) })
      .click();
    expect((await linked).status()).toBe(200);

    await expect(
      exactly(
        page.locator("#task-panel-history"),
        `${ADMIN_FULL_NAME} linked this task to ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`
      )
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("the bell", () => {
  test("reaches the watcher of the epic that lost a child", async ({ page, request }) => {
    await parent(request, String(FINISHED_TASK_ID), String(SIBLING_TASK_ID));
    // Setup: somebody other than the actor has to be attached to TP-4, or there is no recipient
    // for the dispatch to resolve and the silence would be the fixture's, not the product's.
    await (await db())
      .collection("tasks")
      .updateOne({ _id: FINISHED_TASK_ID }, { $addToSet: { watchers: MEMBER_ID } });

    await reParentThroughTheUI(page);

    const member = await page.context().browser()!.newContext();
    const theirs = await member.newPage();
    await signIn(theirs, "member");

    const expected = `${ADMIN_USERNAME} removed ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} from ${PROJECT_KEY}-${FINISHED_TASK_NUMBER}'s children`;
    // Notification writes are fire-and-forget: the request that caused one has already answered by
    // the time the row exists, so this reloads until the server has it rather than reading once.
    await expect(async () => {
      await theirs.goto("/notifications");
      await expect(exactly(theirs, expected)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });

    // The type chip beside it: the only screen that names a notification type, and the one place
    // a new row shows up as its raw key
    await expect(theirs.getByText("Dependency").first()).toBeVisible();

    await member.close();
  });

  // The control for the row above: the person who made the link is not told about their own act
  test("does not tell the person who made the link", async ({ page, request }) => {
    await parent(request, String(FINISHED_TASK_ID), String(SIBLING_TASK_ID));
    await (await db())
      .collection("tasks")
      .updateOne({ _id: FINISHED_TASK_ID }, { $addToSet: { watchers: MEMBER_ID } });

    await reParentThroughTheUI(page);

    const member = await page.context().browser()!.newContext();
    const theirs = await member.newPage();
    await signIn(theirs, "member");
    const expected = `${ADMIN_USERNAME} removed ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} from ${PROJECT_KEY}-${FINISHED_TASK_NUMBER}'s children`;
    await expect(async () => {
      await theirs.goto("/notifications");
      await expect(exactly(theirs, expected)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await member.close();

    // Only now, with the dispatch proven to have run, is the admin's empty feed evidence — and
    // only once the screen is known to have rendered. `toHaveCount(0)` retries toward its starting
    // state, so a page that 500s or never finishes loading satisfies it just as well as an
    // actually empty feed.
    await page.goto("/notifications");
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
    await expect(page.getByText("No notifications yet.")).toBeVisible();
    await expect(exactly(page, expected)).toHaveCount(0);
  });
});

test.describe("removal", () => {
  test("from the end that holds it is recorded at both ends", async ({ page, request }) => {
    await parent(request, String(DECOY_TASK_ID), String(SIBLING_TASK_ID));

    await signIn(page);
    await page.goto(taskUrl(DECOY_TASK_NUMBER));
    const removed = page.waitForResponse(
      (r) => r.request().method() === "DELETE" && r.url().includes(`/tasks/${DECOY_TASK_ID}/links`)
    );
    await page
      .getByRole("button", { name: `Unlink ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` })
      .click();
    expect((await removed).status()).toBe(200);

    const mine = await openHistory(page, DECOY_TASK_NUMBER);
    await expect(
      exactly(
        mine,
        `${ADMIN_FULL_NAME} removed ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} from this task's children`
      )
    ).toBeVisible();

    const theirs = await openHistory(page, SIBLING_TASK_NUMBER);
    await expect(
      exactly(
        theirs,
        `${ADMIN_FULL_NAME} removed this task from ${PROJECT_KEY}-${DECOY_TASK_NUMBER}'s children`
      )
    ).toBeVisible();
  });
});

/**
 * The end that does NOT hold the link. `relates` is symmetric to a reader, so `TaskLinks` folds
 * an incoming one into the same "Relates to" section as an outgoing one, × and all — which makes
 * this a click a person can make, not an API-only path.
 *
 * What the × does about the link is BP-657's to settle. What this pins is the half that belongs
 * here: the write removed nothing, so nothing may be recorded as though it had.
 */
test.describe("removing from the end that does not hold the link", () => {
  test("records nothing, because nothing was removed", async ({ page, request }) => {
    const related = await request.post(
      `/api/projects/${PROJECT_KEY}/tasks/${DECOY_TASK_ID}/links`,
      { headers: ADMIN_AUTH, data: { taskId: String(SIBLING_TASK_ID), type: "relates" } }
    );
    expect(related.status(), await related.text()).toBe(200);

    await signIn(page);
    await page.goto(taskUrl(SIBLING_TASK_NUMBER));
    const removed = page.waitForResponse(
      (r) => r.request().method() === "DELETE" && r.url().includes(`/tasks/${SIBLING_TASK_ID}/links`)
    );
    await page
      .getByRole("button", { name: `Unlink ${PROJECT_KEY}-${DECOY_TASK_NUMBER}` })
      .click();
    expect((await removed).status()).toBe(200);

    const history = await openHistory(page, SIBLING_TASK_NUMBER);

    // The control: the row the SETUP wrote against this same task is on this same screen, so the
    // absence below is this write's silence and not a panel that renders no link rows at all.
    await expect(
      exactly(history, `${ADMIN_FULL_NAME} linked this task to ${PROJECT_KEY}-${DECOY_TASK_NUMBER}`)
    ).toBeVisible();
    await expect(history.getByText(/unlinked/i)).toHaveCount(0);
  });
});
