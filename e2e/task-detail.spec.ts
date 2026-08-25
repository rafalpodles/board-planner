import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  DECOY_TASK_ID,
  DECOY_TASK_NUMBER,
  FINISHED_TASK_ID,
  FINISHED_TASK_NUMBER,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  storedActivity,
  seed,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";
import { TASK_TITLE_MAX_LENGTH } from "@/lib/identifiers";

/**
 * BP-385: the task detail surface — comments, mentions, watching, acceptance criteria,
 * dependency links, uploads and the history those actions write. The board-side effects of
 * these features are other specs' subject; this one lives where a person works on a task.
 *
 * Every server-side assertion waits for the write it checks: this view repaints optimistically
 * all over (autosaved fields especially), so what is on screen says nothing about the server.
 * Notifications are written fire-and-forget by design, so their assertions poll.
 */

test.beforeEach(seed);

/** The shape the server stores per checklist row, minus its own bookkeeping fields. */
interface ChecklistItem {
  text: string;
  done: boolean;
}

const boardUrl = `/projects/${PROJECT_KEY}`;
const taskUrl = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;

// A 1×1 transparent PNG; small enough to pass the upload limit, real enough to preview
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

async function signIn(page: Page) {
  await arriveSignedIn(page);
  await page.goto(boardUrl);
  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
}

/** Asserts the exact contract: creation answers 201, mutations of existing rows answer 200. */
async function expectWritten(write: Promise<{ status(): number }>, status: number) {
  expect((await write).status()).toBe(status);
}

/**
 * Every test seeds from scratch, and seeding empties the sessions too — so each one signs
 * in for itself before walking to the task. Direct navigation renders the full-page detail;
 * opening from the board is the modal's own test.
 */
async function openTask(page: Page, taskNumber: number) {
  await signIn(page);
  await page.goto(taskUrl(taskNumber));
  await expect(page.getByText(`${PROJECT_KEY}-${taskNumber}`).first()).toBeVisible();
}

function composer(page: Page): Locator {
  return page.getByPlaceholder("Write a comment, @mention someone…");
}

/** The write this view is about, registered before the action that triggers it. */
function taskWrite(page: Page, method: string, urlPart: string) {
  return page.waitForResponse(
    (res) => res.request().method() === method && res.url().includes(urlPart)
  );
}

