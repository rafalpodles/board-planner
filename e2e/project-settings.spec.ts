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

/**
 * The project's own settings: the board's columns, the categories tasks are described with, and
 * the save bar all three share.
 *
 * What every test here is really asking is whether the editor mirrors what the server will
 * accept. So the control is the state the server holds — read back over the API, or after a
 * reload, or both. A draft that looks right on screen and never reached the server is the failure
 * this spec exists to catch, and it is invisible to any assertion made before the page is thrown
 * away. Three kinds of test here do not reload, deliberately: the warnings, which are about a
 * live draft; the steps settled by an API read instead, which is stronger; and the save-bar tests,
 * whose subject is in-memory state a reload would destroy.
 *
 * Categories are here despite living on a different screen (`TaskFieldsSection`, beside custom
 * fields): to a person they are board structure, and they answer to the same save bar.
 *
 * The `done`-role boundary — what happens to unfinished work when a sprint closes on a board with
 * no done column — belongs to BP-389 and is deliberately not here.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

test.beforeEach(seed);

const saveButton = (page: Page) => page.getByRole("button", { name: "Save changes" });
const columnNames = (page: Page) => page.getByLabel("Column name");
const roleOf = (page: Page, label: string) =>
  page.getByLabel(`What ${label} means to automation`);

/**
 * The labels in the order the editor shows them.
 *
 * `evaluateAll` does not wait for anything, so after a reload it reads an empty list and the
 * assertion that follows compares nothing to something. The count is what the wait is for.
 */
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

