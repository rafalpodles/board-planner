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

/**
 * BP-396 — AI Assist in the new-task form, driven against a local stand-in for OpenAI.
 *
 * The stub answers; everything else is production code — the SDK, the route, the prompt built from
 * this project's own fields and open tasks, the JSON parse and sanitising in `src/lib/ai.ts`,
 * `resolveGeneratedFields` turning the model's option *text* into the project's option *ids*, and
 * the form the whole thing lands in.
 *
 * Two things are asserted that a "the form filled in" test would miss:
 *
 * - what the app *sent*. A generation judged only by its result cannot tell a prompt built from
 *   this project's fields from a hardcoded S/M/L/XL scale, which is exactly the bug CP-213 fixed.
 * - what was *stored*. The fixture's option ids differ from the text they stand for on purpose
 *   (`zz-small` is "S", `aa-large` is "L"), so a task saved with "L" instead of `aa-large` fails
 *   here and passes any assertion made on the screen.
 */

const GENERATED = {
  title: "Add a dark mode toggle to the header",
  description: "## Why\n\nThe board is unreadable at night.\n\n## How\n\nA toggle beside the avatar.",
  category: EXTRA_CATEGORY,
  acceptanceCriteria: "- [ ] The toggle is reachable from the header\n- [ ] The choice survives a reload",
  // Keyed by field *name*, valued with the option *text* — the shape the model answers in
  fields: { Difficulty: "L", Platforms: ["Web"] },
  duplicateOf: 2,
  duplicateReason: "Already in review as a review-column card",
  suggestedBlockedBy: [1],
  suggestedBlocking: [3],
  dependencyReason: "The held task lands first",
};

/** The stub replies with whatever a prompt carries between << and >>. */
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

/** What the app last sent the model, read back from the stub. */
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
  // After the navigation: the observer lives in the page, and a goto throws it away
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

  // Rendered only when the server reports AI configured — which is the key's presence and nothing
  // about the stub. What proves the stub is reached is the round trip below.
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
    // Not one of bug/doc/user-story/idea: those are also `generateTask`'s hardcoded fallback, so a
    // task landing on one says nothing about this project's own list having been read
    await expect(modal.locator("div:has(> label:text-is('Category')) > select")).toHaveValue(
      EXTRA_CATEGORY
    );
    // The acceptance criteria arrive as one markdown checklist and become checklist rows
    await expect(modal.locator('input[value="The toggle is reachable from the header"]')).toBeVisible();
    await expect(modal.locator('input[value="The choice survives a reload"]')).toBeVisible();
    await expectToast(page, "Fields filled by AI — review and save");
  });

  await test.step("what it noticed about the rest of the board is shown", async () => {
    await expect(modal.getByText(`Possible duplicate of ${PROJECT_KEY}-2`)).toBeVisible();
    await expect(modal.getByText(GENERATED.duplicateReason)).toBeVisible();
    await expect(modal.getByText(GENERATED.dependencyReason)).toBeVisible();
    // The rows themselves. A bare `TP-1` would also match TP-10 and says nothing about which
    // direction the dependency was suggested in.
    await expect(modal.getByText(`Blocked by: ${PROJECT_KEY}-1`)).toBeVisible();
    await expect(modal.getByText(`Would block: ${PROJECT_KEY}-3`)).toBeVisible();
  });

  await test.step("the prompt was built from this project, not from a template", async () => {
    const sent = await lastPromptSent();
    expect(sent.user).toContain("add a dark mode toggle");
    expect(sent.system).toContain(PROJECT_NAME);
    expect(sent.system).toContain(EXTRA_CATEGORY);
    // The project's own choice fields, by name and by the values they actually accept
    expect(sent.system).toContain("Difficulty");
    expect(sent.system).toContain("Platforms");
    expect(sent.system).toContain('"L"');
    expect(sent.system).toContain('"Web"');
    // An archived field is not offered — it is no longer policed, so asking about it invites a
    // value the save would refuse
    expect(sent.system).not.toContain("Retired");
    // The open board, which is what duplicate and dependency detection is judged against
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
    // "L" → aa-large, "Web" → aa-web. The ids are deliberately nothing like the text.
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

  // user-story is also the form's own default, so a fallback asserted from an untouched form is
  // true before the generation runs. Moved off it first.
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
  // The 500 also arrives when OPENAI_BASE_URL is wrong and the key goes to the real api.openai.com;
  // this is what says the failure came from the answer rather than from the wiring
  expect((await lastPromptSent()).user).toContain("this is not JSON");
  // Nothing half-written: a failed generation must not leave a title the person did not type
  await expect(modal.getByLabel("Title")).toHaveValue("");
});