async function readTask(request: APIRequestContext, taskNumber: number) {
  const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${taskNumber}`, {
    headers: ADMIN_AUTH,
  });
  expect(res.status()).toBe(200);
  return res.json();
}

test("a card opened from the board opens as a dialog and closes back to it", async ({ page }) => {
  await signIn(page);
  await page.locator(`[data-column-body] a[href="${taskUrl(SIBLING_TASK_NUMBER)}"]`).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(`${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`)).toBeVisible();
  // The title is an editable field here, not a heading
  await expect(dialog.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

  await dialog.getByRole("button", { name: "Close task" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});

test("comments can be posted, edited and deleted, and say so while they last", async ({
  page,
}) => {
  await openTask(page, FINISHED_TASK_NUMBER);

  const posted = taskWrite(page, "POST", `/tasks/${FINISHED_TASK_ID}/comments`);

  await test.step("an empty composer cannot post", async () => {
    await expect(page.getByText("No comments yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Comment" })).toBeDisabled();
  });

  await test.step("posting shows the comment under its author", async () => {
    await composer(page).fill("First observation");
    await page.getByRole("button", { name: "Comment" }).click();
    await expectWritten(posted, 201);

    // Scoped to the comment's own card: the detail names its reporter and creator elsewhere
    const panel = page.locator("#main-content");
    const card = panel.locator("div.bg-bg-input", { hasText: "First observation" });
    await expect(card).toBeVisible();
    await expect(card.getByText("E2E Admin")).toBeVisible();
    await expect(panel.getByText("(edited)")).toHaveCount(0);
  });

  await test.step("editing marks the comment as edited", async () => {
    const card = page
      .locator("#main-content div.bg-bg-input", { hasText: "First observation" })
      .first();

    const saved = taskWrite(page, "PUT", `/tasks/${FINISHED_TASK_ID}/comments`);
    await card.getByRole("button", { name: "Edit" }).click();
    await card.locator("textarea").fill("First observation, revised");
    await card.getByRole("button", { name: "Save" }).click();
    await expectWritten(saved, 200);

    await expect(page.locator("#main-content").getByText("First observation, revised")).toBeVisible();
    await expect(page.locator("#main-content").getByText("(edited)")).toBeVisible();
  });

  await test.step("deleting asks once and then the thread is empty again", async () => {
    const card = page
      .locator("#main-content div.bg-bg-input", { hasText: "First observation, revised" })
      .first();
    await card.getByRole("button", { name: "Delete" }).click();

    const dialog = page.getByRole("dialog", { name: "Delete Comment" });
    const deleted = taskWrite(page, "DELETE", `/tasks/${FINISHED_TASK_ID}/comments`);
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expectWritten(deleted, 200);

    const panel = page.locator("#main-content");
    await expect(panel.getByText("No comments yet")).toBeVisible();
    await expect(panel.getByText(/First observation/)).toHaveCount(0);
  });
});

test("a mention lands in the mentioned user's feed", async ({ page, request }) => {
  await openTask(page, FINISHED_TASK_NUMBER);

  const posted = taskWrite(page, "POST", `/tasks/${FINISHED_TASK_ID}/comments`);
  await composer(page).fill("@member could you take a look at this?");
  await page.getByRole("button", { name: "Comment" }).click();
  await expectWritten(posted, 201);

  // The notification is dispatched without blocking the reply, so the feed is polled until
  // the write lands rather than read once on a clock
  await expect
    .poll(async () => {
      const res = await request.get("/api/notifications", { headers: MEMBER_AUTH });
      expect(res.status()).toBe(200);
      const feed = await res.json();
      return feed.some(
        (n: { type: string; task?: { taskNumber?: number } }) =>
          n.type === "mentioned" && n.task?.taskNumber === FINISHED_TASK_NUMBER
      );
    })
    .toBe(true);
});

test("watching puts a person on the list and their feed keeps following the task", async ({
  page,
  request,
}) => {
  await openTask(page, DECOY_TASK_NUMBER);

  await test.step("watching registers and says so", async () => {
    const watched = taskWrite(page, "POST", `/tasks/${DECOY_TASK_ID}/watch`);
    await page.getByRole("button", { name: "Watch", exact: true }).click();
    await expect((await watched).json()).resolves.toMatchObject({ watching: true });

    await expect(page.getByRole("button", { name: /Watching\s*\(1\)/ })).toBeVisible();
    const task = await readTask(request, DECOY_TASK_NUMBER);
    expect(task.watchers).toHaveLength(1);
  });

  await test.step("a second watcher joins through the API", async () => {
    const joined = await request.post(
      `/api/projects/${PROJECT_KEY}/tasks/${DECOY_TASK_ID}/watch`,
      { headers: MEMBER_AUTH, data: {} }
    );
    expect(joined.status()).toBe(200);

    const task = await readTask(request, DECOY_TASK_NUMBER);
    expect(task.watchers).toHaveLength(2);

    // The join happened behind this page's back, so its counter learns on a reload
    await page.reload();
    await expect(page.getByRole("button", { name: /Watching\s*\(2\)/ })).toBeVisible();
  });

  await test.step("a change reaches the watcher who never had the page open", async () => {
    const moved = taskWrite(page, "PATCH", `/tasks/${DECOY_TASK_ID}/status`);
    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "In Progress" }).click();
    expect((await moved).status()).toBe(200);

    await expect
      .poll(async () => {
        const res = await request.get("/api/notifications", { headers: MEMBER_AUTH });
        expect(res.status()).toBe(200);
        const feed = await res.json();
        return feed.some(
          (n: { type: string; task?: { taskNumber?: number } }) =>
            n.type === "status_changed" && n.task?.taskNumber === DECOY_TASK_NUMBER
        );
      })
      .toBe(true);
  });

  await test.step("unwatching takes the person off again", async () => {
    const unwatched = taskWrite(page, "POST", `/tasks/${DECOY_TASK_ID}/watch`);
    await page.getByRole("button", { name: /Watching\s*\(2\)/ }).click();
    await expect((await unwatched).json()).resolves.toMatchObject({ watching: false });

    await expect(page.getByRole("button", { name: /^Watch(?!ing)/ })).toBeVisible();
    const task = await readTask(request, DECOY_TASK_NUMBER);
    expect(task.watchers).toHaveLength(1);
  });
});

test("acceptance criteria tick, count, persist and reach the card", async ({ page, request }) => {
  await openTask(page, FINISHED_TASK_NUMBER);

  const detail = page.locator("#main-content");

  await test.step("adding two criteria starts both unticked", async () => {
    const addBox = page.getByLabel("Add criterion");
    const saved = taskWrite(page, "PUT", `/tasks/${FINISHED_TASK_ID}`);
    await addBox.fill("the build passes");
    await addBox.press("Enter");
    await saved;

    const savedSecond = taskWrite(page, "PUT", `/tasks/${FINISHED_TASK_ID}`);
    await addBox.fill("the docs mention it");
    await addBox.press("Enter");
    await savedSecond;

    await expect(detail.getByText("0/2")).toBeVisible();
  });

  await test.step("ticking one moves the counter", async () => {
    const ticked = taskWrite(page, "PUT", `/tasks/${FINISHED_TASK_ID}`);
    await page.getByRole("checkbox", { name: "the build passes" }).click();
    await ticked;

    await expect(detail.getByText("1/2")).toBeVisible();
    const task = await readTask(request, FINISHED_TASK_NUMBER);
    expect(task.checklist.map(({ text, done }: ChecklistItem) => ({ text, done }))).toEqual([
      { text: "the build passes", done: true },
      { text: "the docs mention it", done: false },
    ]);
  });

  await test.step("what the counter says survives a reload", async () => {
    await page.reload();
    await expect(detail.getByText("1/2")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "the build passes" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  await test.step("removing one leaves the other", async () => {
    const removed = taskWrite(page, "PUT", `/tasks/${FINISHED_TASK_ID}`);
    await page.getByRole("button", { name: "Remove criterion 2" }).click();
    await removed;

    await expect(detail.getByText("1/1")).toBeVisible();
    const task = await readTask(request, FINISHED_TASK_NUMBER);
    expect(task.checklist.map(({ text, done }: ChecklistItem) => ({ text, done }))).toEqual([
      { text: "the build passes", done: true },
    ]);
  });

  await test.step("the card carries the progress onto the board", async () => {
    await page.goto(boardUrl);
    const card = page
      .locator(`[data-column-body] a[href="${taskUrl(FINISHED_TASK_NUMBER)}"]`)
      .first();
    await expect(card).toBeVisible();
    await expect(card.getByText("1/1")).toBeVisible();
  });
});

test("dependencies: a blocker is linked by key, shown, and removable", async ({
  page,
  request,
}) => {
  await openTask(page, DECOY_TASK_NUMBER);

  await test.step("picking a task by its key links it as a blocker", async () => {
    await page.getByRole("button", { name: "+ Add dependency" }).click();

    const picker = page.getByPlaceholder(/search tasks/i).locator("..");
    await picker.getByPlaceholder(/search tasks/i).fill(`${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`);

    const linked = taskWrite(page, "POST", `/tasks/${DECOY_TASK_ID}/links`);
    await picker.getByRole("button", { name: SIBLING_TASK_TITLE }).click();
    expect((await linked).status()).toBe(200);

    await expect(page.getByText("Dependency added")).toBeVisible(); // toast
    const blockedBy = page.getByText("Blocked by").locator("..");
    await expect(blockedBy.getByText(`${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`)).toBeVisible();
    await expect(blockedBy.getByText(SIBLING_TASK_TITLE)).toBeVisible();

    const task = await readTask(request, DECOY_TASK_NUMBER);
    expect(task.blockedBy.map((b: { _id: string }) => b._id)).toContain(String(SIBLING_TASK_ID));
  });

  await test.step("removing it clears the list and the server", async () => {
    const removed = taskWrite(page, "DELETE", `/tasks/${DECOY_TASK_ID}/links`);
    await page.getByRole("button", { name: `Unlink ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` }).click();
    await expectWritten(removed, 200);

    await expect(page.getByText("Blocked by")).toHaveCount(0);
    const task = await readTask(request, DECOY_TASK_NUMBER);
    expect(task.blockedBy).toEqual([]);
  });
});

test("uploads: an image attaches into the description, an oversized one is refused", async ({
  page,
  request,
}) => {
  await openTask(page, FINISHED_TASK_NUMBER);

  // The description renders read-only until somebody asks to change it
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const descriptionField = page
    .locator("section")
    .filter({ hasText: "Description" })
    .locator("textarea");
  const fileInput = page.locator('input[type="file"]');

  await test.step("attaching inserts markdown and persists it", async () => {
    const uploaded = taskWrite(page, "POST", "/api/uploads");
    await fileInput.setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: TINY_PNG });
    await expectWritten(uploaded, 200);

    await expect(descriptionField).toHaveValue(/!\[.*\]\(.+\)/);

    const saved = taskWrite(page, "PUT", `/tasks/${FINISHED_TASK_ID}`);
    await descriptionField.blur();
    await saved;
    const task = await readTask(request, FINISHED_TASK_NUMBER);
    expect(task.description).toMatch(/!\[.*\]\(.+\)/);
  });

  await test.step("a file past the size limit answers 413 and inserts nothing", async () => {
    const before = await descriptionField.inputValue();

    const refused = taskWrite(page, "POST", "/api/uploads");
    await fileInput.setInputFiles({
      name: "too-big.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(6 * 1024 * 1024, 0),
    });
    // 413 specifically: the route answers 400 for a missing file, a missing projectId and a
    // disallowed type, all before it ever reaches the size check this step is about
    const response = await refused;
    expect(response.status()).toBe(413);
    expect(await response.text()).toMatch(/Maximum size is 5MB/);

    // A one-shot check after a settle, not a retrying matcher: the value is already `before`, so
    // toHaveValue would pass on its first poll and never see an insert landing a tick later
    await page.waitForTimeout(1_000);
    expect(await descriptionField.inputValue()).toBe(before);
  });

  await test.step("the stored file answers only to somebody carrying credentials", async () => {
    const markdown = (await readTask(request, FINISHED_TASK_NUMBER)).description;
    const fileId = markdown.match(/\((.+)\)/)?.[1] ?? "";
    const bare = await request.get(fileId); // no Authorization header at all
    expect([401, 403]).toContain(bare.status());

    // The control: without it a route refusing everybody reads exactly like a working guard
    const carried = await request.get(fileId, { headers: ADMIN_AUTH });
    expect(carried.status()).toBe(200);
    expect(carried.headers()["content-type"]).toContain("image/png");
  });
});

test("the history tab narrates a status change with both columns named", async ({ page }) => {
  await openTask(page, FINISHED_TASK_NUMBER);

  await test.step("a status change is announced with both columns named", async () => {
    const moved = taskWrite(page, "PATCH", `/tasks/${FINISHED_TASK_ID}/status`);
    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "In Progress" }).click();
    await expectWritten(moved, 200);
  });

  // The activity log is written fire-and-forget beside the status write, so the reload is
  // gated on the entry actually existing — reloading sooner hands the History tab's one-shot
  // fetch a board that does not know yet what just happened
  await expect.poll(async () => {
    const activity = await storedActivity(FINISHED_TASK_ID);
    return activity[0] && {
      ...activity[0],
    };
  }).toMatchObject({
    action: "status_changed",
    field: "status",
    oldValue: "todo",
    newValue: "in_progress",
  });

  await page.reload();

  await test.step("the timeline tells the story", async () => {
    await page.getByRole("tab", { name: /History/ }).click();
    await expect(
      page.getByText("changed status from To Do to In Progress")
    ).toBeVisible();
  });

  await test.step("and the server agrees with the telling", async () => {
    const activity = await storedActivity(FINISHED_TASK_ID);
    expect(activity[0]).toMatchObject({
      action: "status_changed",
      field: "status",
      oldValue: "todo",
      newValue: "in_progress",
    });
  });
});

/**
 * BP-437. `title` is `required` on the schema, so a blank one used to be refused by Mongoose's
 * updateValidators rather than by the route, and the ValidationError nobody catches left as a 500.
 *
 * Driven as the gesture that finds it: this field saves on change, so selecting the title and
 * deleting it — what a person does on the way to typing a new one — sends the empty value. The
 * status is the whole subject, so it is read off the response rather than inferred from the screen.
 */
test("clearing the title is refused rather than crashing, and the stored one survives", async ({
  page,
  request,
}) => {
  await openTask(page, SIBLING_TASK_NUMBER);
  const field = page.getByLabel("Task title");
  await expect(field).toHaveValue(SIBLING_TASK_TITLE);

  await test.step("emptying it answers 400, not 500", async () => {
    const refused = taskWrite(page, "PUT", `/tasks/${SIBLING_TASK_ID}`);
    await field.fill("");
    expect((await refused).status()).toBe(400);
  });

  await test.step("and the title on the server is untouched", async () => {
    // Read from the API, not from the field: what the field holds is the text this test typed,
    // which is true whether the write was refused or lost.
    expect((await readTask(request, SIBLING_TASK_NUMBER)).title).toBe(SIBLING_TASK_TITLE);
  });

  // The control. Without it, "the write was refused" is equally consistent with a guard that
  // refuses every title, and this screen would be broken rather than fixed.
  await test.step("an ordinary rename still saves", async () => {
    const saved = taskWrite(page, "PUT", `/tasks/${SIBLING_TASK_ID}`);
    await field.fill("Renamed after the refusal");
    expect((await saved).status()).toBe(200);
    expect((await readTask(request, SIBLING_TASK_NUMBER)).title).toBe("Renamed after the refusal");
  });
});

/**
 * BP-440. BP-437 refuses the titles `trim()` empties; a zero-width space is not one of them, so a
 * title of a single U+200B was stored and painted an entirely blank heading here and on the board —
 * the outcome that change exists to prevent, one paste further along. Nothing capped the length at
 * any layer either, and the title is interpolated into a Slack payload downstream.
 */
test("an invisible title is refused, and one past the cap never reaches the database", async ({
  page,
  request,
}) => {
  await openTask(page, SIBLING_TASK_NUMBER);
  const field = page.getByLabel("Task title");
  await expect(field).toHaveValue(SIBLING_TASK_TITLE);

  await test.step("a title of one zero-width space answers 400", async () => {
    const refused = taskWrite(page, "PUT", `/tasks/${SIBLING_TASK_ID}`);
    // Built from its code point rather than pasted: the character is as invisible in this file as
    // it is on the board, and a diff cannot show what it does not paint.
    await field.fill(String.fromCodePoint(0x200b));
    expect((await refused).status()).toBe(400);
  });

  await test.step("and the blank one is reported in the server's own words", async () => {
    await expect(saveStatus(page).getByRole("button")).toHaveText("⚠ Title is required — retry");
  });

  await test.step("the title on the server is untouched", async () => {
    // Read from the API, not from the field: what the field holds is the text this test typed,
    // which is true whether the write was refused or lost.
    expect((await readTask(request, SIBLING_TASK_NUMBER)).title).toBe(SIBLING_TASK_TITLE);
  });

  /**
   * The cap asserted on the outcome rather than on the status code, because two defences stand in
   * front of it and either one is a pass: the field's own maxLength may cut the paste to the cap
   * before a request exists, and the server refuses whatever survives that. What must not happen —
   * what nothing prevented before — is a stored title longer than the cap.
   */
  await test.step("a title past the cap never reaches the database", async () => {
    // The write is awaited rather than the read polled: reading before it lands would pass against
    // a server that stores anything, which is the state this test was written from.
    const write = taskWrite(page, "PUT", `/tasks/${SIBLING_TASK_ID}`);
    await field.fill("a".repeat(TASK_TITLE_MAX_LENGTH + 1));
    await write;

    const stored = (await readTask(request, SIBLING_TASK_NUMBER)).title as string;
    expect(stored.length).toBeLessThanOrEqual(TASK_TITLE_MAX_LENGTH);
  });

  // The control, at the boundary: without it a guard refusing every title would pass everything
  // above, and a cap off by one would look identical to a cap that works. A different character
  // from the step before, so the field's value genuinely changes and the autosave genuinely fires.
  await test.step("a title of visible characters, exactly at the cap, still saves", async () => {
    const atTheCap = "b".repeat(TASK_TITLE_MAX_LENGTH);
    const saved = taskWrite(page, "PUT", `/tasks/${SIBLING_TASK_ID}`);
    await field.fill(atTheCap);
    expect((await saved).status()).toBe(200);
    expect((await readTask(request, SIBLING_TASK_NUMBER)).title).toBe(atTheCap);
  });
});

/**
 * The autosave line under the title. Filtered rather than taken by position: the top bar has a
 * live region of its own, and this one has to be found in every state it reports — including the
 * failure, which is the state that used to have no live region at all.
 */
function saveStatus(page: Page): Locator {
  return page
    .locator("#main-content [aria-live='polite']")
    .filter({ hasText: /All changes saved|Saving|retry/ });
}

/**
 * BP-439. BP-437 turned the blank title's 500 into a 400 that says "Title is required", and the
 * screen went on printing "Save failed" — the same nothing, in the scenario that justified the
 * change. Driven the way a person meets it: the refused title stays in the draft, so the next edit
 * to a DIFFERENT field goes out beside it and is refused for the same reason, which is precisely
 * when being told the reason decides whether the screen is recoverable.
 */
test("a refused autosave says what the server refused, and keeps saying it", async ({ page }) => {
  await openTask(page, SIBLING_TASK_NUMBER);
  const field = page.getByLabel("Task title");
  await expect(field).toHaveValue(SIBLING_TASK_TITLE);
  await expect(saveStatus(page)).toHaveText("All changes saved");

  await test.step("clearing the title is reported in the server's own words", async () => {
    const refused = taskWrite(page, "PUT", `/tasks/${SIBLING_TASK_ID}`);
    await field.fill("");
    expect((await refused).status()).toBe(400);

    await expect(saveStatus(page).getByRole("button")).toHaveText("⚠ Title is required — retry");
  });

  await test.step("and so is the next edit, which the refused title takes down with it", async () => {
    const refused = taskWrite(page, "PUT", `/tasks/${SIBLING_TASK_ID}`);
    await page.getByRole("combobox", { name: "Priority", exact: true }).click();
    await page
      .getByRole("listbox", { name: "Priority", exact: true })
      .getByRole("option", { name: "High", exact: true })
      .click();
    expect((await refused).status()).toBe(400);

    await expect(saveStatus(page).getByRole("button")).toHaveText("⚠ Title is required — retry");
  });

  // The control. Without it, a line that always reads "Title is required" would pass every
  // assertion above while telling the reader the same one thing forever.
  await test.step("a title the server accepts puts the line back", async () => {
    const saved = taskWrite(page, "PUT", `/tasks/${SIBLING_TASK_ID}`);
    await field.fill("Renamed after the refusal");
    expect((await saved).status()).toBe(200);

    await expect(saveStatus(page)).toHaveText("All changes saved");
  });
});

/**
 * BP-437, the same mine one section lower. `checklist[].text` is `required` too, so emptying a
 * criterion sent `text: ""` and got the identical escaped ValidationError as a blank title.
 *
 * Adding one is the control that matters most here: `CriteriaSection` refuses to append a blank,
 * so the guard must never be reachable by the constructive gesture — only by the destructive one.
 */
test("emptying an acceptance criterion is refused, and the stored one survives", async ({
  page,
  request,
}) => {
  await openTask(page, FINISHED_TASK_NUMBER);

  await test.step("a criterion is added the ordinary way", async () => {
    const saved = taskWrite(page, "PUT", `/tasks/${FINISHED_TASK_ID}`);
    await page.getByLabel("Add criterion").fill("the build passes");
    await page.getByLabel("Add criterion").press("Enter");
    expect((await saved).status()).toBe(200);
  });

  await test.step("clearing it answers 400, not 500", async () => {
    await page.getByRole("button", { name: "Criterion 1", exact: true }).click();

    // The edit-mode render settled, read off React's own state rather than a clock. Clicking swaps
    // a rendered div for a textarea, and a fill landing inside that swap is dropped: the value goes
    // into the DOM, React's state keeps the old one, no change event, no save — and the wait below
    // then times out on a request that was never sent. This assertion is a *pre-write* read, so the
    // value can only have come from React. Without it the test failed two runs in three.
    const box = page.getByRole("textbox", { name: "Criterion 1" });
    await expect(box).toHaveValue("the build passes");

    const refused = taskWrite(page, "PUT", `/tasks/${FINISHED_TASK_ID}`);
    await box.fill("");
    expect((await refused).status()).toBe(400);
  });

  // BP-440, the same field family: a criterion of one zero-width space is not empty and paints
  // nothing, so the row would have been stored and then shown as a checkbox with no text beside it.
  await test.step("and so does replacing it with a zero-width space", async () => {
    const box = page.getByRole("textbox", { name: "Criterion 1" });
    const refused = taskWrite(page, "PUT", `/tasks/${FINISHED_TASK_ID}`);
    await box.fill(String.fromCodePoint(0x200b));
    expect((await refused).status()).toBe(400);
  });

  await test.step("and the criterion on the server is untouched", async () => {
    const stored = (await readTask(request, FINISHED_TASK_NUMBER)).checklist as ChecklistItem[];
    expect(stored.map((i) => i.text)).toEqual(["the build passes"]);
  });
});
