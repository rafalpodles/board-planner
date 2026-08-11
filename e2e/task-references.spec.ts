import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  PROJECT_ID,
  PROJECT_KEY,
  HELD_TASK_TITLE,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
} from "./seed";

/**
 * BP-254, the rendering half. A task key written in prose becomes a link to that task, and nothing
 * is stored as a link — the text keeps saying `BP-12`.
 *
 * That choice is why the former key matters here: this board renamed itself from CP to BP, so
 * everything written before that still says CP and would otherwise be a dead reference. A stored
 * URL would have needed migrating through every description and comment instead.
 */

const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function addComment(body: string) {
  const handle = await db();
  await handle.collection("comments").insertOne({
    task: HELD_TASK_ID,
    author: ADMIN_ID,
    body,
    reactions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  await handle.collection("comments").deleteMany({});
  await handle
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $set: { formerKeys: ["CP"] } });
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a key written in a description links to that task, and reaches it", async ({ page }) => {
  const handle = await db();
  await handle
    .collection("tasks")
    .updateOne(
      { _id: HELD_TASK_ID },
      { $set: { description: `Blocked by ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} until it lands.` } }
    );

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

  const link = page.getByRole("link", { name: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` });
  await expect(link).toBeVisible();

  // The link has to actually arrive, not merely look like one. Asserting the URL alone was not
  // enough: the address changed while a modal drew the linked task on top of the page still
  // showing the old one, and the test passed.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${TASK_URL}$`));

  await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();
  // One task on screen, not the destination stacked over where the reader came from
  await expect(page.getByText(HELD_TASK_TITLE)).toHaveCount(0);
});

// The path the report came from: the task opened as a modal over the board, which is what the
// board's own cards do. Clicking a reference there soft-navigates, and the interceptor draws the
// destination as another modal over the one already open — two tasks stacked.
test("a reference clicked inside the task modal does not stack another one", async ({ page }) => {
  const handle = await db();
  await handle
    .collection("tasks")
    .updateOne(
      { _id: HELD_TASK_ID },
      { $set: { description: `Duplicate of ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}.` } }
    );

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);

  // Open it the way a person does, so the modal route is the one rendering
  await page.getByText(HELD_TASK_TITLE).first().click();
  await expect(page).toHaveURL(/\/tasks\/1$/);
  await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();

  // Wait for the description to be on screen before reaching into it: the modal is still settling
  // right after it opens, and the link is present in the DOM before it is stable enough to click
  // Scoped to the modal: the board underneath has its own card for that task, so an unscoped
  // locator finds two — which is itself the shape of the bug being tested
  const modal = page.getByRole("dialog");
  await expect(modal.getByText("Duplicate of")).toBeVisible();
  const reference = modal.getByRole("link", { name: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` });
  await expect(reference).toBeVisible();
  await reference.click();

  await expect(page).toHaveURL(new RegExp(`${TASK_URL}$`));
  await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();
  // The task the reader came from must not still be underneath
  await expect(page.getByText(HELD_TASK_TITLE)).toHaveCount(0);
});

test("a key from before the board was renamed still reaches the task", async ({ page }) => {
  await addComment(`Originally raised as CP-${SIBLING_TASK_NUMBER}.`);

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

  const link = page.getByRole("link", { name: `CP-${SIBLING_TASK_NUMBER}` });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", TASK_URL);
});

test("a key inside code stays text, and another project's key is left alone", async ({ page }) => {
  await addComment(
    `Branch prefix is \`${PROJECT_KEY}-9\`, and this waits on ACME-4.\n\n` +
      "```\ngit checkout bp-9/slug\n```"
  );

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

  await expect(page.getByText(`${PROJECT_KEY}-9`).first()).toBeVisible();
  await expect(page.getByRole("link", { name: `${PROJECT_KEY}-9` })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "ACME-4" })).toHaveCount(0);
});

