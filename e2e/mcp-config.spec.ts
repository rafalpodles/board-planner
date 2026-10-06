import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { GITHUB_STUB_URL, GITLAB_STUB_URL } from "../playwright.config";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import { McpSession, type ToolCall } from "./mcp";
import {
  API_TOKEN,
  E2E_MONGODB_URI,
  FIELDS,
  GITLAB_PROJECT_KEY,
  GITLAB_REPO,
  GITLAB_TASK_KEY,
  GITLAB_TASK_NUMBER,
  MEMBER_API_TOKEN,
  OWNER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_NUMBER,
  seed,
  seedCustomFields,
  seedGitlabProject,
  seedRepository,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-914, BP-917. The configuration an AI client may add to a board — a field, an option, a category,
 * a column, a column's label — and the repository sync, driven over the real transport and read back
 * through the app. A tool's own reply is the one thing a tool that wrote nothing can still get right,
 * so every write here ends on what the settings screens and the board show afterwards.
 *
 * The owner is a person with an owner grant and no standing on the instance (the seeded `owner`),
 * given a token of their own below: the instance admin's token passes every owner check through
 * `instanceAdmin` and would never reach the grant branch a project owner depends on.
 */

const OWNER_API_TOKEN = "cp_e2e00009deadbeefdeadbeefdeadbeef";
const SETTINGS = `/projects/${PROJECT_KEY}/settings`;
const NEXT_TASK_NUMBER = 5;

async function seedOwnerToken() {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    await mongoose.connection.db!.collection("apitokens").insertOne({
      _id: new mongoose.Types.ObjectId(),
      user: OWNER_ID,
      name: "e2e owner",
      tokenHash: bcrypt.hashSync(OWNER_API_TOKEN, 10),
      prefix: OWNER_API_TOKEN.slice(0, 11),
      allowedProjects: [],
      lastUsedAt: null,
      createdAt: new Date(),
    });
  } finally {
    await mongoose.disconnect();
  }
}

async function connected(request: APIRequestContext, token = API_TOKEN): Promise<McpSession> {
  const session = new McpSession(request, token);
  await session.open();
  return session;
}

function accepted(call: ToolCall) {
  expect(call.status, call.text).toBe(200);
  expect(call.raw.result, JSON.stringify(call.raw)).toBeDefined();
  expect(call.raw.result?.isError ?? false, call.text).toBe(false);
}

function refused(call: ToolCall) {
  expect(call.status, call.text).toBe(200);
  expect(call.raw.result?.isError, call.text).toBe(true);
}

type StoredProject = {
  columns: { id: string; label: string; role: string; order: number; triggersPmReview: boolean }[];
  categories: { name: string; color: string }[];
  customFields: { _id: string; name: string; fieldType: string; options: { id: string; value: string; color: string; order: number }[] }[];
};

