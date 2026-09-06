import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  FINISHED_TASK_KEY,
  HELD_TASK_KEY,
  HELD_TASK_TITLE,
  demoteActiveColumn,
  demoteDoneColumn,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_KEY,
  SIBLING_TASK_TITLE,
  seed,
  seedSecondEscalationColumn,
  seedWebhookDeliveryOutcomes,
} from "./seed";
import { signIn } from "./session";

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

test.beforeEach(seed);

const saveButton = (page: Page) => page.getByRole("button", { name: "Save changes" });
const columnNames = (page: Page) => page.getByLabel("Column name");
const roleOf = (page: Page, label: string) =>
  page.getByLabel(`What ${label} means to automation`);

async function labelsInOrder(page: Page, expected: number): Promise<string[]> {
  await expect(columnNames(page)).toHaveCount(expected);
  return columnNames(page).evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
}

async function openSection(page: Page, name: "Board" | "Task fields") {
  await page.goto(`${SETTINGS}?section=${name === "Board" ? "board" : "fields"}`);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

interface StoredColumn {
  id: string;
  label: string;
  role: string;
  order: number;
  triggersPmReview: boolean;
}

async function storedColumns(request: APIRequestContext): Promise<StoredColumn[]> {
  const response = await request.get(`/api/projects/${PROJECT_ID}/columns`, {
    headers: ADMIN_AUTH,
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as StoredColumn[];
}

async function save(page: Page, saved: "Columns saved" | "Categories saved") {
  const written =
    saved === "Columns saved"
      ? page.waitForResponse((res) => res.request().method() === "PUT" && res.url().endsWith("/columns"))
      : null;
  await saveButton(page).click();
  const response = await written;
  if (response && !response.ok()) expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByText(saved).last()).toBeVisible();
  await expect(saveButton(page)).toBeHidden();
}

test.describe("Board · the Done role", () => {
  async function putColumns(request: APIRequestContext, columns: unknown[]) {
    return request.put(`/api/projects/${PROJECT_ID}/columns`, {
      headers: ADMIN_AUTH,
      data: { columns },
    });
  }

  test("a board cannot be saved out of having one", async ({ request }) => {
    const before = await storedColumns(request);
    const done = before.find((c) => c.role === "done");
    expect(done, "the seeded board has no Done column, so this proves nothing").toBeDefined();

    const res = await putColumns(
      request,
      before.map((c) => (c.role === "done" ? { ...c, role: "review" } : c))
    );

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/needs a column meaning Done/);
    expect((await storedColumns(request)).find((c) => c.role === "done")?.id).toBe(done!.id);
  });

  test("and every other column change still saves", async ({ request }) => {
    const before = await storedColumns(request);

    const res = await putColumns(
      request,
      before.map((c) => (c.role === "backlog" ? { ...c, label: "Someday" } : c))
    );

    expect(res.status(), await res.text()).toBe(200);
    expect((await storedColumns(request)).map((c) => c.label)).toContain("Someday");
  });

  test("a board that already has none keeps saving unrelated changes, and can be repaired", async ({
    request,
  }) => {
    await demoteDoneColumn();
    expect((await storedColumns(request)).some((c) => c.role === "done")).toBe(false);

    await test.step("an edit that does not mention Done still saves", async () => {
      const unrelated = await putColumns(
        request,
        (await storedColumns(request)).map((c) =>
          c.role === "backlog" ? { ...c, label: "Someday" } : c
        )
      );

      expect(unrelated.status(), await unrelated.text()).toBe(200);
      expect((await storedColumns(request)).map((c) => c.label)).toContain("Someday");
    });

    await test.step("and the board can be given the role back", async () => {
      const repaired = await putColumns(
        request,
        (await storedColumns(request)).map((c) =>
          c.label === "Ready to Test" ? { ...c, role: "done" } : c
        )
      );

      expect(repaired.status(), await repaired.text()).toBe(200);
      expect((await storedColumns(request)).some((c) => c.role === "done")).toBe(true);
    });
  });

  test("pressing Save on a done-less draft says why, and keeps the work", async ({ page }) => {
    await signIn(page);
    await openSection(page, "Board");

    await roleOf(page, "Done").selectOption("review");
    await saveButton(page).click();

    await expect(page.getByText(/needs a column meaning Done/)).toBeVisible();
    await expect(saveButton(page)).toBeVisible();
    await expect(roleOf(page, "Done")).toHaveValue("review");
  });

  test("the settings screen says what such a board loses", async ({ page }) => {
    await signIn(page);
    await openSection(page, "Board");

    const warning = page.getByText(/No column means Done/i);
    await expect(warning).toHaveCount(0);

    await roleOf(page, "Done").selectOption("review");

    await expect(warning).toBeVisible();
    await expect(page.getByText(/a worker will not take a task from this board/)).toBeVisible();
  });
});

test.describe("Board · the In-progress role", () => {
  async function putColumns(request: APIRequestContext, columns: unknown[]) {
    return request.put(`/api/projects/${PROJECT_ID}/columns`, {
      headers: ADMIN_AUTH,
      data: { columns },
    });
  }

  test("a board cannot be saved out of having one", async ({ request }) => {
    const before = await storedColumns(request);
    const active = before.find((c) => c.role === "active");
    expect(active, "the seeded board has no In-progress column, so this proves nothing").toBeDefined();

    const res = await putColumns(
      request,
      before.map((c) => (c.role === "active" ? { ...c, role: "review" } : c))
    );

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/needs a column meaning In progress/);
    expect((await storedColumns(request)).find((c) => c.role === "active")?.id).toBe(active!.id);
  });

  test("and moving the role to another column still saves", async ({ request }) => {
    const before = await storedColumns(request);

    const res = await putColumns(
      request,
      before.map((c) => {
        if (c.role === "active") return { ...c, role: "review" };
        if (c.label === "In Review") return { ...c, role: "active" };
        return c;
      })
    );

    expect(res.status(), await res.text()).toBe(200);
    expect((await storedColumns(request)).find((c) => c.role === "active")?.label).toBe("In Review");
  });

  test("a board that already has none keeps saving unrelated changes, and can be repaired", async ({
    request,
  }) => {
    await demoteActiveColumn();
    expect((await storedColumns(request)).some((c) => c.role === "active")).toBe(false);

    await test.step("an edit that does not mention In progress still saves", async () => {
      const unrelated = await putColumns(
        request,
        (await storedColumns(request)).map((c) =>
          c.role === "backlog" ? { ...c, label: "Someday" } : c
        )
      );

      expect(unrelated.status(), await unrelated.text()).toBe(200);
      expect((await storedColumns(request)).map((c) => c.label)).toContain("Someday");
    });

    await test.step("and the board can be given the role back", async () => {
      const repaired = await putColumns(
        request,
        (await storedColumns(request)).map((c) =>
          c.label === "In Progress" ? { ...c, role: "active" } : c
        )
      );

      expect(repaired.status(), await repaired.text()).toBe(200);
      expect((await storedColumns(request)).some((c) => c.role === "active")).toBe(true);
    });
  });

  test("pressing Save on a draft without one says why, and keeps the work", async ({ page }) => {
    await signIn(page);
    await openSection(page, "Board");

    await roleOf(page, "In Progress").selectOption("review");
    await saveButton(page).click();

    await expect(page.getByText(/needs a column meaning In progress/)).toBeVisible();
    await expect(saveButton(page)).toBeVisible();
    await expect(roleOf(page, "In Progress")).toHaveValue("review");
  });

  test("the settings screen says what such a board loses", async ({ page }) => {
    await signIn(page);
    await openSection(page, "Board");

    const warning = page.getByText(/No column means In progress/i);
    await expect(warning).toHaveCount(0);

    await roleOf(page, "In Progress").selectOption("review");

    await expect(warning).toBeVisible();
    await expect(page.getByText(/nowhere to move a task it takes/)).toBeVisible();
  });
});