test.describe("picking a task from the list", () => {
  test("typing the board key offers tasks, and Enter puts the key in the text", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    const box = page.getByPlaceholder(/comment/i).first();
    await box.fill(`blocked by ${PROJECT_KEY}-`);

    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();
    await expect(list.getByRole("option").first()).toBeVisible();
    // The ticket asks for at most ten, and the seeded board has fewer
    expect(await list.getByRole("option").count()).toBeLessThanOrEqual(10);

    const first = (await list.getByRole("option").first().innerText()).split("\n")[0].trim();
    await box.press("Enter");

    // Plain text, not a markdown link — that is the whole of approach (A)
    await expect(box).toHaveValue(`blocked by ${first} `);
  });

  test("arrows move the selection and Escape puts the list away", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    const box = page.getByPlaceholder(/comment/i).first();
    await box.fill(`see ${PROJECT_KEY}-`);
    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();

    await box.press("ArrowDown");
    await expect(list.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");

    await box.press("Escape");
    await expect(list).toBeHidden();
    // Escape dismisses the list, it does not edit what was written
    await expect(box).toHaveValue(`see ${PROJECT_KEY}-`);
  });

  test("offers nothing for another project's key", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    await page.getByPlaceholder(/comment/i).first().fill("blocked by ACME-");

    await expect(page.getByRole("listbox")).toBeHidden();
  });
});