/** The columns as the server holds them, which is the only reader that settles a save. */
async function storedColumns(request: APIRequestContext): Promise<StoredColumn[]> {
  const response = await request.get(`/api/projects/${PROJECT_ID}/columns`, {
    headers: ADMIN_AUTH,
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as StoredColumn[];
}

/**
 * Saving, and waiting for the server rather than for the strip to slide away.
 *
 * The button's own label becomes "Saving..." while the request is in flight, so
 * `getByRole("button", { name: "Save changes" })` goes hidden the instant the click lands and
 * long before anything has been written. Four tests here read the stored board straight after
 * saving and got the board as it was — passing the click and failing the read.
 *
 * The success toast is emitted after the whole save chain has resolved, which for categories is
 * several requests, so it is the one signal that means "the server is done".
 */
async function save(page: Page, saved: "Columns saved" | "Categories saved") {
  await saveButton(page).click();
  await expect(page.getByText(saved)).toBeVisible();
  await expect(saveButton(page)).toBeHidden();
}

test.describe("Board · the Done role", () => {
  /** Sends a column set straight to the endpoint, which is where the rule lives */
  async function putColumns(request: APIRequestContext, columns: unknown[]) {
    return request.put(`/api/projects/${PROJECT_ID}/columns`, {
      headers: ADMIN_AUTH,
      data: { columns },
    });
  }

  test("a board cannot be saved out of having one", async ({ request }) => {
    const before = await storedColumns(request);
    const done = before.find((c) => c.role === "done");
    // The premise: this board HAS a Done column, so the refusal below is about removing it
    expect(done, "the seeded board has no Done column, so this proves nothing").toBeDefined();

    const res = await putColumns(
      request,
      before.map((c) => (c.role === "done" ? { ...c, role: "review" } : c))
    );

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/needs a column meaning Done/);
    // Refused, not partially applied
    expect((await storedColumns(request)).find((c) => c.role === "done")?.id).toBe(done!.id);
  });

  // The control, in the same run: the endpoint is not simply refusing everything
  test("and every other column change still saves", async ({ request }) => {
    const before = await storedColumns(request);

    const res = await putColumns(
      request,
      before.map((c) => (c.role === "backlog" ? { ...c, label: "Someday" } : c))
    );

    expect(res.status(), await res.text()).toBe(200);
    expect((await storedColumns(request)).map((c) => c.label)).toContain("Someday");
  });

  /**
   * The half that decides the shape of the whole fix, and the assertion that separates it from the
   * rule it rejects.
   *
   * A **state** rule (`if (!willHaveDone) refuse`) passes every other test in this block: each of
   * them either starts from a board that has Done or supplies one in the request. What only the
   * transition rule allows is a done-less board saving a change that has nothing to do with Done —
   * which is every edit somebody would make while repairing it, and the reason refusing the state
   * would lock a board out of this very screen.
   *
   * `demoteDoneColumn` rather than a hand-rolled write: it is the fixture the sprint specs already
   * use, and it fails loudly if it matches nothing.
   */
  test("a board that already has none keeps saving unrelated changes, and can be repaired", async ({
    request,
  }) => {
    await demoteDoneColumn();
    // The premise, read back rather than assumed
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

  /**
   * The path a person actually walks. Everything above drives the endpoint; this one presses Save
   * in the editor, which is where the refusal is met and where the draft has to survive it.
   */
  test("pressing Save on a done-less draft says why, and keeps the work", async ({ page }) => {
    await signIn(page);
    await openSection(page, "Board");

    await roleOf(page, "Done").selectOption("review");
    await saveButton(page).click();

    await expect(page.getByText(/needs a column meaning Done/)).toBeVisible();
    // The draft is not thrown away: the Save button is still offered, with the change still in it
    await expect(saveButton(page)).toBeVisible();
    await expect(roleOf(page, "Done")).toHaveValue("review");
  });

  test("the settings screen says what such a board loses", async ({ page }) => {
    await signIn(page);
    await openSection(page, "Board");

    const warning = page.getByText(/No column means Done/i);
    // The control first: an ordinary board shows no warning, so its appearance below is the change
    await expect(warning).toHaveCount(0);

    await roleOf(page, "Done").selectOption("review");

    await expect(warning).toBeVisible();
    await expect(page.getByText(/a worker will not take a task from this board/)).toBeVisible();
  });
});

/**
 * BP-512. The `active` role is the twin of `done`: the claim moves a task into the column that
 * carries it, and a board with none answered every claim the way an empty queue does. Same rule,
 * same shape — a transition refused, a state left repairable — and the same four proofs as above,
 * because a rule copied from Done can be copied wrong in exactly the ways those catch.
 */
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

  // The control: moving the role to ANOTHER column is the legitimate edit, and it has to save
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

  // The transition-not-state half, which is what keeps this from locking a board out of the screen
  // where it is repaired — see the Done block above for why a state rule passes every other test
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

    // The empty column first, and deliberately: a column holding tasks cannot lose its id
    // quietly, because the server reads the old id as a removal and refuses. On an empty one
    // nothing refuses anything, so the id below is the only thing standing between a rename and
    // a new column.
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

    // The second row's own up arrow: the label is shared by every row, so position is what names it
    await page.getByRole("button", { name: "Move column up" }).nth(1).click();
    expect(
      (await labelsInOrder(page, 7)).slice(0, 3),
      "the arrow did not move the row on screen"
    ).toEqual(["To Do", "Planned", "In Progress"]);

    await save(page, "Columns saved");

    // `order` is the field, and neither reader here would notice it being destroyed: GET returns
    // the array unsorted, so its sequence is incidental, and `effectiveColumns` sorts stably, so a
    // column of zeroes keeps insertion order and the reload agrees with itself
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

      // One regex over the whole sentence: two separate matches never say the keys are in the
      // same refusal, and a bare /TP-3/ is also satisfied by TP-30
      await expect(
        page.getByText(
          new RegExp(`still has tasks: ${HELD_TASK_KEY}, ${SIBLING_TASK_KEY}(?![0-9])`)
        )
      ).toBeVisible();
      // A refused save keeps the work on screen rather than pretending it landed
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

    // The control: the seeded board has To Do in the approved role, so the warning is absent
    await expect(page.getByText(WARNING)).toBeHidden();

    await roleOf(page, "To Do").selectOption("backlog");
    await expect(page.getByText(WARNING)).toBeVisible();
  });
});

/**
 * BP-536. A column's id is handed out before the de-duplication that protects it, so a *new*
 * column processed earlier can take an id a *staying* column is about to ask for. The staying
 * one — the real owner, with tasks standing in it — is pushed to `<id>_2`.
 *
 * The guard twenty lines below never fires, and that is the sharp part: `removed` is
 * `current.filter((c) => !usedIds.has(c.id))`, and the stolen id **is** in `usedIds` — claimed by
 * the thief. So "still has tasks" is not merely bypassed for a column being dropped; it is
 * bypassed for a column that is *staying* and losing its identity, which is the case it exists to
 * catch. The role rule passes too, because the displaced column keeps carrying the role.
 *
 * The label here slugifies onto `in_progress` while reading differently on screen, so the two
 * columns can be told apart in an assertion. A person doing this by hand would more likely type
 * the same label twice; the mechanism is identical and the test would then be unable to say which
 * column it had found.
 */
