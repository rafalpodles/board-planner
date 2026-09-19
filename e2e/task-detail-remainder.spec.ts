import { test, expect, type Page } from "@playwright/test";
import {
  seed,
  seedAgents,
  seedHandoverStates,
  PROJECT_KEY,
  PROJECT_AGENT_NAME,
  SIBLING_TASK_NUMBER,
  DECOY_TASK_NUMBER,
  NOT_APPROVED_TASK_NUMBER,
  UNASSIGNED_HANDOVER_TASK_NUMBER,
  UNRECORDED_ASSIGNER_TASK_NUMBER,
  PM_FOR_SOMEONE_ELSE_TASK_NUMBER,
  ASSIGNED_BY_SOMEONE_ELSE_TASK_NUMBER,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-474: the task detail screen's remaining gaps once BP-385's core coverage landed — comment
 * reactions, the keyboard/mobile ways to post a comment, the three dependency types beyond
 * `blocked_by` and their reverse sections, subtasks, the handover notice, several rail rows, and
 * the Comments/History tablist's arrow-key contract.
 */

test.beforeEach(async () => {
  await seed();
  await seedAgents();
  await seedHandoverStates();
});

const taskUrl = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;

async function openTask(page: Page, taskNumber: number, who: "admin" | "member" = "admin") {
  await signIn(page, who);
  await page.goto(taskUrl(taskNumber));
  await expect(page.getByText(`${PROJECT_KEY}-${taskNumber}`).first()).toBeVisible();
}

function composer(page: Page) {
  return page.getByPlaceholder("Write a comment, @mention someone…");
}

function commentWrite(page: Page) {
  return page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes("/comments")
  );
}

async function postComment(page: Page, text: string) {
  const written = commentWrite(page);
  await composer(page).fill(text);
  await composer(page).press("Meta+Enter");
  await written;
  await expect(page.getByText(text)).toBeVisible();
}

test.describe("comment reactions", () => {
  test("adding, grouping and toggling off a reaction, with the own-reaction highlight", async ({
    page,
    browser,
  }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await postComment(page, "reaction target");

    const comment = page.locator("div", { has: page.getByText("reaction target") }).last();
    await comment.getByLabel("Add a reaction").click();
    const patched = page.waitForResponse(
      (res) => res.request().method() === "PATCH" && res.url().includes("/comments/")
    );
    await page.getByLabel("React with 👍").click();
    await patched;

    const chip = comment.getByRole("button", { name: /👍/ });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("1");
    // The reader's own reaction is highlighted — asserted against the class the component
    // switches on `hasOwn`, not against a screenshot.
    await expect(chip).toHaveClass(/border-primary/);

    // A second person reacting with the same emoji groups onto the same chip rather than adding
    // a second one, and does not turn on the highlight for the first reader.
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await openTask(memberPage, SIBLING_TASK_NUMBER, "member");
    const memberComment = memberPage
      .locator("div", { has: memberPage.getByText("reaction target") })
      .last();
    const memberChip = memberComment.getByRole("button", { name: /👍/ });
    await expect(memberChip).toContainText("1");
    await expect(memberChip).not.toHaveClass(/border-primary/);
    const memberPatched = memberPage.waitForResponse(
      (res) => res.request().method() === "PATCH" && res.url().includes("/comments/")
    );
    await memberChip.click();
    await memberPatched;
    await expect(memberChip).toContainText("2");
    await memberContext.close();

    // Back on the first reader: the chip now reflects both, and toggling off removes only theirs.
    await page.reload();
    const chipAfterReload = page
      .locator("div", { has: page.getByText("reaction target") })
      .last()
      .getByRole("button", { name: /👍/ });
    await expect(chipAfterReload).toContainText("2");
    const toggledOff = page.waitForResponse(
      (res) => res.request().method() === "PATCH" && res.url().includes("/comments/")
    );
    await chipAfterReload.click();
    await toggledOff;
    await expect(chipAfterReload).toContainText("1");
    await expect(chipAfterReload).not.toHaveClass(/border-primary/);
  });

  test("the reaction picker offers a fixed emoji set", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await postComment(page, "picker target");
    const comment = page.locator("div", { has: page.getByText("picker target") }).last();
    await comment.getByLabel("Add a reaction").click();
    for (const emoji of ["👍", "👎", "❤️", "👀", "🎉", "😄"]) {
      await expect(page.getByLabel(`React with ${emoji}`)).toBeVisible();
    }
  });
});