// Pasting is the same feature as picking from a list, which is the point of storing plain text
test("a key typed into a new comment is a link once posted", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

  await page
    .getByPlaceholder(/comment/i)
    .first()
    .fill(`See ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} for the rest`);
  await page.getByRole("button", { name: /^(Comment|Post|Add comment)$/ }).first().click();

  await expect(
    page.getByRole("link", { name: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` })
  ).toBeVisible();
});


// A phone comments through a bar pinned to the bottom of the task and never sees the wide
// composer, so wiring the autocomplete only there left the feature — and the @mention that
// predates it — missing from mobile entirely. Reported from a phone, not caught by any test here.
// Reported from the product: on a 400px description the list hung at the top of the screen while
// the caret was at the bottom. It is measured from the caret now, not pinned to the field's edge.
test.describe("where the list appears", () => {
  test("follows the caret down a tall description", async ({ page }) => {
    const handle = await db();
    // Long enough that the caret ends up well below the top of the box
    await handle
      .collection("tasks")
      .updateOne({ _id: HELD_TASK_ID }, { $set: { description: "line\n".repeat(20) } });

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);
    await page.getByRole("button", { name: "Edit" }).first().click();

    const editor = page.getByPlaceholder(/Markdown supported/);
    await expect(editor).toBeVisible();
    // fill leaves the caret at the end; Control+End dropped it mid-text, and the key then glued
    // itself to the previous word — where the trigger correctly refuses to fire
    await editor.fill("line\n".repeat(20));
    // Key by key, so React sees each change and the trigger fires the way it does for a person
    await editor.pressSequentially(`${PROJECT_KEY}-`);

    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();

    const box = (await editor.boundingBox())!;
    const where = (await list.boundingBox())!;
    // Below where the typing is, not floating above the whole field
    expect(where.y).toBeGreaterThan(box.y + box.height / 2);
  });

  // Wrapping a field to hold the list moved its `flex-1 min-w-0` off the flex row's direct child,
  // and the criteria collapsed to a column a few characters wide. Every test here passed: they
  // asked whether the list appears, never how wide anything is.
  test("wrapping the field for the list does not narrow it", async ({ page }) => {
    const handle = await db();
    await handle.collection("tasks").updateOne(
      { _id: HELD_TASK_ID },
      {
        $set: {
          checklist: [
            { text: "A criterion long enough that a narrow column would wrap it many times", done: false },
          ],
        },
      }
    );

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    const criterion = page.getByLabel("Criterion 1").first();
    await expect(criterion).toBeVisible();
    const field = (await criterion.boundingBox())!;
    // Against the comment box, which sits in the same column and always fills it. The first version
    // of this compared against the words "Acceptance criteria" — a 140px label — so the collapsed
    // 147px field cleared the bar and the mutation passed.
    const composer = page.getByPlaceholder(/@mention someone/);
    // Measured only once it is on screen. Without the wait this raced the comments load and read a
    // null box — latent since it was written, and surfaced by /api/* going no-store.
    await expect(composer).toBeVisible();
    const reference = (await composer.boundingBox())!;

    expect(field.width).toBeGreaterThan(reference.width * 0.8);
  });

  // A criterion was a textarea, and a textarea can only ever show a key as text — which is what
  // made this the one place the reference did not work. It renders until somebody asks to edit it.
  test("a key in a criterion is a link, and reaches the task", async ({ page }) => {
    const handle = await db();
    await handle.collection("tasks").updateOne(
      { _id: HELD_TASK_ID },
      {
        $set: {
          checklist: [
            { text: `Depends on ${PROJECT_KEY}-${SIBLING_TASK_NUMBER} landing first`, done: false },
          ],
        },
      }
    );

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    const link = page.getByRole("link", { name: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` });
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(new RegExp(`${TASK_URL}$`));
  });

  test("clicking the words edits the criterion, clicking the link does not", async ({ page }) => {
    const handle = await db();
    await handle.collection("tasks").updateOne(
      { _id: HELD_TASK_ID },
      { $set: { checklist: [{ text: `Depends on ${PROJECT_KEY}-3 landing first`, done: false }] } }
    );

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    // The words, not the link: this is the reader asking to change the text
    await page.getByText("landing first").click();
    await expect(page.getByRole("textbox", { name: "Criterion 1" })).toBeFocused();

    // Blur returns it to the rendered view, links and all
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: `${PROJECT_KEY}-3` })).toBeVisible();
  });

  // The source guards the click so a link does not also open the editor. There is deliberately no
  // test for it: the click navigates away either way, so whether the editor opened first is not
  // observable, and an assertion here passed with the guard deleted. The guard stays because
  // mutating the page on the way out is wrong, not because a test can see it.

  // Editing an existing criterion is a different field from adding one, and the rendered view now
  // stands between them — so it needs its own check that the trigger survived the round trip
  test("editing an existing criterion still offers tasks", async ({ page }) => {
    const handle = await db();
    await handle.collection("tasks").updateOne(
      { _id: HELD_TASK_ID },
      { $set: { checklist: [{ text: "Something to change", done: false }] } }
    );

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);
    await page.getByText("Something to change").click();

    const field = page.getByRole("textbox", { name: "Criterion 1" });
    await expect(field).toBeFocused();
    await field.pressSequentially(` ${PROJECT_KEY}-`);

    await expect(page.getByRole("listbox")).toBeVisible();
  });

  test("acceptance criteria offer tasks too", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    const criterion = page.getByLabel("Add criterion");
    await expect(criterion).toBeVisible();
    await criterion.fill(`depends on ${PROJECT_KEY}-`);

    await expect(page.getByRole("listbox")).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the bottom bar offers tasks too", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    const bar = page.getByLabel("Add a comment");
    await expect(bar).toBeVisible();
    await bar.fill(`blocked by ${PROJECT_KEY}-`);

    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();

    const first = (await list.getByRole("option").first().innerText()).split("\n")[0].trim();
    await bar.press("Enter");

    await expect(bar).toHaveValue(`blocked by ${first} `);
  });

  test("the bottom bar offers people too", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    await page.getByLabel("Add a comment").fill(`thanks @${ADMIN_USERNAME.slice(0, 3)}`);

    await expect(page.getByRole("listbox")).toBeVisible();
  });

  // Enter picks a suggestion while the list is open; it must not also send the comment
  test("picking a suggestion does not post the comment", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    const bar = page.getByLabel("Add a comment");
    await bar.fill(`see ${PROJECT_KEY}-`);
    await expect(page.getByRole("listbox")).toBeVisible();
    await bar.press("Enter");

    await expect(bar).not.toHaveValue("");
  });
});