async function stored(request: APIRequestContext): Promise<StoredProject> {
  const res = await request.get(`/api/projects/${PROJECT_ID}`, { headers: ADMIN_AUTH });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const column = (page: Page, columnId: string): Locator => page.getByTestId(`column-${columnId}`);

async function openPicker(page: Page, name: string): Promise<Locator> {
  await page.getByRole("combobox", { name, exact: true }).click();
  return page.getByRole("listbox", { name, exact: true });
}

test.beforeEach(async () => {
  await seed();
  await seedOwnerToken();
});

test("an owner sets a board up over MCP, and the app shows it and works with it", async ({ page, request }) => {
  const owner = await connected(request, OWNER_API_TOKEN);

  const field = await owner.callTool("add_custom_field", {
    project: PROJECT_KEY,
    name: "Size",
    fieldType: "dropdown",
    options: ["S", { value: "M", color: "#112233" }],
    showOnCard: true,
  });
  accepted(field);
  expect(field.parsed.field).toMatchObject({ name: "Size", fieldType: "dropdown", showOnCard: true, archived: false });
  expect(field.parsed.field.options.map((o: { value: string }) => o.value)).toEqual(["S", "M"]);
  const sizeId: string = field.parsed.field.id;

  const option = await owner.callTool("add_field_option", { project: PROJECT_KEY, field: "size", option: "XL" });
  accepted(option);
  expect(option.parsed.options.map((o: { value: string }) => o.value)).toEqual(["S", "M", "XL"]);
  const xl: { id: string } = option.parsed.added;

  accepted(await owner.callTool("add_category", { project: PROJECT_KEY, name: "chore", color: "#00aa00" }));

  const added = await owner.callTool("add_column", { project: PROJECT_KEY, label: "QA", role: "review", color: "#00bbcc" });
  accepted(added);
  expect(added.parsed.added).toMatchObject({ id: "qa", label: "QA", role: "review", order: 7 });

  const renamed = await owner.callTool("rename_column", { project: PROJECT_KEY, column: "QA", label: "Quality check" });
  accepted(renamed);
  expect(renamed.parsed.renamed).toMatchObject({ id: "qa", label: "Quality check", role: "review" });

  await test.step("the server holds exactly that, and the board's other columns are as they were", async () => {
    const project = await stored(request);
    expect(project.columns.map((c) => `${c.id}:${c.label}`)).toEqual([
      "planned:Planned",
      "todo:To Do",
      "in_progress:In Progress",
      "in_review:In Review",
      "needs_human_review:Needs Human Review",
      "ready_to_test:Ready to Test",
      "done:Done",
      "qa:Quality check",
    ]);
    // Added columns never ask the PM agent for a review, and the one that does still does
    expect(project.columns.find((c) => c.id === "qa")!.triggersPmReview).toBe(false);
    expect(project.columns.find((c) => c.id === "needs_human_review")!.triggersPmReview).toBe(true);
    expect(project.categories.map((c) => c.name)).toEqual(["bug", "doc", "user-story", "idea", "chore"]);
  });

  await test.step("the settings screens list what was added", async () => {
    await signIn(page, "owner");

    await page.goto(`${SETTINGS}?section=board`);
    await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
    await expect(page.getByLabel("Column name")).toHaveCount(8);
    await expect(page.getByLabel("Column name").last()).toHaveValue("Quality check");

    await page.goto(`${SETTINGS}?section=fields`);
    await expect(page.getByRole("heading", { name: "Task fields", exact: true })).toBeVisible();
    await expect(page.locator('span:text-is("Size")')).toBeVisible();
    await expect(page.getByText("Choice · 3 options")).toBeVisible();
    const categoryNames = await page.getByLabel("Category name").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
    expect(categoryNames).toContain("chore");
  });

  await test.step("the new option can be chosen on a task, and the choice is the option's own id", async () => {
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    const panel = await openPicker(page, "Size");
    await panel.getByRole("option", { name: "XL", exact: true }).click();

    await expect
      .poll(async () => {
        const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`, { headers: ADMIN_AUTH });
        return (await res.json()).customFieldValues?.[sizeId];
      })
      .toBe(xl.id);
  });

  await test.step("the new category files a task, and the new column holds it on the board", async () => {
    const created = await owner.callTool("create_task", {
      project: PROJECT_KEY,
      title: "Filed in the new column",
      category: "chore",
      status: "qa",
      fields: { Size: "M" },
    });
    accepted(created);
    expect(created.parsed).toMatchObject({ taskNumber: NEXT_TASK_NUMBER, category: "chore", status: "qa" });

    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
    const qa = column(page, "qa");
    await expect(qa).toContainText("Quality check");
    await expect(qa.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${NEXT_TASK_NUMBER}"]`)).toBeVisible();

    const moved = await owner.callTool("change_task_status", { taskKey: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`, status: "qa" });
    accepted(moved);
    await page.reload();
    await expect(column(page, "qa").locator(`a[href="/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}"]`)).toBeVisible();
  });
});

test("adding an option leaves the ones a field has, and what the tasks chose among them", async ({ page, request }) => {
  await seedCustomFields({ [String(FIELDS.difficulty._id)]: "aa-large" });
  const admin = await connected(request);

  const added = await admin.callTool("add_field_option", { project: PROJECT_KEY, field: "Difficulty", option: "XL", color: "#ff0000" });
  accepted(added);

  const difficulty = (await stored(request)).customFields.find((f) => f.name === "Difficulty")!;
  expect(difficulty.options.map((o) => [o.id, o.value, o.color, o.order])).toEqual([
    ["zz-small", "S", "#4ade80", 0],
    ["aa-large", "L", "#f59e0b", 1],
    [added.parsed.added.id, "XL", "#ff0000", 2],
  ]);

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(page.getByRole("combobox", { name: "Difficulty", exact: true })).toContainText("L");
  const panel = await openPicker(page, "Difficulty");
  await expect(panel.getByRole("option")).toHaveText(["Empty", "S", "L", "XL"]);
});

test("adds made at the same moment all land, and a rename made with them is not undone", async ({ request }) => {
  await seedCustomFields();
  const sessions = await Promise.all(Array.from({ length: 9 }, () => connected(request)));
  const calls = [
    ...["Tiny", "Huge", "Giant"].map((option, i) =>
      sessions[i].callTool("add_field_option", { project: PROJECT_KEY, field: "Difficulty", option })
    ),
    ...["QA", "Ship", "Archive"].map((label, i) =>
      sessions[3 + i].callTool("add_column", { project: PROJECT_KEY, label, role: "review" })
    ),
    sessions[6].callTool("rename_column", { project: PROJECT_KEY, column: "todo", label: "Up next" }),
    ...["chore", "spike"].map((name, i) => sessions[7 + i].callTool("add_category", { project: PROJECT_KEY, name })),
  ];

  for (const call of await Promise.all(calls)) accepted(call);

  const project = await stored(request);
  expect(project.customFields.find((f) => f.name === "Difficulty")!.options.map((o) => o.value).sort()).toEqual(
    ["Giant", "Huge", "L", "S", "Tiny"].sort()
  );
  expect(project.columns.map((c) => c.id).sort()).toEqual(
    ["planned", "todo", "in_progress", "in_review", "needs_human_review", "ready_to_test", "done", "qa", "ship", "archive"].sort()
  );
  expect(project.columns.find((c) => c.id === "todo")!.label).toBe("Up next");
  expect(project.categories.map((c) => c.name).sort()).toEqual(["bug", "chore", "doc", "idea", "spike", "user-story"]);
});

test("the ceiling on columns holds when adds race for the last places", async ({ request }) => {
  const sessions = await Promise.all(Array.from({ length: 8 }, () => connected(request)));

  const calls = await Promise.all(
    sessions.map((session, i) => session.callTool("add_column", { project: PROJECT_KEY, label: `Extra ${i}`, role: "blocked" }))
  );

  const landed = calls.filter((call) => !call.raw.result?.isError);
  expect(landed).toHaveLength(5);
  for (const call of calls.filter((c) => c.raw.result?.isError)) expect(call.text).toContain("at most 12 columns");
  expect((await stored(request)).columns).toHaveLength(12);

  const control = await sessions[0].callTool("rename_column", { project: PROJECT_KEY, column: "todo", label: "Still works when full" });
  accepted(control);
});

test("the same option added at once by several callers is one option", async ({ request }) => {
  await seedCustomFields();
  const spellings = ["XL", "xl", "Xl", "xL", " XL "];
  const sessions = await Promise.all(spellings.map(() => connected(request)));

  const calls = await Promise.all(
    sessions.map((session, i) => session.callTool("add_field_option", { project: PROJECT_KEY, field: "Difficulty", option: spellings[i] }))
  );

  expect(calls.filter((call) => !call.raw.result?.isError)).toHaveLength(1);
  for (const call of calls.filter((c) => c.raw.result?.isError)) expect(call.text).toMatch(/already an option/);
  const options = (await stored(request)).customFields.find((f) => f.name === "Difficulty")!.options;
  expect(options.filter((o) => o.value.toLowerCase() === "xl")).toHaveLength(1);
});

test("a member is refused what only an owner may do, and writes what the app lets a member write", async ({ request }) => {
  const before = await stored(request);
  const member = await connected(request, MEMBER_API_TOKEN);

  const column = await member.callTool("add_column", { project: PROJECT_KEY, label: "Sneaky", role: "done" });
  refused(column);
  expect(column.text).toContain("Only a project owner can add a column on TP, as in the app. Nothing was changed.");
  const rename = await member.callTool("rename_column", { project: PROJECT_KEY, column: "done", label: "Sneaky" });
  refused(rename);
  expect(rename.text).toContain("Only a project owner can rename a column");

  await test.step("the server refuses it too, whatever the tool says", async () => {
    const post = await request.post(`/api/projects/${PROJECT_ID}/columns`, {
      headers: MEMBER_AUTH,
      data: { label: "Sneaky", role: "done" },
    });
    expect(post.status()).toBe(403);
    const patch = await request.patch(`/api/projects/${PROJECT_ID}/columns/done`, {
      headers: MEMBER_AUTH,
      data: { label: "Sneaky" },
    });
    expect(patch.status()).toBe(403);
    expect((await stored(request)).columns).toEqual(before.columns);
  });

  await test.step("the control: the same member may add a category, a field and an option, as in the app", async () => {
    accepted(await member.callTool("add_category", { project: PROJECT_KEY, name: "chore" }));
    const field = await member.callTool("add_custom_field", { project: PROJECT_KEY, name: "Size", fieldType: "dropdown", options: ["S"] });
    accepted(field);
    accepted(await member.callTool("add_field_option", { project: PROJECT_KEY, field: "Size", option: "M" }));
    const project = await stored(request);
    expect(project.categories.map((c) => c.name)).toContain("chore");
    expect(project.customFields.find((f) => f.name === "Size")!.options.map((o) => o.value)).toEqual(["S", "M"]);
  });
});

test("what the tools cannot do is refused by name, and nothing is written", async ({ request }) => {
  await seedCustomFields();
  const before = await stored(request);
  const admin = await connected(request);

  const checks: [string, Record<string, unknown>, RegExp][] = [
    ["add_column", { project: PROJECT_KEY, label: "QA", role: "testing" }, /role|Invalid/i],
    ["add_column", { project: PROJECT_KEY, label: "QA", role: "review", triggersPmReview: true }, /triggersPmReview.*Nothing was written/],
    ["rename_column", { project: PROJECT_KEY, column: "todo", label: "X", role: "done" }, /Not a parameter of this tool.*role.*Nothing was written/],
    ["rename_column", { project: PROJECT_KEY, column: "nope", label: "X" }, /No column "nope"/],
    ["add_custom_field", { project: PROJECT_KEY, name: "Size", fieldType: "dropdown" }, /at least one option/],
    ["add_custom_field", { project: PROJECT_KEY, name: "Size", fieldType: "text", options: ["A"] }, /has no options/],
    ["add_custom_field", { project: PROJECT_KEY, name: "Size", fieldType: "text", archived: true }, /archived.*Nothing was written/],
    ["add_custom_field", { project: PROJECT_KEY, name: "difficulty", fieldType: "text" }, /already exists/],
    ["add_field_option", { project: PROJECT_KEY, field: "Notes", option: "x" }, /no options/],
    ["add_field_option", { project: PROJECT_KEY, field: "Difficulty", option: "l" }, /already an option/],
    ["add_category", { project: PROJECT_KEY, name: "BUG" }, /already exists/],
    ["add_category", { project: PROJECT_KEY, name: "x", color: "red" }, /colour|#rrggbb/i],
  ];
  for (const [tool, args, said] of checks) {
    const call = await admin.callTool(tool, args);
    refused(call);
    expect(call.text, `${tool} ${JSON.stringify(args)}`).toMatch(said);
  }

  const after = await stored(request);
  expect(after.columns).toEqual(before.columns);
  expect(after.categories).toEqual(before.categories);
  expect(after.customFields).toEqual(before.customFields);
});

test.describe("sync_repository", () => {
  const REPO = "https://github.com/example/board";
  const SEEDED_TOKEN = "e2e-token-passed-through";
  const HEAD = "c0ffee1";
  const pull = {
    number: 41,
    title: "Keep the header visible",
    state: "open",
    html_url: `${REPO}/pull/41`,
    merged_at: null,
    head: { ref: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}/keep-the-header`, sha: HEAD },
    updated_at: "2026-09-01T00:00:00Z",
  };

  test("refreshes the pull requests and their CI badge, and says what it did", async ({ page, request }) => {
    await seedRepository({ repositoryUrl: REPO, githubToken: SEEDED_TOKEN });
    const stub = await request.post(`${GITHUB_STUB_URL}/control`, {
      data: { pulls: [pull], checks: { [HEAD]: { check_runs: [{ name: "e2e", status: "completed", conclusion: "success" }] } } },
    });
    expect(stub.status()).toBe(200);
    const admin = await connected(request);

    const synced = await admin.callTool("sync_repository", { project: PROJECT_KEY });

    accepted(synced);
    expect(synced.parsed).toMatchObject({ provider: "github", synced: true, matched: 1, linksRefreshed: 1, tasksLinked: 1 });
    expect(synced.parsed.summary).toBe("Refreshed 1 pull request on 1 task.");
    expect(synced.text).not.toContain(SEEDED_TOKEN);

    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(page.getByTestId("pr-state")).toHaveAttribute("data-look", "success");
    const bearers = (await (await request.get(`${GITHUB_STUB_URL}/bearers`)).json()) as (string | null)[];
    expect(bearers.length).toBeGreaterThan(0);
  });

  test("says why when no pull request names a task", async ({ request }) => {
    await seedRepository({ repositoryUrl: REPO, githubToken: SEEDED_TOKEN });
    await request.post(`${GITHUB_STUB_URL}/control`, { data: { pulls: [], checks: {} } });
    const admin = await connected(request);

    const synced = await admin.callTool("sync_repository", { project: PROJECT_KEY });

    accepted(synced);
    expect(synced.parsed.summary).toMatch(/No pull request names a task of this board/);
  });

  test("refuses a board with no repository, and one with a repository but no token, without asking GitHub", async ({ request }) => {
    await request.post(`${GITHUB_STUB_URL}/control`, { data: { pulls: [pull], checks: {} } });
    const admin = await connected(request);

    const none = await admin.callTool("sync_repository", { project: PROJECT_KEY });
    refused(none);
    expect(none.text).toMatch(/TP has no repository.*Nothing was synced/);

    await seedRepository({ repositoryUrl: REPO });
    const noToken = await admin.callTool("sync_repository", { project: PROJECT_KEY });
    refused(noToken);
    expect(noToken.text).toMatch(/no GitHub token stored/);

    expect(await (await request.get(`${GITHUB_STUB_URL}/asked`)).json()).toEqual([]);
  });

  test("runs GitLab's sync for a board that is on GitLab", async ({ request }) => {
    await seedGitlabProject(GITLAB_STUB_URL);
    const mergeRequest = {
      iid: 12,
      title: "Mirror the fix",
      state: "opened",
      web_url: `${GITLAB_STUB_URL}/${GITLAB_REPO}/-/merge_requests/12`,
      merged_at: null,
      source_branch: `${GITLAB_TASK_KEY}/mirror-the-fix`,
      updated_at: "2026-08-01T10:00:00Z",
    };
    const stub = await request.post(`${GITLAB_STUB_URL}/control`, { data: { mergeRequests: [mergeRequest] } });
    expect(stub.status()).toBe(200);
    const admin = await connected(request);

    const synced = await admin.callTool("sync_repository", { project: GITLAB_PROJECT_KEY });

    accepted(synced);
    expect(synced.parsed).toMatchObject({ provider: "gitlab", matched: 1, linksRefreshed: 1, tasksLinked: 1 });
    expect(synced.parsed.summary).toBe("Refreshed 1 merge request on 1 task.");
    const task = await request.get(`/api/projects/${GITLAB_PROJECT_KEY}/tasks/${GITLAB_TASK_NUMBER}`, { headers: ADMIN_AUTH });
    expect((await task.json()).linkedPRs.map((l: { number: number }) => l.number)).toEqual([12]);
  });
});