test.describe("posting a comment", () => {
  test("⌘↵ posts from the wide composer", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await postComment(page, "sent with the keyboard, not the button");
  });

  test("the mobile comment bar posts", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    const bar = page.locator("[data-pinned-phone-bar]");
    await expect(bar).toBeVisible();
    const written = commentWrite(page);
    await bar.getByLabel("Add a comment").fill("posted from the phone bar");
    await bar.getByLabel("Post comment").click();
    await written;
    await expect(page.getByText("posted from the phone bar")).toBeVisible();
  });
});

test.describe("dependency types beyond blocked_by", () => {
  async function addDependency(page: Page, type: string, targetTitle: string) {
    await page.getByRole("button", { name: "+ Add dependency" }).click();
    await page.getByLabel("Link type").selectOption(type);
    await page.getByLabel("Search tasks to link").fill(targetTitle);
    const linked = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.url().includes("/links")
    );
    await page.getByRole("button", { name: new RegExp(targetTitle) }).click();
    await linked;
  }

  test("relates is symmetric and appears the same way on both tasks", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await addDependency(page, "relates", "Already in review");

    const relatesSection = page.locator("h4", { hasText: "Relates to" }).locator("..");
    await expect(relatesSection.getByText("Already in review")).toBeVisible();

    await page.goto(taskUrl(DECOY_TASK_NUMBER));
    const reverseSection = page.locator("h4", { hasText: "Relates to" }).locator("..");
    await expect(reverseSection.getByText("Free to move")).toBeVisible();
  });

  test("duplicates shows forward as Duplicates and reverse as Duplicated by", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await addDependency(page, "duplicates", "Already in review");

    await expect(
      page.locator("h4", { hasText: "Duplicates" }).locator("..").getByText("Already in review")
    ).toBeVisible();

    await page.goto(taskUrl(DECOY_TASK_NUMBER));
    await expect(
      page.locator("h4", { hasText: "Duplicated by" }).locator("..").getByText("Free to move")
    ).toBeVisible();
  });

  test("parent_of shows forward as Children and reverse as Parent, and removal only affects the removable side", async ({
    page,
  }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await addDependency(page, "parent_of", "Already in review");

    const childrenSection = page.locator("h4", { hasText: "Children" }).locator("..");
    await expect(childrenSection.getByText("Already in review")).toBeVisible();
    // The forward side is removable; the reverse ("Parent") is not — asserted as a control next
    // to the removal, not assumed.
    await expect(childrenSection.getByLabel(/Unlink/)).toBeVisible();

    await page.goto(taskUrl(DECOY_TASK_NUMBER));
    const parentSection = page.locator("h4", { hasText: "Parent" }).locator("..");
    await expect(parentSection.getByText("Free to move")).toBeVisible();
    await expect(parentSection.getByLabel(/Unlink/)).toHaveCount(0);
  });

  test("a dependency can be removed from the removable side", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await addDependency(page, "duplicates", "Already in review");
    const section = page.locator("h4", { hasText: "Duplicates" }).locator("..");
    await expect(section.getByText("Already in review")).toBeVisible();

    const removed = page.waitForResponse(
      (res) => res.request().method() === "DELETE" && res.url().includes("/links")
    );
    await section.getByLabel(/Unlink/).click();
    await removed;
    await expect(page.getByText("Duplicates")).toHaveCount(0);
  });
});

test.describe("subtasks", () => {
  test("a subtask is created and both rows appear in Linked work", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await page.getByRole("button", { name: "+ Add subtask" }).click();
    await expect(page.getByRole("heading", { name: /New child of/ })).toBeVisible();

    const created = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.url().endsWith("/tasks")
    );
    await page.getByLabel("Task title").fill("A real subtask");
    await page.getByRole("button", { name: "Create Task" }).click();
    await created;

    await expect(page.getByRole("heading", { name: /New child of/ })).toHaveCount(0);
    await expect(
      page.locator("h4", { hasText: "Children" }).locator("..").getByText("A real subtask")
    ).toBeVisible();

    const childRow = page.locator("a", { hasText: "A real subtask" }).first();
    await childRow.click();
    await expect(
      page.locator("h4", { hasText: "Parent" }).locator("..").getByText("Free to move")
    ).toBeVisible();
  });
});

