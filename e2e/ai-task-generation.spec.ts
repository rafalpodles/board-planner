import { test, expect, type Page } from "@playwright/test";
import { AI_STUB_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  FIELDS,
  HELD_TASK_TITLE,
  PROJECT_KEY,
  PROJECT_NAME,
  EXTRA_CATEGORY,
  seed,
  seedCustomFields,
  seedExtraCategory,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

const GENERATED = {
  title: "Add a dark mode toggle to the header",
  description: "## Why\n\nThe board is unreadable at night.\n\n## How\n\nA toggle beside the avatar.",
  category: EXTRA_CATEGORY,
  acceptanceCriteria: "- [ ] The toggle is reachable from the header\n- [ ] The choice survives a reload",
  fields: { Difficulty: "L", Platforms: ["Web"] },
  duplicateOf: 2,
  duplicateReason: "Already in review as a review-column card",
  suggestedBlockedBy: [1],
  suggestedBlocking: [3],
  dependencyReason: "The held task lands first",
};

function scripted(answer: unknown): string {
  return `add a dark mode toggle <<${JSON.stringify(answer)}>>`;
}

const signIn = arriveSignedIn;

async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = ((window as unknown as { __toasts?: string[] }).__toasts = []);
    new MutationObserver((records) =>
      records.forEach((record) =>
        record.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          const added = node.matches('[data-testid="toast"]')
            ? [node]
            : Array.from(node.querySelectorAll('[data-testid="toast"]'));
          for (const toast of added) seen.push(toast.textContent ?? "");
        })
      )
    ).observe(document.body, { childList: true, subtree: true });
  });
}

function expectToast(page: Page, message: string) {
  return expect
    .poll(() => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts))
    .toContain(message);
}

async function lastPromptSent(): Promise<{ system: string; user: string; model: string }> {
  const body = await (await fetch(`${AI_STUB_URL}/last-request`)).json();
  const messages: { role: string; content: string }[] = body.messages ?? [];
  return {
    system: messages.find((m) => m.role === "system")?.content ?? "",
    user: messages.find((m) => m.role === "user")?.content ?? "",
    model: body.model ?? "",
  };
}

async function openNewTaskForm(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await recordToasts(page);
  await page.getByRole("button", { name: "New task" }).click();
  const modal = page.getByRole("dialog", { name: "New Task" });
  await expect(modal).toBeVisible();
  return modal;
}

test.beforeEach(async () => {
  await seed();
  await seedCustomFields();
  await seedExtraCategory();
  await fetch(`${AI_STUB_URL}/reset`);
});

test("a generated task fills the form, is stored with the project's own option ids, and reports what it noticed", async ({
  page,
  request,
}) => {
  await signIn(page);
  const modal = await openNewTaskForm(page);

  const assist = modal.getByPlaceholder("Describe what you need");
  await expect(assist).toBeVisible();

  const generated = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes("/ai/generate-task")
  );
  await assist.fill(scripted(GENERATED));
  await modal.getByRole("button", { name: "Generate" }).click();
  expect((await generated).status()).toBe(200);

  await test.step("the form is filled from the answer", async () => {
    await expect(modal.getByLabel("Title")).toHaveValue(GENERATED.title);
    await expect(modal.getByText("The board is unreadable at night.")).toBeVisible();
    await expect(modal.locator("div:has(> label:text-is('Category')) > select")).toHaveValue(
      EXTRA_CATEGORY
    );
    await expect(modal.locator('input[value="The toggle is reachable from the header"]')).toBeVisible();
    await expect(modal.locator('input[value="The choice survives a reload"]')).toBeVisible();
    await expectToast(page, "Fields filled by AI — review and save");
  });

  await test.step("what it noticed about the rest of the board is shown", async () => {
    await expect(modal.getByText(`Possible duplicate of ${PROJECT_KEY}-2`)).toBeVisible();
    await expect(modal.getByText(GENERATED.duplicateReason)).toBeVisible();
    await expect(modal.getByText(GENERATED.dependencyReason)).toBeVisible();
    await expect(modal.getByText(`Blocked by: ${PROJECT_KEY}-1`)).toBeVisible();
    await expect(modal.getByText(`Would block: ${PROJECT_KEY}-3`)).toBeVisible();
  });

  await test.step("the prompt was built from this project, not from a template", async () => {
    const sent = await lastPromptSent();
    expect(sent.user).toContain("add a dark mode toggle");
    expect(sent.system).toContain(PROJECT_NAME);
    expect(sent.system).toContain(EXTRA_CATEGORY);
    expect(sent.system).toContain("Difficulty");
    expect(sent.system).toContain("Platforms");
    expect(sent.system).toContain('"L"');
    expect(sent.system).toContain('"Web"');
    expect(sent.system).not.toContain("Retired");
    expect(sent.system).toContain(HELD_TASK_TITLE);
  });

  await test.step("saving stores the option ids the project uses, not the text the model wrote", async () => {
    const created = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.url().endsWith("/tasks")
    );
    await modal.getByRole("button", { name: "Create Task" }).click();
    const createResponse = await created;
    expect(createResponse.status(), await createResponse.text()).toBe(201);
    const task = await createResponse.json();

    const stored = await (
      await request.get(`/api/projects/${PROJECT_KEY}/tasks/${task._id}`, { headers: ADMIN_AUTH })
    ).json();

    expect(stored.title).toBe(GENERATED.title);
    expect(stored.category).toBe(EXTRA_CATEGORY);
    expect(stored.checklist.map((item: { text: string }) => item.text)).toEqual([
      "The toggle is reachable from the header",
      "The choice survives a reload",
    ]);
    expect(stored.customFieldValues[String(FIELDS.difficulty._id)]).toBe("aa-large");
    expect(stored.customFieldValues[String(FIELDS.platforms._id)]).toEqual(["aa-web"]);
  });
});

test("a category the project does not have falls back rather than being stored", async ({
  page,
  request,
}) => {
  await signIn(page);
  const modal = await openNewTaskForm(page);

  const category = modal.locator("div:has(> label:text-is('Category')) > select");
  await category.selectOption("bug");
  await expect(category).toHaveValue("bug");

  await modal
    .getByPlaceholder("Describe what you need")
    .fill(scripted({ ...GENERATED, category: "epic", fields: {}, duplicateOf: null }));
  await modal.getByRole("button", { name: "Generate" }).click();
  await expectToast(page, "Fields filled by AI — review and save");

  await expect(category).toHaveValue("user-story");

  const created = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().endsWith("/tasks")
  );
  await modal.getByRole("button", { name: "Create Task" }).click();
  const createResponse = await created;
  expect(createResponse.status(), await createResponse.text()).toBe(201);
  const task = await createResponse.json();
  const stored = await (
    await request.get(`/api/projects/${PROJECT_KEY}/tasks/${task._id}`, { headers: ADMIN_AUTH })
  ).json();
  expect(stored.category).toBe("user-story");
});

test("an answer the app cannot read leaves the form alone and says so", async ({ page }) => {
  await signIn(page);
  const modal = await openNewTaskForm(page);

  const failed = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes("/ai/generate-task")
  );
  await modal.getByPlaceholder("Describe what you need").fill("add a toggle <<this is not JSON>>");
  await modal.getByRole("button", { name: "Generate" }).click();
  expect((await failed).status()).toBe(500);

  await expectToast(page, "AI generation failed");
  expect((await lastPromptSent()).user).toContain("this is not JSON");
  await expect(modal.getByLabel("Title")).toHaveValue("");
});