test.describe("Board · Columns", () => {
  test("a column added here is on the board the server serves, and survives a reload", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    await page.getByPlaceholder("New column name...").fill("Blocked");
    await page.getByRole("button", { name: "Add column" }).click();
    await roleOf(page, "Blocked").selectOption("blocked");
    await save(page, "Columns saved");

    const stored = await storedColumns(request);
    expect(stored.map((c) => c.label)).toContain("Blocked");
    expect(stored.find((c) => c.label === "Blocked")?.role).toBe("blocked");

    await page.reload();
    await expect(roleOf(page, "Blocked")).toHaveValue("blocked");
  });

  test("relabelling a column keeps its id, so the tasks standing in it stay put", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    await test.step("a column nobody is standing in keeps its id", async () => {
      const planned = columnNames(page).nth(0);
      await expect(planned).toHaveValue("Planned");
      await planned.fill("Icebox");
      await save(page, "Columns saved");

      const stored = await storedColumns(request);
      expect(stored.find((c) => c.label === "Icebox")?.id).toBe("planned");
    });

    await test.step("and so does one holding two, which stay in it", async () => {
      const inProgress = columnNames(page).nth(2);
      await expect(inProgress).toHaveValue("In Progress");
      await inProgress.fill("Building");
      await save(page, "Columns saved");

      const stored = await storedColumns(request);
      expect(stored.find((c) => c.label === "Building")?.id).toBe("in_progress");

      await page.reload();
      await expect(columnNames(page).nth(2)).toHaveValue("Building");
      await expect(page.getByText("2 tasks")).toBeVisible();
    });
  });

  test("the arrows move a column, and the new order is the order after a reload", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    expect((await labelsInOrder(page, 7)).slice(0, 3)).toEqual([
      "Planned",
      "To Do",
      "In Progress",
    ]);

    await page.getByRole("button", { name: "Move column up" }).nth(1).click();
    expect(
      (await labelsInOrder(page, 7)).slice(0, 3),
      "the arrow did not move the row on screen"
    ).toEqual(["To Do", "Planned", "In Progress"]);

    await save(page, "Columns saved");

    const stored = await storedColumns(request);
    expect([...stored].sort((a, b) => a.order - b.order).map((c) => c.id).slice(0, 3)).toEqual([
      "todo",
      "planned",
      "in_progress",
    ]);
    expect(stored.map((c) => c.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    await page.reload();
    expect((await labelsInOrder(page, 7)).slice(0, 3)).toEqual([
      "To Do",
      "Planned",
      "In Progress",
    ]);
  });

  test("an empty column can be removed; one holding tasks is refused, and the refusal names them", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    await test.step("Planned holds nothing, so it goes", async () => {
      await page.getByRole("button", { name: "Remove Planned" }).click();
      await save(page, "Columns saved");
      expect((await storedColumns(request)).map((c) => c.label)).not.toContain("Planned");
    });

    await test.step("In Progress holds two, so the server says no and says which", async () => {
      await page.getByRole("button", { name: "Remove In Progress" }).click();
      await saveButton(page).click();

      await expect(
        page.getByText(
          new RegExp(`still has tasks: ${HELD_TASK_KEY}, ${SIBLING_TASK_KEY}(?![0-9])`)
        )
      ).toBeVisible();
      await expect(saveButton(page)).toBeVisible();

      expect((await storedColumns(request)).map((c) => c.label)).toContain("In Progress");
      await page.reload();
      await expect(columnNames(page)).toHaveCount(6);
      await expect(roleOf(page, "In Progress")).toBeVisible();
    });
  });

  test("a draft nobody saved reaches the server not at all", async ({ page, request }) => {
    await signIn(page);
    await openSection(page, "Board");

    await columnNames(page).nth(2).fill("Never saved");
    await expect(saveButton(page)).toBeVisible();

    await page.reload();
    await expect(columnNames(page).nth(2)).toHaveValue("In Progress");
    expect((await storedColumns(request)).map((c) => c.label)).not.toContain("Never saved");
  });

  test("a board with nothing in the approved role says so, and an ordinary board does not", async ({
    page,
  }) => {
    const WARNING = /Workers and Claude Code have nowhere to take work from/;

    await signIn(page);
    await openSection(page, "Board");

    await expect(page.getByText(WARNING)).toBeHidden();

    await roleOf(page, "To Do").selectOption("backlog");
    await expect(page.getByText(WARNING)).toBeVisible();
  });
});

