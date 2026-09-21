import { test, expect, type Page } from "@playwright/test";
import {
  seed,
  seedAgents,
  seedMemberHandover,
  seedMachine,
  setBoardReadiness,
  PROJECT_KEY,
  PROJECT_AGENT_NAME,
  PROJECT_AGENT_DESCRIPTION,
  MERGING_AGENT_NAME,
  MERGING_AGENT_DESCRIPTION,
  HANDOVER_REPOSITORY,
  MEMBER_HANDOVER_TASK_NUMBER,
  MEMBER_BACKLOG_TASK_NUMBER,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-727, BP-728, BP-731. A member sets a task up exactly as the rail asks and nothing runs. The
 * rail has to say why, all at once, including what the board itself lacks and who can fix it —
 * and once nothing is missing, what it is waiting for.
 */

test.beforeEach(async () => {
  await seed();
  await seedAgents();
  await seedMemberHandover();
});

const notice = (page: Page) => page.getByRole("complementary").getByTestId("handover-notice");
const waiting = (page: Page) => page.getByRole("complementary").getByTestId("handover-waiting");
const problems = (page: Page) => notice(page).getByTestId("handover-problem");

async function openAs(page: Page, who: "admin" | "member", taskNumber = MEMBER_HANDOVER_TASK_NUMBER) {
  await signIn(page, who);
  const readiness = page.waitForResponse(
    (res) => res.url().endsWith(`/handover`) && res.request().method() === "GET"
  );
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${taskNumber}`);
  expect((await readiness).status()).toBe(200);
  await expect(page.getByText(`${PROJECT_KEY}-${taskNumber}`).first()).toBeVisible();
}

test.describe("a member's own task, as the board changes under it", () => {
  test("a board with no repository says so, names its owner, and lists the missing machine", async ({
    page,
  }) => {
    await openAs(page, "member");

    await expect(notice(page)).toHaveAttribute("data-reason", "no-repository no-machine");
    await expect(problems(page)).toHaveCount(2);
    await expect(problems(page).first()).toContainText(
      "This board names no repository, so no machine can match it — its owner, E2E Owner, can add one"
    );
    await expect(problems(page).nth(1)).toContainText("You have no machine connected");
    await expect(problems(page).nth(1).getByRole("link", { name: "How to connect one" })).toHaveAttribute(
      "href",
      "https://board-planner.com/docs/ai/execution-workers/#setting-one-up"
    );
  });

  test("agent runs switched off say so as one sentence when that is all that is missing", async ({
    page,
  }) => {
    await setBoardReadiness({ repositoryUrl: HANDOVER_REPOSITORY, workerEnabled: false });
    await seedMachine("git@github.com:e2e/handover-board.git");
    await openAs(page, "member");

    await expect(notice(page)).toHaveAttribute("data-reason", "runs-off");
    await expect(problems(page)).toHaveCount(0);
    await expect(notice(page)).toHaveText(
      "Nothing will run this yet. Agent runs are off for this board — its owner, E2E Owner, can switch them on in Settings → Workers."
    );
  });

  test("with everything in place, the rail says it is waiting for the member's machine", async ({
    page,
  }) => {
    await setBoardReadiness({ repositoryUrl: HANDOVER_REPOSITORY, workerEnabled: true });
    await seedMachine("git@github.com:e2e/handover-board.git");
    await openAs(page, "member");

    await expect(waiting(page)).toHaveText("Waiting for your machine to take it.");
    await expect(notice(page)).toHaveCount(0);
  });

  test("a ready board and no machine tells the member to connect one", async ({ page }) => {
    await setBoardReadiness({ repositoryUrl: HANDOVER_REPOSITORY, workerEnabled: true });
    await openAs(page, "member");

    await expect(notice(page)).toHaveAttribute("data-reason", "no-machine");
    await expect(notice(page)).toContainText("You have no machine connected");
    await expect(waiting(page)).toHaveCount(0);
  });

  test("a machine that stopped reporting in is named as such", async ({ page }) => {
    await setBoardReadiness({ repositoryUrl: HANDOVER_REPOSITORY, workerEnabled: true });
    await seedMachine("git@github.com:e2e/handover-board.git", { seenAgoMs: 10 * 60 * 1000 });
    await openAs(page, "member");

    await expect(notice(page)).toHaveAttribute("data-reason", "machine-stale");
  });

  // Somebody else's machine is never read: the admin has none, and still sees the member's task
  // waiting on the member's machine rather than "you have no machine connected"
  test("anyone else reading the task sees it waiting on the assignee's machine", async ({ page }) => {
    await setBoardReadiness({ repositoryUrl: HANDOVER_REPOSITORY, workerEnabled: true });
    await openAs(page, "admin");

    await expect(waiting(page)).toHaveText("Waiting for E2E Member's machine.");
    await expect(notice(page)).toHaveCount(0);
  });
});

test("every missing requirement is listed at once, the task's and the board's", async ({ page }) => {
  await openAs(page, "member", MEMBER_BACKLOG_TASK_NUMBER);

  await expect(notice(page)).toHaveAttribute(
    "data-reason",
    "not-approved-yet unassigned no-repository"
  );
  await expect(notice(page)).toContainText("Nothing will run this yet:");
  await expect(problems(page)).toHaveCount(3);
});

test.describe("the agent picker", () => {
  test("shows each agent's description and marks the one that merges", async ({ page }) => {
    await openAs(page, "member");
    await page.getByRole("combobox", { name: "Agent" }).click();

    const merging = page.getByRole("option", { name: MERGING_AGENT_NAME, exact: true });
    const pushing = page.getByRole("option", { name: PROJECT_AGENT_NAME, exact: true });
    await expect(merging).toContainText(MERGING_AGENT_DESCRIPTION);
    await expect(merging.getByTestId("option-marker")).toHaveText("Merges without a person");
    await expect(pushing).toContainText(PROJECT_AGENT_DESCRIPTION);
    await expect(pushing.getByTestId("option-marker")).toHaveCount(0);
    await expect(merging).toHaveAccessibleDescription(
      `${MERGING_AGENT_DESCRIPTION} Merges without a person`
    );
  });

  test("still chooses an agent by keyboard, and saves it", async ({ page }) => {
    await openAs(page, "member");
    const trigger = page.getByRole("combobox", { name: "Agent" });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox", { name: "Agent" })).toBeVisible();

    const names = await page
      .getByRole("option")
      .evaluateAll((els) =>
        els.map((el) => {
          const label = el.getAttribute("aria-labelledby");
          return (label ? document.getElementById(label)?.textContent : el.textContent) ?? "";
        })
      );
    const steps = names.indexOf(MERGING_AGENT_NAME) - names.indexOf(PROJECT_AGENT_NAME);
    expect(steps).not.toBe(0);
    const saved = page.waitForResponse(
      (res) => res.request().method() === "PUT" && res.url().includes("/tasks/")
    );
    for (let i = 0; i < Math.abs(steps); i++) {
      await page.keyboard.press(steps > 0 ? "ArrowDown" : "ArrowUp");
    }
    await page.keyboard.press("Enter");
    expect((await saved).ok()).toBe(true);
    await expect(trigger).toContainText(MERGING_AGENT_NAME);
  });

  test("the hand-over rules open beside the field and link to the docs", async ({ page }) => {
    await openAs(page, "member");
    const rules = page.getByRole("complementary").getByTestId("handover-rules");

    await rules.getByText("How handing work to an agent works").click();
    await expect(rules.getByRole("listitem")).toHaveCount(3);
    await expect(rules.getByRole("link", { name: "Read more about execution workers" })).toHaveAttribute(
      "href",
      "https://board-planner.com/docs/ai/execution-workers/"
    );
  });
});
