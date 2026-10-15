import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { WEBHOOK_RECEIVER_URL } from "../playwright.config";
import { ADMIN_AUTH, SAME_ORIGIN } from "./api";
import { E2E_MONGODB_URI, MEMBER_USERNAME, PROJECT_ID, PROJECT_KEY, seed, seedWebhook } from "./seed";
import { signIn } from "./session";

/**
 * BP-863: the import engine writes quietly — no notifications, no webhook deliveries, one audit row
 * — keeps the source's ids and times, updates on a second run instead of duplicating, and reports
 * everything it could not carry over, the same in a dry run that writes nothing.
 */

const IMPORT = `/api/projects/${PROJECT_ID}/import`;
const HOOK = "/import-hook";
const SOURCE = "e2e-tracker";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

const created = (i: number) => new Date(Date.UTC(2025, 0, 1, 0, i % 60, i % 60)).toISOString();
const finished = (i: number) => new Date(Date.UTC(2025, 5, 1, 12, i % 60)).toISOString();

function bundle(count: number) {
  return {
    source: SOURCE,
    tasks: Array.from({ length: count }, (_, i) => ({
      id: `SRC-${i + 1}`,
      title: `Imported task ${i + 1}`,
      description: `From the old tracker, number ${i + 1}`,
      status: i % 2 ? "Closed" : "Open",
      assignee: i % 10 === 0 ? "old-person" : MEMBER_USERNAME,
      createdAt: created(i),
      ...(i % 2 ? { completedAt: finished(i) } : {}),
      comments: i < 5 ? [{ id: `C-${i}`, author: "old-person", body: `Said in the old tracker ${i}` }] : [],
    })),
  };
}

const MAPPING = { statuses: { Open: "todo", Closed: "done" } };

async function deliveries(): Promise<{ url: string }[]> {
  const all: { url: string }[] = await (await fetch(`${WEBHOOK_RECEIVER_URL}/deliveries`)).json();
  return all.filter((d) => d.url === HOOK);
}

async function counts() {
  const handle = await db();
  return {
    tasks: await handle.collection("tasks").countDocuments({ project: PROJECT_ID, "externalRef.source": SOURCE }),
    notifications: await handle.collection("notifications").countDocuments({}),
    audits: await handle.collection("projectauditlogs").countDocuments({ project: PROJECT_ID, action: "tasks_imported" }),
    comments: await handle.collection("comments").countDocuments({ "externalRef.source": SOURCE }),
  };
}