test.describe("the handover notice", () => {
  const notice = (page: Page) => page.getByTestId("handover-notice");

  test("no agent: no notice at all", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await expect(notice(page)).toHaveCount(0);
  });

  test("not approved yet", async ({ page }) => {
    await openTask(page, NOT_APPROVED_TASK_NUMBER, "admin");
    await expect(notice(page)).toHaveAttribute("data-reason", "not-approved-yet");
    await expect(notice(page)).toContainText("move it there when it is ready");
  });

  test("unassigned", async ({ page }) => {
    await openTask(page, UNASSIGNED_HANDOVER_TASK_NUMBER, "admin");
    await expect(notice(page)).toHaveAttribute("data-reason", "unassigned");
    await expect(notice(page)).toContainText("assign it to yourself");
  });

  test("assigner unrecorded", async ({ page }) => {
    await openTask(page, UNRECORDED_ASSIGNER_TASK_NUMBER, "admin");
    await expect(notice(page)).toHaveAttribute("data-reason", "assigner-unrecorded");
    await expect(notice(page)).toContainText("assigning it to themselves again");
  });

  test("PM assigned it for someone else", async ({ page }) => {
    await openTask(page, PM_FOR_SOMEONE_ELSE_TASK_NUMBER, "admin");
    await expect(notice(page)).toHaveAttribute("data-reason", "pm-assigned-for-someone-else");
    await expect(notice(page)).toContainText("the person who asked for it");
  });

  test("assigned by someone else", async ({ page }) => {
    await openTask(page, ASSIGNED_BY_SOMEONE_ELSE_TASK_NUMBER, "admin");
    await expect(notice(page)).toHaveAttribute("data-reason", "assigned-by-someone-else");
    await expect(notice(page)).toContainText("E2E Member assigned it");
  });
});

test.describe("property rail rows", () => {
  test("due date is set and cleared", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await page.getByRole("button", { name: "Add date" }).click();
    const saved = page.waitForResponse(
      (res) => res.request().method() === "PUT" && res.url().includes("/tasks/")
    );
    await page.locator('input[type="date"]').fill("2027-01-15");
    await saved;
    await expect(page.getByRole("button", { name: "Jan 15, 2027" })).toBeVisible();

    await page.getByRole("button", { name: "Jan 15, 2027" }).click();
    const cleared = page.waitForResponse(
      (res) => res.request().method() === "PUT" && res.url().includes("/tasks/")
    );
    await page.getByRole("button", { name: "Clear" }).click();
    await cleared;
    await expect(page.getByRole("button", { name: "Add date" })).toBeVisible();
  });

  test("type and sprint change from the rail", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");

    const typeSaved = page.waitForResponse(
      (res) => res.request().method() === "PUT" && res.url().includes("/tasks/")
    );
    await page.getByRole("button", { name: /^user-story$|^bug$|^doc$|^idea$/ }).first().click();
    await page.getByRole("option", { name: "bug" }).click();
    await typeSaved;
    await expect(page.getByText("bug", { exact: true })).toBeVisible();
  });

  test("Reported by names the creator", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await expect(page.getByText("Reported by E2E Admin")).toBeVisible();
  });
});

test.describe("the Comments/History tablist", () => {
  test("arrow keys move focus and selection between tabs", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    const commentsTab = page.getByRole("tab", { name: /Comments/ });
    const historyTab = page.getByRole("tab", { name: /History/ });

    await expect(commentsTab).toHaveAttribute("aria-selected", "true");
    await commentsTab.focus();

    await page.keyboard.press("ArrowRight");
    await expect(historyTab).toHaveAttribute("aria-selected", "true");
    await expect(historyTab).toBeFocused();
    await expect(commentsTab).toHaveAttribute("aria-selected", "false");

    await page.keyboard.press("ArrowLeft");
    await expect(commentsTab).toHaveAttribute("aria-selected", "true");
    await expect(commentsTab).toBeFocused();

    await page.keyboard.press("End");
    await expect(historyTab).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Home");
    await expect(commentsTab).toHaveAttribute("aria-selected", "true");
  });
});
