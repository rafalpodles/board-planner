import { test, expect, type APIRequestContext } from "@playwright/test";
import { WEBHOOK_RECEIVER_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import {
  FINISHED_TASK_ID,
  FINISHED_TASK_KEY,
  PROJECT_KEY,
  SIBLING_TASK_KEY,
  SIBLING_TASK_TITLE,
  seed,
  seedWebhook,
} from "./seed";

/**
 * BP-1018, BP-1019, BP-1020, BP-1021: the answers an integration reads. A body that is not JSON, a
 * sprint the schema would refuse and a child's parent were each answered by the server's own
 * failure or silence, and a status or comment delivery named neither its board nor its task.
 */

const API = `/api/projects/${PROJECT_KEY}`;

test.beforeEach(async () => {
  await seed();
  await fetch(`${WEBHOOK_RECEIVER_URL}/reset`, { method: "POST" });
});

async function send(request: APIRequestContext, method: string, path: string, body: unknown) {
  const raw = typeof body === "string";
  return request.fetch(path, {
    method,
    headers: raw ? { ...ADMIN_AUTH, "Content-Type": "text/plain" } : ADMIN_AUTH,
    data: body,
  });
}

test("a body that is not JSON is the caller's mistake on every write route, not a server failure", async ({ request }) => {
  const routes: { method: string; path: string; valid: unknown; status: number }[] = [
    { method: "POST", path: `${API}/tasks`, valid: { title: "Control task" }, status: 201 },
    { method: "PATCH", path: `${API}/tasks/${SIBLING_TASK_KEY}/status`, valid: { status: "todo" }, status: 200 },
    { method: "POST", path: `${API}/tasks/${SIBLING_TASK_KEY}/comments`, valid: { body: "Control comment" }, status: 201 },
    { method: "POST", path: `${API}/sprints`, valid: { name: "Control", startDate: "2026-10-12", endDate: "2026-10-25" }, status: 201 },
    { method: "POST", path: `${API}/webhooks`, valid: { url: `${WEBHOOK_RECEIVER_URL}/control`, events: ["task_created"] }, status: 201 },
    { method: "POST", path: `${API}/categories`, valid: { name: "control", color: "#336699" }, status: 201 },
  ];

  for (const { method, path, valid, status } of routes) {
    const refused = await send(request, method, path, "not json");
    expect(refused.status(), `${method} ${path}`).toBe(400);
    expect(await refused.json(), `${method} ${path}`).toEqual({ error: "Invalid JSON body" });

    const accepted = await send(request, method, path, valid);
    expect(accepted.status(), `${method} ${path} with a valid body: ${await accepted.text()}`).toBe(status);
  }
});

test("a body that is not an object reaches the route's own refusal instead of a TypeError", async ({ request }) => {
  const refused = await send(request, "POST", `${API}/tasks/${SIBLING_TASK_KEY}/comments`, "null");

  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toMatch(/body/i);
});

test("a sprint is refused the same way on create and on update", async ({ request }) => {
  const created = await send(request, "POST", `${API}/sprints`, {
    name: "Existing",
    startDate: "2026-10-12",
    endDate: "2026-10-25",
  });
  expect(created.status()).toBe(201);
  const sprintId = (await created.json())._id;

  const refusals: [string, Record<string, unknown>, string][] = [
    ["an unknown status", { status: "nope" }, "Invalid sprint status"],
    ["a blank name", { name: "   " }, "A sprint needs a name"],
    ["an unreadable start date", { startDate: "yesterday" }, "Invalid startDate"],
    ["an unreadable end date", { endDate: "soon" }, "Invalid endDate"],
    ["an end before the start", { startDate: "2026-10-25", endDate: "2026-10-12" }, "endDate must not be before startDate"],
  ];
  const whole = { name: "Another", startDate: "2026-11-01", endDate: "2026-11-14" };

  for (const [what, change, error] of refusals) {
    const onCreate = await send(request, "POST", `${API}/sprints`, { ...whole, ...change });
    expect(onCreate.status(), `create with ${what}`).toBe(400);
    expect((await onCreate.json()).error, `create with ${what}`).toBe(error);

    const onUpdate = await send(request, "PUT", `${API}/sprints/${sprintId}`, change);
    expect(onUpdate.status(), `update with ${what}`).toBe(400);
    expect((await onUpdate.json()).error, `update with ${what}`).toBe(error);
  }

  const lone = await send(request, "PUT", `${API}/sprints/${sprintId}`, { endDate: "2026-10-01" });
  expect(lone.status(), "a lone end date is held against the stored start").toBe(400);

  const unchanged = await (await request.get(`${API}/sprints`, { headers: ADMIN_AUTH })).json();
  expect(unchanged.find((s: { _id: string }) => s._id === sprintId)).toMatchObject({
    name: "Existing",
    status: "planned",
    endDate: expect.stringContaining("2026-10-25"),
  });
  expect(unchanged.filter((s: { name: string }) => s.name === "Another")).toHaveLength(0);

  const renamed = await send(request, "PUT", `${API}/sprints/${sprintId}`, { name: "Renamed", endDate: "2026-10-30" });
  expect(renamed.status(), await renamed.text()).toBe(200);
});

test("a task fetched on its own names its parent, as the list does", async ({ request }) => {
  const linked = await send(request, "POST", `${API}/tasks/${SIBLING_TASK_KEY}/links`, {
    taskId: FINISHED_TASK_ID.toString(),
    type: "parent_of",
  });
  expect(linked.status(), await linked.text()).toBe(200);

  const child = await (await request.get(`${API}/tasks/${FINISHED_TASK_KEY}`, { headers: ADMIN_AUTH })).json();
  expect(child.parent).toMatchObject({ taskNumber: 3, title: SIBLING_TASK_TITLE });

  const listed = await (await request.get(`${API}/tasks?taskNumber=4`, { headers: ADMIN_AUTH })).json();
  expect(listed[0].parent).toEqual(child.parent);

  const parent = await (await request.get(`${API}/tasks/${SIBLING_TASK_KEY}`, { headers: ADMIN_AUTH })).json();
  expect(parent.parent).toBeNull();
});

test("a status change and a comment are delivered naming their board and their task", async ({ request }) => {
  const path = "/rest-contract";
  await seedWebhook(`${WEBHOOK_RECEIVER_URL}${path}`);

  const moved = await send(request, "PATCH", `${API}/tasks/${SIBLING_TASK_KEY}/status`, { status: "in_review" });
  expect(moved.status(), await moved.text()).toBe(200);
  const commented = await send(request, "POST", `${API}/tasks/${SIBLING_TASK_KEY}/comments`, { body: "hello hooks" });
  expect(commented.status()).toBe(201);

  const received: Record<string, { project: { key: string; name: string }; task: { taskKey: string } }> = {};
  await expect(async () => {
    const all: { url: string; body: string }[] = await (await fetch(`${WEBHOOK_RECEIVER_URL}/deliveries`)).json();
    for (const delivery of all.filter((d) => d.url === path)) {
      const event = JSON.parse(delivery.body);
      received[event.event] = event;
    }
    expect(Object.keys(received).sort()).toEqual(["comment_added", "status_changed"]);
  }).toPass({ timeout: 30_000 });

  for (const event of ["status_changed", "comment_added"]) {
    expect(received[event].project.key, event).toBe(PROJECT_KEY);
    expect(received[event].project.name, event).not.toBe("");
    expect(received[event].task.taskKey, event).toBe(SIBLING_TASK_KEY);
  }
});
