import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_USERNAME,
  MEMBER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";

/**
 * BP-511. Both writers resolved an unknown username to `null` and wrote it. `updateTask` put that
 * null over whoever held the task and answered 200, so `update_task(assignee: "rafa")` unassigned
 * them and said nothing; `createTask` answered 201 with the task unassigned.
 *
 * Over HTTP rather than through the browser, and for the same reason as `assignee-access.spec.ts`:
 * neither form can make this request. Both send `username || null`, and the picker only ever offers
 * accounts that exist — so what reaches this case is MCP, the PM agent, and anything else holding a
 * token, which is exactly who the refusal is for.
 *
 * The unit tests beside this mock Mongoose, so they can prove the writer's *shape* and nothing
 * about what a real document ends up holding. The assignee surviving a refusal is the whole ticket,
 * and only a real write can show it.
 */

test.beforeEach(seed);

const taskUrl = `/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`;

const put = (request: APIRequestContext, data: Record<string, unknown>) =>
  request.put(taskUrl, { headers: ADMIN_AUTH, data });

const stored = async (request: APIRequestContext) =>
  (
    await request.get(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`, {
      headers: ADMIN_AUTH,
    })
  ).json();

test("a username nobody holds is refused, and the assignee it would have cleared survives", async ({
  request,
}) => {
  const handed = await put(request, { assignee: ADMIN_USERNAME });
  expect(handed.status(), await handed.text()).toBe(200);

  await test.step("the refusal names the name, rather than the Members settings", async () => {
    const refused = await put(request, { assignee: "rafa" });

    expect(refused.status(), await refused.text()).toBe(400);
    const { error } = await refused.json();
    expect(error).toContain("rafa");
    // The other refusal's wording sends a reader to a project setting, and there is none to make
    // for a name nobody holds
    expect(error).not.toMatch(/no access to this board/i);
  });

  await test.step("and the task still belongs to the person it belonged to", async () => {
    expect((await stored(request)).assignee?.username).toBe(ADMIN_USERNAME);
  });

  // The control. Every assertion above holds just as well for a writer that refused everybody, and
  // for one that never wrote an assignee in the first place.
  await test.step("a username somebody holds still moves the task", async () => {
    const accepted = await put(request, { assignee: MEMBER_USERNAME });

    expect(accepted.status(), await accepted.text()).toBe(200);
    expect((await stored(request)).assignee?.username).toBe(MEMBER_USERNAME);
  });
});

/**
 * The lookup normalises, and after this change that is a refusal path: without it `@ADMIN` is a
 * 400 naming an account that plainly exists. A silent no-op became a hard refusal, so the
 * normalisation went from a nicety to load-bearing.
 */
test("a username is matched normalised, not literally", async ({ request }) => {
  const shouted = await put(request, { assignee: `  ${ADMIN_USERNAME.toUpperCase()} ` });

  expect(shouted.status(), await shouted.text()).toBe(200);
  expect((await stored(request)).assignee?.username).toBe(ADMIN_USERNAME);
});

/**
 * The shape a GET answers with, and what a REST client that PUTs the whole object back sends. The
 * two writers disagreed about it: create coerced it to the string `[object Object]`, update let it
 * past and into the cast, where it left the route a 500.
 */
test("an assignee that is not a username is refused rather than cast", async ({ request }) => {
  for (const value of [{ _id: "x", username: "admin" }, 7, ["admin"]]) {
    const refused = await put(request, { assignee: value });

    expect(refused.status(), `assignee: ${JSON.stringify(value)} — ${await refused.text()}`).toBe(
      400
    );
  }

  // The message reaches a model as a tool result, so it is not a place to echo the argument back
  const long = await put(request, { assignee: "x".repeat(5000) });
  expect(long.status()).toBe(400);
  expect((await long.json()).error.length).toBeLessThan(500);
});

/**
 * `""` is what a cleared picker sends. The assignee is an ObjectId ref and cannot hold one, so it
 * reached Mongoose as a cast and left the route a 500 — the one shape "unassign" arrives in that
 * the field refuses. Both forms send `null` instead, which is why this stood.
 */
test("unassigning works whichever shape it arrives in", async ({ request }) => {
  for (const empty of [null, ""] as const) {
    const handed = await put(request, { assignee: ADMIN_USERNAME });
    expect(handed.status(), await handed.text()).toBe(200);

    const cleared = await put(request, { assignee: empty });

    expect(cleared.status(), `assignee: ${JSON.stringify(empty)} — ${await cleared.text()}`).toBe(
      200
    );
    expect((await stored(request)).assignee ?? null).toBeNull();
  }
});

test("a create for a username nobody holds is refused, not answered with an unassigned task", async ({
  request,
}) => {
  const refused = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
    headers: ADMIN_AUTH,
    data: { title: "Never created", assignee: "rafa" },
  });

  expect(refused.status(), await refused.text()).toBe(400);
  expect((await refused.json()).error).toContain("rafa");

  const tasks = await (
    await request.get(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH })
  ).json();
  expect(tasks.map((t: { title: string }) => t.title)).not.toContain("Never created");

  // The control, in the same run: the create itself works, and works assigned
  const created = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
    headers: ADMIN_AUTH,
    data: { title: "Created assigned", assignee: MEMBER_USERNAME },
  });

  expect(created.status(), await created.text()).toBe(201);
  expect((await created.json()).assignee?.username).toBe(MEMBER_USERNAME);
});