test.describe("Board · a new column that wants an id somebody is standing in", () => {
  test("cannot take it, and the tasks stay under the column they were in", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openSection(page, "Board");

    // The premise, from the server: In Progress owns `in_progress` and two tasks stand in it
    const before = await storedColumns(request);
    expect(before.find((c) => c.label === "In Progress")?.id).toBe("in_progress");

    await page.getByPlaceholder("New column name...").fill("In-Progress");
    await page.getByRole("button", { name: "Add column" }).click();

    // Up from the end to index 2, so the newcomer is processed before the column it collides
    // with — the whole bug is an ordering one, and appended-last it never triggers
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
    // The role went with the id, not with the position
    expect(stored.find((c) => c.id === "in_progress")?.role).toBe("active");

    // Where a person meets it: the two cards keep `status: "in_progress"` whatever happens here,
    // so the question is only which column that id now names — and the heading over them says it
    await page.goto(`/projects/${PROJECT_KEY}`);
    const column = page.getByTestId("column-in_progress");
    await expect(column.getByRole("heading", { name: "In Progress", exact: true })).toBeVisible();
    await expect(column.getByText(HELD_TASK_TITLE)).toBeVisible();
    await expect(column.getByText(SIBLING_TASK_TITLE)).toBeVisible();
  });

  /**
   * The other door. Here the removal is deliberate and the guard has to refuse it — but the
   * newcomer's slug filled the vacancy, so the departing column no longer looked absent and the
   * check skipped it. That is why "removed" cannot be read off the final ids.
   *
   * To Do rather than In Progress, deliberately: `addColumn` hard-codes the backlog role, so
   * removing the board's only In-progress column is refused by the role rule instead, and the
   * spec would go red on unfixed source for a reason that is not this bug. `approved` is not
   * load-bearing, so unfixed source really does accept this one — and TP-4, approved for work,
   * lands in a backlog column with nobody told.
   */
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
    // Refused whole, so the board still has the column and its task is where it was
    const stored = await storedColumns(request);
    expect(stored.find((c) => c.label === "To Do")?.id).toBe("todo");
    expect(stored.map((c) => c.label)).not.toContain("Todo");
  });

  /**
   * The editor cannot send this — its rows come from the stored board, one draft each — so this
   * one is driven at the endpoint, which any API token can reach. Naming one existing column
   * twice is meaningless, and the interesting part is where the second copy goes: it keeps its
   * own id at the first candidate, and the suffix then walks it onto the id of a *different*
   * live column. Guarding on "is this a newcomer" instead of "is this still its own id" let that
   * through, which is how the first version of this fix still stole an id.
   */
  test("nor by naming one column twice, so the suffix lands on a third", async ({ request }) => {
    const putColumns = (columns: unknown[]) =>
      request.put(`/api/projects/${PROJECT_ID}/columns`, {
        headers: ADMIN_AUTH,
        data: { columns },
      });

    // The collision target, built by the product's own rule: a second In Progress becomes `in_progress_2`
    const twin = await putColumns([
      ...(await storedColumns(request)),
      { label: "In-Progress", role: "backlog" },
    ]);
    expect(twin.status(), await twin.text()).toBe(200);
    const withTwin = await storedColumns(request);
    expect(withTwin.find((c) => c.label === "In-Progress")?.id).toBe("in_progress_2");

    // Two entries now claim `in_progress`. Served rather than refused, the loser walks off its
    // own id and onto `in_progress_2` — which belongs to the twin, and carries whatever stands
    // in it. There is no reading of a contradictory payload worth guessing at.
    const res = await putColumns(
      withTwin.map((c) => (c.id === "planned" ? { ...c, id: "in_progress" } : c))
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/cannot claim the same id/);

    // Refused whole: every column still holds exactly what it held
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
    // The whole sentence, not the two names in it: which column survives and which is stopped is
    // the entire content of this warning, and both names appear either way round
    await expect(warning).toContainText("Saving keeps In Review and stops Needs Human Review");
    await expect(warning.locator("strong")).toHaveText("In Review");

    // The draft loads carrying BOTH flags, so nothing is dirty until the choice is made; picking
    // one is what runs `withEscalationColumn` and clears the stray
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
    // The count is what says it was ADDED. Reading only the last row cannot tell an addition
    // from an overwrite of the row that used to be last
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

    // Tasks store the category by name and are validated against the project's list, so a rename
    // that did not carry them across would leave every card holding a name the project no longer
    // offers — and failing to save
    const task = await request.get(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_KEY}`, {
      headers: ADMIN_AUTH,
    });
    expect(task.status(), await task.text()).toBe(200);
    expect((await task.json()).category).toBe("feature");

    // The rename adds the new name before dropping the old — deliberately, so no task is ever
    // holding a name the project does not offer — which moves the row to the end. What this test
    // is about is which names exist, not where they sit.
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
      // Anchored, because the settings page renders a spinner until the project arrives: an
      // unanchored absence resolves during the fetch and says nothing about what was saved
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

/**
 * BP-248, absorbed from settings-save.spec.ts. Saving an integration advanced the draft's baseline
 * only when the save **failed**, so a save that worked left the page believing it still had
 * unsaved work — and pressing Save again re-diffed against the stale baseline and re-sent work
 * already done. The audit log carries two removals of one webhook with no addition between them.
 *
 * These assert whether the save bar is **shown**, never what it says. SaveBar deliberately holds
 * its last summary in a ref so the strip does not flash "0 unsaved changes" while it slides away,
 * which means the text survives at `max-height: 0` long after the count reaches zero. A test
 * reading that text would pass before the fix and after it, and reading it is what cost an hour
 * of believing the fix had not worked.
 */
test.describe("Integrations · the save bar", () => {
  /** Webhooks are not on the page until added: the catalogue offers them behind the picker. */
  async function openWebhooks(page: Page) {
    await page.goto(SETTINGS);
    await page.getByRole("button", { name: "Integrations", exact: true }).first().click();
    // The picker only appears once something is already connected; on a board with no integrations
    // the tiles are on show already. Both states are normal, so neither is assumed.
    const picker = page.getByRole("button", { name: /Add integration/ });
    const anyWebhookShape = page.getByRole("button", { name: /Webhooks/ });
    // One of the two shapes has to be on screen before it can be read which one this is
    await expect(picker.or(anyWebhookShape).first()).toBeVisible();
    if (await picker.isVisible()) await picker.click();

    // The row's accessible name has three forms — "Webhooks POST board events to any URL" before
    // anything is configured, "Webhooks 1 endpoint" after, and a separate "Configure Webhooks"
    // button beside it. Matching the first thing containing "Webhooks" survives all of them;
    // anchoring on any one description works exactly once and then rots. (The vendor prefix the
    // first form used to carry left with BP-510, which made the brand icon decorative.)
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

    // "1 endpoint" renders from `project`, which only moves once the server has answered — so it
    // is what says the save is over. Asserting the bar first passes while the request is still in
    // flight, because the button relabels itself to "Saving..." and goes hidden under that name.
    await expect(page.getByText("1 endpoint")).toBeVisible();

    // The whole defect in one assertion: the save worked and the page still asked to be saved
    await expect(saveButton(page)).toBeHidden();
  });

  test("pressing Save again after a successful save sends nothing", async ({ page }) => {
    await signIn(page);
    // The input is held rather than re-opened: `openWebhooks` navigates, and a navigation between
    // the two saves rebuilds the draft's baseline from the server — repairing by hand the exact
    // staleness this test exists to catch, and leaving it green against the bug.
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

    // Add a second one and save again. If the baseline had not moved, this save would re-issue the
    // first webhook's POST alongside the second — two requests where one is correct.
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

    // The toast carries the server's own message, not the fallback — `fail` prefers err.message
    await expect(page.getByText("nope")).toBeVisible();
    await expect(saveButton(page), "a failed save must keep the work on screen").toBeVisible();
  });

  /**
   * BP-407. Delivery stays single-shot (rpo's call, see the ticket) — what changed is that the one
   * attempt's outcome is no longer silent. Not exercised through a real delivery (BP-408 blocks
   * that): the seed writes the outcome `dispatchWebhooks` itself would have written, and this only
   * asserts the settings page reads it back correctly.
   */
  test("the webhooks panel shows what the last delivery attempt did", async ({ page }) => {
    await seedWebhookDeliveryOutcomes();
    await signIn(page);
    await openWebhooks(page);

    await expect(page.getByText(/Last delivered/)).toBeVisible();
    await expect(page.getByText(/Last delivery failed/)).toBeVisible();
    await expect(page.getByText("connect ECONNREFUSED")).toBeVisible();

    // The control: the third seeded endpoint has never been delivered to, and a panel that
    // printed an outcome for everything would satisfy all three assertions above
    await expect(page.getByText(/Last deliver/)).toHaveCount(2);
  });
});