async function importAs(page: Page, body: Record<string, unknown>) {
  const response = await page.request.post(IMPORT, { headers: SAME_ORIGIN, data: body });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

test.beforeEach(async () => {
  await seed();
  await seedWebhook(`${WEBHOOK_RECEIVER_URL}${HOOK}`, ["task_created", "status_changed", "comment_added"]);
  await fetch(`${WEBHOOK_RECEIVER_URL}/reset`, { method: "POST" });
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("2,000 tasks import with no notification, no webhook delivery and one audit row, and a second run updates them", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await signIn(page, "owner");
  const before = await counts();

  const dry = await importAs(page, { bundle: bundle(2000), mapping: MAPPING });
  expect(dry).toMatchObject({ dryRun: true, created: 2000, updated: 0, complete: true });
  expect(await counts()).toEqual(before);

  const report = await importAs(page, { bundle: bundle(2000), mapping: MAPPING, dryRun: false });
  expect(report).toMatchObject({ dryRun: false, created: 2000, updated: 0, complete: true, comments: { created: 5 } });
  expect(report.unmapped.users).toEqual(["old-person"]);
  // A dry run says what the real run will do, word for word
  expect({ ...dry, dryRun: false }).toEqual(report);

  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const after = await counts();
  expect(after).toEqual({ tasks: 2000, notifications: before.notifications, audits: 1, comments: 5 });
  expect(await deliveries()).toEqual([]);

  // Original times survive: creation on the task, completion on the move into the done column
  const handle = await db();
  const closed = await handle.collection("tasks").findOne({ project: PROJECT_ID, "externalRef.id": "SRC-2" });
  expect(closed).toMatchObject({
    status: "done",
    createdAt: new Date(created(1)),
    updatedAt: new Date(finished(1)),
    title: "Imported task 2",
  });
  const moves = await handle.collection("activitylogs").find({ task: closed!._id }).sort({ createdAt: 1 }).toArray();
  expect(moves.map((m) => [m.action, m.newValue, m.createdAt.toISOString(), m.source])).toEqual([
    ["created", "", created(1), "import"],
    ["status_changed", "done", finished(1), "import"],
  ]);
  const comment = await handle.collection("comments").findOne({ "externalRef.id": "C-0" });
  expect(comment!.body).toMatch(/^\*Originally by old-person\*/);
  // A comment stamped "now" on the way in would read as edited since it was written
  expect(comment!.updatedAt).toEqual(comment!.createdAt);

  // Again: the same tasks, updated, never doubled
  const again = await importAs(page, { bundle: bundle(2000), mapping: MAPPING, dryRun: false });
  expect(again).toMatchObject({ created: 0, updated: 2000, comments: { created: 0, updated: 5 } });
  expect(await counts()).toEqual({ ...after, audits: 2 });

  // The control: an ordinary task made afterwards still announces itself, and gets today's date
  const ordinary = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
    headers: ADMIN_AUTH,
    data: { title: "Made by hand after the import", assignee: MEMBER_USERNAME },
  });
  expect(ordinary.status()).toBe(201);
  const made = await ordinary.json();
  expect(Date.now() - new Date(made.createdAt).getTime()).toBeLessThan(60_000);
  await expect.poll(async () => (await deliveries()).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await counts()).notifications, { timeout: 30_000 }).toBeGreaterThan(before.notifications);
});

test("an owner checks a file in the browser, sees what will be left out, and imports it", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);

  const file = {
    bundle: {
      source: SOURCE,
      tasks: [
        { id: "A-1", title: "Carried over", status: "Open", priority: "Blocker", fields: { "No such field": "x" } },
        { id: "A-2", title: "   ", status: "Open" },
        { id: "A-3", title: "Lands where new tasks go", status: "Somewhere else", assignee: "nobody-here" },
      ],
    },
    mapping: MAPPING,
  };
  const card = page.locator("section").filter({ has: page.getByLabel("Import file (JSON)") });
  await page.getByLabel("Import file (JSON)").setInputFiles({
    name: "export.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(file)),
  });

  const checked = page.waitForResponse((r) => r.url().endsWith("/import") && r.request().method() === "POST");
  await card.getByRole("button", { name: "Check" }).click();
  expect((await checked).status()).toBe(200);
  const report = page.getByTestId("import-report");
  await expect(report).toContainText("Would create 2 and would update 0 of 3 tasks from e2e-tracker");
  await expect(report).toContainText("A-2: no title");
  await expect(report).toContainText("A-1 · priority “Blocker”: not low, medium, high or urgent");
  await expect(report).toContainText("A-1 · No such field “x”: no field of that name on this board");
  await expect(report).toContainText("Somewhere else");
  await expect(report).toContainText("nobody-here");
  expect((await counts()).tasks).toBe(0);

  const imported = page.waitForResponse((r) => r.url().endsWith("/import") && r.request().method() === "POST");
  await card.getByRole("button", { name: "Import", exact: true }).click();
  expect((await imported).status()).toBe(200);
  await expect(report).toContainText("Created 2 and updated 0 of 3 tasks");
  await expect(card.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
  expect((await counts()).tasks).toBe(2);

  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText("Carried over").first()).toBeVisible();
});

test("only an owner's own session may import", async ({ page, request }) => {
  const body = { bundle: bundle(1), dryRun: false };
  expect((await request.post(IMPORT, { headers: ADMIN_AUTH, data: body })).status()).toBe(403);
  await signIn(page, "member");
  expect((await page.request.post(IMPORT, { headers: SAME_ORIGIN, data: body })).status()).toBe(403);
  expect((await counts()).tasks).toBe(0);
});