test.describe("Board · a new column that wants an id somebody is standing in", () => {
  test("cannot take it, and the tasks stay under the column they were in", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    const before = await storedColumns(request);
    expect(before.find((c) => c.label === "In Progress")?.id).toBe("in_progress");

    await page.getByPlaceholder("New column name...").fill("In-Progress");
    await page.getByRole("button", { name: "Add column" }).click();

    for (let from = 7; from > 2; from--) {
      await page.getByRole("button", { name: "Move column up" }).nth(from).click();
    }
    expect(
      (await labelsInOrder(page, 8)).slice(1, 4),
      "the newcomer did not end up above In Progress on screen"
    ).toEqual(["To Do", "In-Progress", "In Progress"]);

    await save(page, "Columns saved");

    const stored = await storedColumns(request);
    expect(stored.find((c) => c.label === "In Progress")?.id).toBe("in_progress");
    expect(stored.find((c) => c.label === "In-Progress")?.id).toBe("in_progress_2");
    expect(stored.find((c) => c.id === "in_progress")?.role).toBe("active");

    await page.goto(`/projects/${PROJECT_KEY}`);
    const column = page.getByTestId("column-in_progress");
    await expect(column.getByRole("heading", { name: "In Progress", exact: true })).toBeVisible();
    await expect(column.getByText(HELD_TASK_TITLE)).toBeVisible();
    await expect(column.getByText(SIBLING_TASK_TITLE)).toBeVisible();
  });

  test("and taking the id of one being removed does not excuse it from the task check", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    await page.getByRole("button", { name: "Remove To Do" }).click();
    await page.getByPlaceholder("New column name...").fill("Todo");
    await page.getByRole("button", { name: "Add column" }).click();
    await saveButton(page).click();

    await expect(
      page.getByText(new RegExp(`still has tasks: ${FINISHED_TASK_KEY}(?![0-9])`))
    ).toBeVisible();
    const stored = await storedColumns(request);
    expect(stored.find((c) => c.label === "To Do")?.id).toBe("todo");
    expect(stored.map((c) => c.label)).not.toContain("Todo");
  });

  test("nor by naming one column twice, so the suffix lands on a third", async ({ request }) => {
    const putColumns = (columns: unknown[]) =>
      request.put(`/api/projects/${PROJECT_ID}/columns`, {
        headers: ADMIN_AUTH,
        data: { columns },
      });

    const twin = await putColumns([
      ...(await storedColumns(request)),
      { label: "In-Progress", role: "backlog" },
    ]);
    expect(twin.status(), await twin.text()).toBe(200);
    const withTwin = await storedColumns(request);
    expect(withTwin.find((c) => c.label === "In-Progress")?.id).toBe("in_progress_2");

    const res = await putColumns(
      withTwin.map((c) => (c.id === "planned" ? { ...c, id: "in_progress" } : c))
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/cannot claim the same id/);

    const after = await storedColumns(request);
    expect(after.map((c) => `${c.id}:${c.label}`)).toEqual(
      withTwin.map((c) => `${c.id}:${c.label}`)
    );
  });
});

