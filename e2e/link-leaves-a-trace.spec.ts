import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
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
 * re-parenting it under a new epic silently pulls it out of the old one, by an `updateMany` that
 * names the old epic nowhere. Three tasks change, only two are in the request, and before this the
 * third had no record of it at all.
 *
 * Each task's history is read on its own screen, because a row written against the wrong task is
 * exactly the defect that a single-screen assertion cannot see.
 *
 * ## Mutation registry
 *
 * Each was applied to HEAD, run, and reverted; the tests named are the ones that actually went
 * red, not the ones that were expected to. `src/lib/task-links.ts`:
 *
 *  1. `losing = parents.filter(…)` → `losing = []`   → 4 red: both re-parent tests and both bell
 *                                                      tests. TP-4 never learns it lost a child,
 *                                                      and TP-3 loses the row about leaving it.
 *  2. read the parents AFTER the `updateMany`        → the same 4, for the same reason: by then
 *                                                      there is nothing left to read. This is
 *                                                      what makes the read order load-bearing.
 *  3. drop the target end's row in `announce`        → 2 red: "the task that moved" and the
 *                                                      removal test, both of which read a history
 *                                                      written against the OTHER end.
 *  4. reverting `TaskDetail`/`TaskActivityPanel` to  → 1 red, and only that one: "appears without
 *     the branch base, alone                           a reload". The two halves of this change
 *                                                      are independent.
 *
 * What this file does NOT pin, so the next reader does not assume it: the `!held` guard in
 * `removeTaskLink` — dropping it leaves all six green. The UI offers Unlink only on the end that
 * holds the link, so a removal from the wrong end is unreachable from a browser; it arrives over
 * the API and MCP, and `src/lib/task-links.test.ts` is where it is covered. Neither is the webhook
 * dispatch: `isAllowedWebhookUrl` refuses an http destination, and the receiver stub is http on
 * 127.0.0.1, so no delivery can land in this rig at all — `external-integrations.spec.ts` asserts
 * exactly that. What `dispatchWebhooks` is asked to send is pinned in the unit test instead.
 */

const taskUrl = (n: number) => `/projects/${PROJECT_KEY}/tasks/${n}`;

test.beforeEach(seed);

/** The task's History tab, once its rows are in — the empty line is also the loading state. */
async function openHistory(page: Page, taskNumber: number) {
  await page.goto(taskUrl(taskNumber));
  await page.getByRole("tab", { name: /^History/ }).click();
  const panel = page.locator("#task-panel-history");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("No history yet")).toBeHidden();
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
      history.getByText(`${ADMIN_USERNAME} made this task the parent of ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`)
    ).toBeVisible();
    await expect(
      history.getByText(
        `${ADMIN_USERNAME} removed ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} from this task's children`
      )
    ).toBeVisible();
  });

  test("is written on the task that moved, from its own side", async ({ page, request }) => {
    await parent(request, String(FINISHED_TASK_ID), String(SIBLING_TASK_ID));
    await reParentThroughTheUI(page);

    const history = await openHistory(page, SIBLING_TASK_NUMBER);

    await expect(
      history.getByText(
        `${ADMIN_USERNAME} made ${PROJECT_KEY}-${DECOY_TASK_NUMBER} the parent of this task`
      )
    ).toBeVisible();
    await expect(
      history.getByText(
        `${ADMIN_USERNAME} removed this task from ${PROJECT_KEY}-${FINISHED_TASK_NUMBER}'s children`
      )
    ).toBeVisible();
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
      page
        .locator("#task-panel-history")
        .getByText(`${ADMIN_USERNAME} linked this task to ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`)
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
      await expect(theirs.getByText(expected)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });

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
      await expect(theirs.getByText(expected)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await member.close();

    // Only now, with the dispatch proven to have run, is the admin's empty feed evidence
    await page.goto("/notifications");
    await expect(page.getByText(expected)).toHaveCount(0);
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
      mine.getByText(
        `${ADMIN_USERNAME} removed ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} from this task's children`
      )
    ).toBeVisible();

    const theirs = await openHistory(page, SIBLING_TASK_NUMBER);
    await expect(
      theirs.getByText(
        `${ADMIN_USERNAME} removed this task from ${PROJECT_KEY}-${DECOY_TASK_NUMBER}'s children`
      )
    ).toBeVisible();
  });
});
