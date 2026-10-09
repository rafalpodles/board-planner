import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import {
  ADMIN_USERNAME,
  HELD_TASK_ID,
  HELD_TASK_TITLE,
  LIST_DROPDOWN_FIELD_ID,
  MEMBER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_TITLE,
  seed,
  seedListVisibleDropdownField,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-886. A view is the board's filters, sort, grouping, layout and sprint scope, kept on the
 * project for one person or for everybody, and opened from the menu or from a `?view=` link.
 */
test.beforeEach(seed);

const BOARD = `/projects/${PROJECT_KEY}`;
const VIEWS = `/api/projects/${PROJECT_KEY}/views`;
const rows = (page: Page) => page.locator("table tbody tr:not([data-testid='list-group-header'])");
const menu = (page: Page) => page.getByRole("dialog", { name: "Views" });
const entries = (page: Page) => menu(page).getByTestId("saved-view");
const entry = (page: Page, name: string) => entries(page).filter({ hasText: name });

type Auth = typeof ADMIN_AUTH;

async function createView(request: APIRequestContext, data: Record<string, unknown>, auth: Auth = ADMIN_AUTH) {
  const res = await request.post(VIEWS, { headers: auth, data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { _id: string; name: string };
}

async function storedViews(request: APIRequestContext, auth: Auth = ADMIN_AUTH) {
  const res = await request.get(VIEWS, { headers: auth });
  expect(res.status()).toBe(200);
  return (await res.json()) as { _id: string; name: string; shared: boolean; mine: boolean; canEdit: boolean; viewMode: string; filters: Record<string, unknown>; sortField: string; groupBy: string }[];
}

async function putTask(request: APIRequestContext, id: unknown, data: Record<string, unknown>) {
  const res = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${id}`, { headers: ADMIN_AUTH, data });
  expect(res.status(), await res.text()).toBe(200);
}

async function openList(page: Page, who: "admin" | "member" | "owner" = "member") {
  await signIn(page, who);
  await page.goto(BOARD);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
}

async function openMenu(page: Page) {
  if (!(await menu(page).isVisible())) await page.getByRole("button", { name: "Views", exact: true }).click();
  await expect(menu(page)).toBeVisible();
}

async function signInAgainAs(page: Page, who: "admin" | "member") {
  await page.context().clearCookies();
  await signIn(page, who);
}

test("a person saves what is on screen, and gets all of it back from the menu", async ({ page, request }) => {
  await putTask(request, HELD_TASK_ID, { priority: "urgent" });
  await putTask(request, SIBLING_TASK_ID, { priority: "urgent" });
  await openList(page);
  await expect(rows(page)).toHaveCount(4);

  await test.step("set up a filter, a sort and a grouping", async () => {
    await page.getByRole("button", { name: /^Filters/ }).click();
    await page.getByRole("dialog", { name: "Filters" }).getByLabel("Priority").selectOption({ label: "Urgent" });
    await page.getByRole("button", { name: /^Filters/ }).click();
    await page.getByRole("button", { name: "Sort by Title", exact: true }).click();
    await page.getByLabel("Group tasks by").selectOption({ label: "Group: Status" });
    await expect(rows(page)).toHaveCount(2);
  });

  await test.step("save it under a name", async () => {
    await openMenu(page);
    await menu(page).getByLabel("View name").fill("Urgent by title");
    const saved = page.waitForResponse((r) => r.url().endsWith("/views") && r.request().method() === "POST");
    await menu(page).getByRole("button", { name: "Save view" }).click();
    expect((await saved).status()).toBe(201);
    await expect(entry(page, "Urgent by title")).toBeVisible();
  });

  await test.step("it is on the server, personal, and carries the whole layout", async () => {
    const [view] = await storedViews(request, MEMBER_AUTH);
    expect(view).toMatchObject({ name: "Urgent by title", shared: false, mine: true, viewMode: "list", sortField: "title", groupBy: "status" });
    expect(view.filters).toMatchObject({ priority: "urgent" });
    expect(await storedViews(request), "another person does not see it").toEqual([]);
  });

  await test.step("with this browser's own memory wiped, the menu still brings it back", async () => {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator("table, [data-testid^='column-']").first()).toBeVisible();
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(rows(page), "the control: nothing is filtered now").toHaveCount(4);
    await expect(page.getByLabel("Group tasks by")).toHaveValue("");

    await openMenu(page);
    await entry(page, "Urgent by title").getByRole("button", { name: "Urgent by title" }).click();

    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByLabel("Group tasks by")).toHaveValue("status");
    await expect(page.getByRole("columnheader", { name: "Sort by Title" })).toHaveAttribute("aria-sort", "ascending");
    await expect(page.getByRole("button", { name: /^Filters/ })).toContainText("1");
  });
});

test("a shared view is the whole board's, opens from its link, and the link cleans itself", async ({ page, request }) => {
  await putTask(request, HELD_TASK_ID, { priority: "urgent" });
  const shared = await createView(request, { name: "Urgent only", shared: true, viewMode: "list", filters: { priority: "urgent" } });
  const private_ = await createView(request, { name: "Admin private", filters: { priority: "low" } });

  await test.step("a member arrives by the link and finds the view applied", async () => {
    await signIn(page, "member");
    await page.goto(`${BOARD}?view=${shared._id}`);
    await expect(page.locator("table")).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Filters/ })).toContainText("1");
    expect(new URL(page.url()).searchParams.has("view")).toBe(false);
  });

  await test.step("the menu offers the shared view and not somebody's personal one, with nothing to delete or share", async () => {
    await openMenu(page);
    await expect(entry(page, "Urgent only")).toContainText("Shared");
    await expect(entries(page).filter({ hasText: "Admin private" })).toHaveCount(0);
    await expect(entry(page, "Urgent only").getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(menu(page).getByLabel("Share with everyone on this board")).toHaveCount(0);
  });

  await test.step("a link to a view that is not there, or is somebody's personal one, is cleaned and costs nothing", async () => {
    await page.evaluate(() => localStorage.clear());
    for (const id of ["507f1f77bcf86cd799439099", private_._id, "not-an-id"]) {
      await page.goto(`${BOARD}?view=${id}`);
      await expect(page.getByRole("button", { name: "Views", exact: true })).toBeVisible();
      await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();
      expect(new URL(page.url()).searchParams.has("view")).toBe(false);
      await expect(page.getByRole("button", { name: /^Filters/ })).not.toContainText("1");
    }
  });
});

test("a project owner shares a view, copies its link, and can take it back", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const mine = await createView(request, { name: "Mine for now", filters: { priority: "high" } });
  await openList(page, "admin");

  await openMenu(page);
  await expect(entry(page, "Mine for now").getByRole("button", { name: "Copy link" }), "a personal view has no link to give").toHaveCount(0);
  await entry(page, "Mine for now").getByRole("button", { name: "Share" }).click();
  await expect(entry(page, "Mine for now")).toContainText("Shared");
  expect((await storedViews(request, MEMBER_AUTH)).map((v) => v.name)).toEqual(["Mine for now"]);

  await entry(page, "Mine for now").getByRole("button", { name: "Copy link" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${new URL(page.url()).origin}${BOARD}?view=${mine._id}`);

  await entry(page, "Mine for now").getByRole("button", { name: "Stop sharing" }).click();
  await expect(entry(page, "Mine for now")).not.toContainText("Shared");
  expect(await storedViews(request, MEMBER_AUTH)).toEqual([]);
});

test("Assigned to me is one view that shows each person their own tasks", async ({ page, request }) => {
  await putTask(request, HELD_TASK_ID, { assignee: ADMIN_USERNAME });
  await putTask(request, SIBLING_TASK_ID, { assignee: MEMBER_USERNAME });
  const view = await createView(request, { name: "Assigned to me", shared: true, viewMode: "list", filters: { assignee: "@me" } });

  await signIn(page, "member");
  await page.goto(`${BOARD}?view=${view._id}`);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(SIBLING_TASK_TITLE);

  await signInAgainAs(page, "admin");
  await page.goto(`${BOARD}?view=${view._id}`);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(HELD_TASK_TITLE);
});

test("a view that names an archived field and somebody who has left still applies, without them", async ({ page, request }) => {
  await seedListVisibleDropdownField();
  const field = String(LIST_DROPDOWN_FIELD_ID);
  const filterable = await request.patch(`/api/projects/${PROJECT_KEY}/custom-fields/${field}`, { headers: ADMIN_AUTH, data: { filterable: true } });
  expect(filterable.status(), await filterable.text()).toBe(200);
  const view = await createView(request, {
    name: "Old",
    shared: true,
    viewMode: "list",
    filters: { assignee: "someone-who-left", fields: { [field]: { value: "zz-api" } } },
  });
  expect((await storedViews(request)).find((v) => v._id === view._id)?.filters).toMatchObject({ assignee: "someone-who-left" });
  const archived = await request.patch(`/api/projects/${PROJECT_KEY}/custom-fields/${field}`, { headers: ADMIN_AUTH, data: { archived: true } });
  expect(archived.status(), await archived.text()).toBe(200);

  await signIn(page, "member");
  await page.goto(`${BOARD}?view=${view._id}`);

  await expect(page.locator("table")).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByRole("button", { name: /^Filters/ })).not.toContainText("1");
  await expect(page.getByText("No tasks match the filters")).toHaveCount(0);
});