test.describe("Board · Hand-off to the PM agent", () => {
  test("the escalation column is the one chosen here, after a reload", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    const escalation = page.getByLabel("Escalation column");
    await expect(escalation).toHaveValue("needs_human_review");

    await escalation.selectOption("ready_to_test");
    await expect(escalation, "the choice did not take on screen").toHaveValue("ready_to_test");
    await save(page, "Columns saved");

    const stored = await storedColumns(request);
    expect(stored.filter((c) => c.triggersPmReview).map((c) => c.id)).toEqual(["ready_to_test"]);

    await page.reload();
    await expect(page.getByLabel("Escalation column")).toHaveValue("ready_to_test");
  });

  test("a board that hands off from two columns warns, and saving leaves one", async ({
    page,
    request,
  }) => {
    await seedSecondEscalationColumn();
    await signIn(page);
    await openSection(page, "Board");

    const warning = page.getByText(/hands off from more than one column/);
    await expect(warning).toContainText("Saving keeps In Review and stops Needs Human Review");
    await expect(warning.locator("strong")).toHaveText("In Review");

    await page.getByLabel("Escalation column").selectOption("in_review");
    await save(page, "Columns saved");

    const stored = await storedColumns(request);
    expect(stored.filter((c) => c.triggersPmReview).map((c) => c.id)).toEqual(["in_review"]);

    await page.reload();
    await expect(page.getByLabel("Escalation column")).toHaveValue("in_review");
    await expect(page.getByText(/hands off from more than one column/)).toBeHidden();
  });
});

