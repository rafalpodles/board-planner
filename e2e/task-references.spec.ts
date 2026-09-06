import { test, expect, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  PROJECT_ID,
  PROJECT_KEY,
  HELD_TASK_NUMBER,
  HELD_TASK_TITLE,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

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

const signIn = arriveSignedIn;

async function measured(locator: Locator) {
  let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  await expect(async () => {
    box = await locator.boundingBox();
    expect(box, "element went away between the visibility check and the measurement").not.toBeNull();
  }).toPass();
  return box!;
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

  await link.click();
  await expect(page).toHaveURL(new RegExp(`${TASK_URL}$`));

  await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();
  await expect(page.getByText(HELD_TASK_TITLE)).toHaveCount(0);
});

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

  await page.getByText(HELD_TASK_TITLE).first().click();
  await expect(page).toHaveURL(/\/tasks\/1$/);
  await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();

  const modal = page.getByRole("dialog");
  await expect(modal.getByText("Duplicate of")).toBeVisible();
  const reference = modal.getByRole("link", { name: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` });
  await expect(reference).toBeVisible();
  await reference.click();

  await expect(page).toHaveURL(new RegExp(`${TASK_URL}$`));
  await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();
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
    expect(await list.getByRole("option").count()).toBeLessThanOrEqual(10);

    const first = (await list.getByRole("option").first().innerText()).split("\n")[0].trim();
    await box.press("Enter");

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
    await expect(box).toHaveValue(`see ${PROJECT_KEY}-`);
  });

  test("offers nothing for another project's key", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);

    await page.getByPlaceholder(/comment/i).first().fill("blocked by ACME-");

    await expect(page.getByRole("listbox")).toBeHidden();
  });
});

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

test.describe("where the list appears", () => {
  test("follows the caret down a tall description", async ({ page }) => {
    const handle = await db();
    await handle
      .collection("tasks")
      .updateOne({ _id: HELD_TASK_ID }, { $set: { description: "line\n".repeat(20) } });

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/1`);
    await page.getByRole("button", { name: "Edit" }).first().click();

    const editor = page.getByPlaceholder(/Markdown supported/);
    await expect(editor).toBeVisible();
    await editor.fill("line\n".repeat(20));
    await editor.pressSequentially(`${PROJECT_KEY}-`);

    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();

    const box = await measured(editor);
    const where = await measured(list);
    expect(where.y).toBeGreaterThan(box.y + box.height / 2);
  });

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
    const field = await measured(criterion);
    const composer = page.getByPlaceholder(/@mention someone/);
    await expect(composer).toBeVisible();
    const reference = await measured(composer);

    expect(field.width).toBeGreaterThan(reference.width * 0.8);
  });

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

    await page.getByText("landing first").click();
    await expect(page.getByRole("textbox", { name: "Criterion 1" })).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: `${PROJECT_KEY}-3` })).toBeVisible();
  });

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

test.describe("a board whose key is regex punctuation", () => {
  const AWKWARD = "C(";

  test.beforeEach(async () => {
    const handle = await db();
    await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { key: AWKWARD } });
  });

  test("opens its tasks, and still offers them by key", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_ID}/tasks/${HELD_TASK_NUMBER}`);

    await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();

    const box = page.getByPlaceholder("Write a comment, @mention someone…");
    await box.click();
    await box.pressSequentially(`Blocked by ${AWKWARD}-`);

    await expect(
      page.getByRole("option", { name: SIBLING_TASK_TITLE, exact: false })
    ).toBeVisible();
  });
});
