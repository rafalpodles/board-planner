import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { PROJECT_KEY, SIBLING_TASK_ID, seed } from "./seed";

test.beforeEach(seed);

const tasksUrl = `/api/projects/${PROJECT_KEY}/tasks`;
const taskUrl = `/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`;

const UNBOUNDED = "x".repeat(5000);
const NOT_SLICED = "x".repeat(65);

const FIELDS = ["category", "status", "priority", "dueDate"] as const;

const post = (request: APIRequestContext, data: Record<string, unknown>) =>
  request.post(tasksUrl, { headers: ADMIN_AUTH, data: { title: "Never created", ...data } });

const put = (request: APIRequestContext, data: Record<string, unknown>) =>
  request.put(taskUrl, { headers: ADMIN_AUTH, data });

for (const field of FIELDS) {
  test(`a create does not echo an unbounded ${field} back into the refusal`, async ({ request }) => {
    const refused = await post(request, { [field]: UNBOUNDED });
    expect(refused.status(), await refused.text()).toBe(400);
    expect((await refused.json()).error).not.toContain(NOT_SLICED);

    const ordinary = await post(request, { [field]: "not-a-real-value" });
    expect(ordinary.status(), await ordinary.text()).toBe(400);
    expect((await ordinary.json()).error).toContain("not-a-real-value");
  });

  test(`an update does not echo an unbounded ${field} back into the refusal`, async ({ request }) => {
    const refused = await put(request, { [field]: UNBOUNDED });
    expect(refused.status(), await refused.text()).toBe(400);
    expect((await refused.json()).error).not.toContain(NOT_SLICED);

    const ordinary = await put(request, { [field]: "not-a-real-value" });
    expect(ordinary.status(), await ordinary.text()).toBe(400);
    expect((await ordinary.json()).error).toContain("not-a-real-value");
  });
}
