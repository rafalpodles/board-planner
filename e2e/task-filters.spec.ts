import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_ID,
  ADMIN_USERNAME,
  PROJECT_KEY,
  RENAMED_COLUMN_ID,
  SIBLING_TASK_ID,
  seed,
  seedRenamedColumn,
} from "./seed";

/**
 * BP-502. `?assignee=rpo` was written straight into `filter.assignee`, which is an ObjectId on the
 * model, so Mongoose threw a CastError and the route answered **500** — every time, reproduced over
 * the hosted MCP endpoint. MCP is this parameter's only caller and its only documentation; the
 * browser never sends it, which is why it stood.
 *
 * Driven against the real route and a real database on purpose. The unit tests beside this one
 * mock Mongoose, so they can prove the filter's *shape* and nothing at all about the crash — the
 * cast is the defect, and only a real cast can show it is gone.
 */

test.beforeEach(seed);

const list = (request: APIRequestContext, query: string) =>
  request.get(`/api/projects/${PROJECT_KEY}/tasks${query}`, { headers: ADMIN_AUTH });

test("the assignee filter takes a username, which is what it is documented to take", async ({
  request,
}) => {
  await test.step("a username no longer reaches Mongoose as a cast", async () => {
    const res = await list(request, `?assignee=${ADMIN_USERNAME}`);

    expect(res.status(), await res.text()).toBe(200);
  });

  await test.step("and it filters, rather than merely not crashing", async () => {
    // The seed leaves every task unassigned, so without this the filter would answer [] and the
    // assertions below would hold for a route that filtered on nothing at all
    const handed = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { assignee: ADMIN_USERNAME },
    });
    expect(handed.status(), await handed.text()).toBe(200);

    // The premise both assertions below rest on: the board holds more tasks than this person has,
    // so "filtered" and "everything" are different answers
    const everything = await (await list(request, "")).json();
    const assigned = await (await list(request, `?assignee=${ADMIN_USERNAME}`)).json();

    expect(everything.length).toBeGreaterThan(assigned.length);
    for (const task of assigned) {
      expect(task.assignee?.username).toBe(ADMIN_USERNAME);
    }
    expect(assigned.length).toBeGreaterThan(0);
  });

  await test.step("and an id still works, against a real cast", async () => {
    // The unit tests mock Mongoose, so "an id still works" is exactly the claim they cannot make
    const res = await list(request, `?assignee=${String(ADMIN_ID)}`);

    expect(res.status(), await res.text()).toBe(200);
    const byId = await res.json();
    expect(byId.length).toBeGreaterThan(0);
    for (const task of byId) expect(task.assignee?.username).toBe(ADMIN_USERNAME);
  });

  await test.step("a username nobody holds is refused, not answered with an empty list", async () => {
    const res = await list(request, "?assignee=nobody-here");

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/No account named "@nobody-here"/);
  });
});

test("the neighbouring filters answer a typo rather than swallowing it", async ({ request }) => {
  const category = await list(request, "?category=nonsense");
  expect(category.status()).toBe(400);
  expect((await category.json()).error).toMatch(/project categories:/);

  const priority = await list(request, "?priority=urgentish");
  expect(priority.status()).toBe(400);
  expect((await priority.json()).error).toMatch(/one of: low, medium, high, urgent/);

  // The controls, in the same run: a real value of each still filters, so the refusals above are
  // the parameter being judged and not the endpoint being broken
  const bug = await list(request, "?category=bug");
  expect(bug.status(), await bug.text()).toBe(200);
  const high = await list(request, "?priority=high");
  expect(high.status(), await high.text()).toBe(200);

  // The third answer, settled by BP-511: this filter is comma-separated, so it refuses only when
  // NONE of the ids it was given exists — a real column beside an unknown one is a narrower
  // request, not a typo
  const status = await list(request, "?status=no-such-column");
  expect(status.status()).toBe(400);
  expect((await status.json()).error).toMatch(/project columns:/);

  const narrowed = await list(request, "?status=todo,no-such-column");
  expect(narrowed.status(), await narrowed.text()).toBe(200);
});

/**
 * The claim the refusal above rests on, and the one the fixture cannot make on its own: it is the
 * BOARD's columns that decide, not the built-in seven. Reading a project without its `columns`
 * falls back to those seven silently, which refuses a renamed board its own real ids — worse than
 * the empty list this change exists to remove, and green against every other test in the suite.
 */
test("the columns that decide are the board's own", async ({ request }) => {
  await seedRenamedColumn();

  const renamed = await list(request, `?status=${RENAMED_COLUMN_ID}`);
  expect(renamed.status(), await renamed.text()).toBe(200);

  const gone = await list(request, "?status=planned");
  expect(gone.status(), await gone.text()).toBe(400);
  expect((await gone.json()).error).toContain(RENAMED_COLUMN_ID);
});
