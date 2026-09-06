import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { PROJECT_KEY, SIBLING_TASK_ID, seed } from "./seed";

/**
 * BP-515. Sibling of BP-511's `assignee` fix (see `assignee-writers.spec.ts`): `createTask` and
 * `updateTask` interpolated a caller-controlled value into their refusal with no bound, and that
 * refusal reaches a model as a tool result — anything holding a token, and the PM agent, which
 * forwards these fields from a model straight into these writers. The GET route's four refusals
 * already slice to 64; these did not.
 *
 * Widened past `category`/`status`, the pair the ticket named, to `priority` and `dueDate` too:
 * `schemaValuesOrRefusal`, called by both writers, echoed those two exactly the same way — same
 * root cause, caught by this change's own independent review.
 *
 * Driven over HTTP rather than through the browser: the form only ever sends a value the project
 * actually has (or one the schema already accepts), so what reaches this refusal is MCP and
 * anything else holding a token — the same reachability `assignee-writers.spec.ts` documents for
 * the sibling field.
 */

test.beforeEach(seed);

const tasksUrl = `/api/projects/${PROJECT_KEY}/tasks`;
const taskUrl = `/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`;

const UNBOUNDED = "x".repeat(5000);
// Proves the bound is 64, not merely "shorter than 5000" — a regression to a looser slice (or
// none at all past a smaller ceiling) would still pass a plain length check.
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

    // The control: an ordinary refusal still names the value it refused, so the bound has not
    // swallowed the information an honest caller needs to fix their request.
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