test("a person renames, updates and deletes their own view from the menu", async ({ page, request }) => {
  await createView(request, { name: "Scratch" }, MEMBER_AUTH);
  await openList(page);
  await openMenu(page);

  await entry(page, "Scratch").getByRole("button", { name: "Rename" }).click();
  await menu(page).getByLabel("New name for Scratch").fill("Kept");
  await menu(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(entry(page, "Kept")).toBeVisible();
  expect((await storedViews(request, MEMBER_AUTH)).map((v) => v.name)).toEqual(["Kept"]);

  await page.getByRole("button", { name: "Sort by Title", exact: true }).click();
  await openMenu(page);
  await entry(page, "Kept").getByRole("button", { name: "Update to current" }).click();
  await expect.poll(async () => (await storedViews(request, MEMBER_AUTH))[0]?.sortField).toBe("title");

  await entry(page, "Kept").getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete view" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(entries(page)).toHaveCount(0);
  expect(await storedViews(request, MEMBER_AUTH)).toEqual([]);
});

test("a name is refused the second time and the refusal is shown", async ({ page, request }) => {
  await createView(request, { name: "Taken" }, MEMBER_AUTH);
  await openList(page);
  await openMenu(page);

  await menu(page).getByLabel("View name").fill("taken");
  await menu(page).getByRole("button", { name: "Save view" }).click();

  await expect(menu(page).getByRole("alert")).toContainText("already exists");
  expect(await storedViews(request, MEMBER_AUTH)).toHaveLength(1);
});

test("the ceilings hold when many are saved at once", async ({ request }) => {
  const burst = await Promise.all(
    Array.from({ length: 35 }, (_, i) => request.post(VIEWS, { headers: ADMIN_AUTH, data: { name: `Burst ${i}` } }))
  );
  const statuses = burst.map((r) => r.status());
  expect(statuses.filter((s) => s === 201)).toHaveLength(25);
  expect(statuses.filter((s) => s === 400)).toHaveLength(10);
  expect(await storedViews(request)).toHaveLength(25);

  const same = await Promise.all(
    Array.from({ length: 6 }, () => request.post(VIEWS, { headers: MEMBER_AUTH, data: { name: "Same name" } }))
  );
  expect(same.map((r) => r.status()).filter((s) => s === 201)).toHaveLength(1);
  expect(same.map((r) => r.status()).filter((s) => s === 409)).toHaveLength(5);
});

test("a member cannot share, and cannot reach another person's view by id", async ({ request }) => {
  const theirs = await createView(request, { name: "Theirs" });

  const share = await request.post(VIEWS, { headers: MEMBER_AUTH, data: { name: "For all", shared: true } });
  expect(share.status()).toBe(403);
  const edit = await request.put(VIEWS, { headers: MEMBER_AUTH, data: { viewId: theirs._id, name: "Mine now" } });
  expect(edit.status()).toBe(404);
  const remove = await request.delete(VIEWS, { headers: MEMBER_AUTH, data: { viewId: theirs._id } });
  expect(remove.status()).toBe(404);
  expect((await storedViews(request)).map((v) => v.name)).toEqual(["Theirs"]);
});

test("the project the views are on does not hand them out with itself", async ({ request }) => {
  await createView(request, { name: "Private note", filters: { priority: "low" } });

  const project = await request.get(`/api/projects/${PROJECT_KEY}`, { headers: MEMBER_AUTH });
  expect(project.status()).toBe(200);
  expect(JSON.stringify(await project.json())).not.toContain("Private note");
  const all = await request.get("/api/projects", { headers: MEMBER_AUTH });
  expect(JSON.stringify(await all.json())).not.toContain("Private note");
});

