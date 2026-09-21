import { test, expect, type Page } from "@playwright/test";
import {
  seed,
  seedAgents,
  seedHandoverStates,
  seedSprintPlanning,
  PROJECT_KEY,
  PLANNING_SPRINT_NAME,
  SIBLING_TASK_NUMBER,
  DECOY_TASK_NUMBER,
  FINISHED_TASK_TITLE,
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
  await seedSprintPlanning();
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
  // Exact suffix, not a substring: url().includes("/comments") would resolve just as happily on
  // a mutated/broken endpoint like ".../comments-broken", proving nothing about a real post.
  return page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().endsWith("/comments")
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

    const comment = page.locator("div.group", { hasText: "reaction target" });
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
    // switches on `hasOwn`, not against a screenshot. Anchored to a whole class token: the
    // unhighlighted state's own class list contains "hover:border-primary/50", which a bare
    // substring match on "border-primary" would wrongly count as the highlight.
    const OWN_REACTION_CLASS = /(?:^|\s)border-primary(?:\s|$)/;
    await expect(chip).toHaveClass(OWN_REACTION_CLASS);

    // A second person reacting with the same emoji groups onto the same chip rather than adding
    // a second one, and does not turn on the highlight for the first reader.
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await openTask(memberPage, SIBLING_TASK_NUMBER, "member");
    const memberComment = memberPage.locator("div.group", { hasText: "reaction target" });
    const memberChip = memberComment.getByRole("button", { name: /👍/ });
    await expect(memberChip).toContainText("1");
    await expect(memberChip).not.toHaveClass(OWN_REACTION_CLASS);
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
      .locator("div.group", { hasText: "reaction target" })
      .getByRole("button", { name: /👍/ });
    await expect(chipAfterReload).toContainText("2");
    const toggledOff = page.waitForResponse(
      (res) => res.request().method() === "PATCH" && res.url().includes("/comments/")
    );
    await chipAfterReload.click();
    await toggledOff;
    await expect(chipAfterReload).toContainText("1");
    await expect(chipAfterReload).not.toHaveClass(OWN_REACTION_CLASS);
  });

  test("the reaction picker offers a fixed emoji set", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await postComment(page, "picker target");
    const comment = page.locator("div.group", { hasText: "picker target" });
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
    // Scoped to an actual rendered comment row, not a bare getByText: the bar deliberately
    // leaves a failed post's text sitting in the (uncleared) composer for a retry, so an
    // unscoped locator can't tell "posted" from "typed and silently failed to post".
    await expect(
      page.locator("div.group", { hasText: "posted from the phone bar" })
    ).toBeVisible();
    await expect(bar.getByLabel("Add a comment")).toHaveValue("");
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

  // BP-691: the picker's exclusion set only read outgoing relations, so a task already related to
  // this one from the OTHER end — folded into the same "Relates to" section as an outgoing one —
  // was still offered, and picking it stored a second, mirrored relation nobody asked for.
  test("does not offer a task already related to this one from the other end", async ({ page }) => {
    await openTask(page, SIBLING_TASK_NUMBER, "admin");
    await addDependency(page, "relates", "Already in review");

    await page.goto(taskUrl(DECOY_TASK_NUMBER));
    await page.getByRole("button", { name: "+ Add dependency" }).click();
    await page.getByLabel("Link type").selectOption("relates");
    // The list loads from an effect keyed on the picker opening. Proven loaded BEFORE filtering to
    // absence, or an empty result would just as well mean the fetch had not resolved yet — a
    // `toHaveCount(0)` right after opening the picker passes on that alone (e2e.md).
    await expect(page.getByRole("button", { name: new RegExp(FINISHED_TASK_TITLE) })).toBeVisible();

    await page.getByLabel("Search tasks to link").fill("Free to move");
    await expect(page.getByRole("button", { name: /Free to move/ })).toHaveCount(0);

    // The control: clearing the search still finds that same, genuinely unrelated task, so the
    // empty result above is the exclusion working and not a picker that lists nobody at all.
    await page.getByLabel("Search tasks to link").fill("");
    await expect(page.getByRole("button", { name: new RegExp(FINISHED_TASK_TITLE) })).toBeVisible();
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
    const modal = page.getByRole("dialog").filter({ hasText: "New child of" });
    await modal.getByLabel("Title").fill("A real subtask");
    await modal.getByRole("button", { name: "Create Task" }).click();
    await created;

    await expect(page.getByRole("heading", { name: /New child of/ })).toHaveCount(0);
    const childrenSection = page.locator("h4", { hasText: "Children" }).locator("..");
    await expect(childrenSection.getByText("A real subtask")).toBeVisible();

    // LinkRow's clickable element is the task-key button, not the title text.
    await childrenSection.getByRole("button").first().click();
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

    // The panel stays open after the fill — a second click on the trigger would toggle it shut.
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
    // ComboboxRow's trigger carries an explicit role="combobox" (ARIA), which shadows the
    // native <button>'s implicit "button" role — getByRole("button", ...) never matches it.
    await page.getByRole("combobox", { name: "Type" }).click();
    await page.getByRole("option", { name: "bug" }).click();
    await typeSaved;
    await expect(page.getByRole("combobox", { name: "Type" })).toContainText("bug");

    const sprintSaved = page.waitForResponse(
      (res) => res.request().method() === "PUT" && res.url().includes("/tasks/")
    );
    await page.getByRole("combobox", { name: "Sprint" }).click();
    await page.getByRole("option", { name: PLANNING_SPRINT_NAME }).click();
    await sprintSaved;
    await expect(page.getByRole("combobox", { name: "Sprint" })).toContainText(PLANNING_SPRINT_NAME);
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