test.describe("Task fields · Categories", () => {
  const categoryNames = (page: Page) => page.getByLabel("Category name");

  test("a category added here is one the server holds, after a reload", async ({ page }) => {
    await signIn(page);
    await openSection(page, "Task fields");

    await page.getByRole("button", { name: "+ Add category" }).click();
    await categoryNames(page).last().fill("spike");
    await save(page, "Categories saved");

    await page.reload();
    await expect(categoryNames(page)).toHaveCount(5);
    expect(
      await categoryNames(page).evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))
    ).toEqual(["bug", "doc", "user-story", "idea", "spike"]);
  });

  test("renaming a category carries the tasks that were using it", async ({ page, request }) => {
    await signIn(page);
    await openSection(page, "Task fields");

    const userStory = categoryNames(page).nth(2);
    await expect(userStory).toHaveValue("user-story");
    await userStory.fill("feature");
    await save(page, "Categories saved");

    const task = await request.get(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_KEY}`, {
      headers: ADMIN_AUTH,
    });
    expect(task.status(), await task.text()).toBe(200);
    expect((await task.json()).category).toBe("feature");

    await page.reload();
    await expect(categoryNames(page)).toHaveCount(4);
    const names = await categoryNames(page).evaluateAll((els) =>
      els.map((el) => (el as HTMLInputElement).value)
    );
    expect(names).toContain("feature");
    expect(names).not.toContain("user-story");
  });

  test("a category no task uses can go; one in use is refused, and the refusal names the tasks", async ({
    page,
  }) => {
    await signIn(page);
    await openSection(page, "Task fields");

    await test.step("nothing is filed under doc, so it goes", async () => {
      await page.getByRole("button", { name: "Remove doc" }).click();
      await save(page, "Categories saved");
      await page.reload();
      await expect(categoryNames(page)).toHaveCount(3);
      await expect(page.getByRole("button", { name: "Remove doc" })).toBeHidden();
    });

    await test.step("every seeded task is a user-story, so that one stays", async () => {
      await page.getByRole("button", { name: "Remove user-story" }).click();
      await saveButton(page).click();

      await expect(
        page.getByText(new RegExp(`user-story.*still used by.*${HELD_TASK_KEY}`))
      ).toBeVisible();
      await expect(saveButton(page)).toBeVisible();

      await page.reload();
      await expect(page.getByRole("button", { name: "Remove user-story" })).toBeVisible();
    });
  });
});

test.describe("Integrations · the save bar", () => {
  async function openWebhooks(page: Page) {
    await page.goto(SETTINGS);
    await page.getByRole("button", { name: "Integrations", exact: true }).first().click();
    const picker = page.getByRole("button", { name: /Add integration/ });
    const anyWebhookShape = page.getByRole("button", { name: /Webhooks/ });
    await expect(picker.or(anyWebhookShape).first()).toBeVisible();
    if (await picker.isVisible()) await picker.click();

    const input = page.getByPlaceholder("https://example.com/webhook");
    await expect(input.or(anyWebhookShape).first()).toBeVisible();
    if (!(await input.isVisible())) {
      await page.getByRole("button", { name: /Webhooks/ }).first().click();
    }
    return input;
  }

  async function addWebhook(page: Page, url: string) {
    const input = await openWebhooks(page);
    await input.fill(url);
    await page.getByRole("button", { name: "Add", exact: true }).click();
  }

  test("a webhook save that succeeds leaves no unsaved work behind", async ({ page }) => {
    await signIn(page);
    await addWebhook(page, "https://example.com/e2e-hook");

    await saveButton(page).click();

    await expect(page.getByText("1 endpoint")).toBeVisible();

    await expect(saveButton(page)).toBeHidden();
  });

  test("pressing Save again after a successful save sends nothing", async ({ page }) => {
    await signIn(page);
    const input = await openWebhooks(page);
    await input.fill("https://example.com/e2e-hook");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await saveButton(page).click();
    await expect(page.getByText("1 endpoint")).toBeVisible();
    await expect(saveButton(page)).toBeHidden();

    const sent: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/webhooks") && r.method() !== "GET") sent.push(`${r.method()} ${r.url()}`);
    });

    await input.fill("https://example.com/second");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(saveButton(page)).toBeVisible();
    await saveButton(page).click();
    await expect(saveButton(page)).toBeHidden();

    expect(sent, "the first webhook was sent again alongside the second").toHaveLength(1);
  });

  test("a save that fails keeps the edit on screen to retry", async ({ page }) => {
    await signIn(page);
    await page.route("**/api/projects/*/webhooks", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, body: JSON.stringify({ error: "nope" }) })
        : route.continue()
    );

    await addWebhook(page, "https://example.com/e2e-hook");
    await saveButton(page).click();

    await expect(page.getByText("nope")).toBeVisible();
    await expect(saveButton(page), "a failed save must keep the work on screen").toBeVisible();
  });

  test("the webhooks panel shows what the last delivery attempt did", async ({ page }) => {
    await seedWebhookDeliveryOutcomes();
    await signIn(page);
    await openWebhooks(page);

    await expect(page.getByText(/Last delivered/)).toBeVisible();
    await expect(page.getByText(/Last delivery failed/)).toBeVisible();
    await expect(page.getByText("connect ECONNREFUSED")).toBeVisible();

    await expect(page.getByText(/Last deliver/)).toHaveCount(2);
  });
});
