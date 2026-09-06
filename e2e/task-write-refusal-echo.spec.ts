import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { PROJECT_KEY, SIBLING_TASK_ID, seed } from "./seed";

/**
 * BP-515. Sibling of BP-511's `assignee` fix (see `assignee-writers.spec.ts`): `createTask` and
 * `updateTask` both interpolated `category`/`status` into their refusal with no bound, and both
 * reach a model as a tool result — anything holding a token, and the PM agent, which forwards
 * both fields from a model straight into these writers. The GET route's four refusals already
 * slice to 64; these two, in both writers, did not.
 *
 * Driven over HTTP rather than through the browser: the form only ever sends a category/status
 * the project actually has, so what reaches this refusal is MCP and anything else holding a
 * token — the same reachability `assignee-writers.spec.ts` documents for the sibling field.
 */

test.beforeEach(seed);

const tasksUrl = `/api/projects/${PROJECT_KEY}/tasks`;
const taskUrl = `/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`;

const post = (request: APIRequestContext, data: Record<string, unknown>) =>
  request.post(tasksUrl, { headers: ADMIN_AUTH, data: { title: "Never created", ...data } });

const put = (request: APIRequestContext, data: Record<string, unknown>) =>
  request.put(taskUrl, { headers: ADMIN_AUTH, data });

test("a create does not echo an unbounded category or status back into the refusal", async ({
  request,
}) => {
  const category = await post(request, { category: "x".repeat(5000) });
  expect(category.status(), await category.text()).toBe(400);
  expect((await category.json()).error.length).toBeLessThan(500);

  const status = await post(request, { status: "x".repeat(5000) });
  expect(status.status(), await status.text()).toBe(400);
  expect((await status.json()).error.length).toBeLessThan(500);

  // The control: an ordinary refusal still names the value it refused, so the bound has not
  // swallowed the information an honest caller needs to fix their request.
  const ordinary = await post(request, { category: "not-a-real-category" });
  expect(ordinary.status(), await ordinary.text()).toBe(400);
  expect((await ordinary.json()).error).toContain("not-a-real-category");
});

test("an update does not echo an unbounded category or status back into the refusal", async ({
  request,
}) => {
  const category = await put(request, { category: "x".repeat(5000) });
  expect(category.status(), await category.text()).toBe(400);
  expect((await category.json()).error.length).toBeLessThan(500);

  const status = await put(request, { status: "x".repeat(5000) });
  expect(status.status(), await status.text()).toBe(400);
  expect((await status.json()).error.length).toBeLessThan(500);

  // The control, same as above but through the update path.
  const ordinary = await put(request, { status: "not-a-real-status" });
  expect(ordinary.status(), await ordinary.text()).toBe(400);
  expect((await ordinary.json()).error).toContain("not-a-real-status");
});
