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
    expect(error).not.toMatch(/no access to this board/i);
  });

  await test.step("and the task still belongs to the person it belonged to", async () => {
    expect((await stored(request)).assignee?.username).toBe(ADMIN_USERNAME);
  });

  await test.step("a username somebody holds still moves the task", async () => {
    const accepted = await put(request, { assignee: MEMBER_USERNAME });

    expect(accepted.status(), await accepted.text()).toBe(200);
    expect((await stored(request)).assignee?.username).toBe(MEMBER_USERNAME);
  });
});

test("a username is matched normalised, not literally", async ({ request }) => {
  const shouted = await put(request, { assignee: `  ${ADMIN_USERNAME.toUpperCase()} ` });

  expect(shouted.status(), await shouted.text()).toBe(200);
  expect((await stored(request)).assignee?.username).toBe(ADMIN_USERNAME);
});

test("an assignee that is not a username is refused rather than cast", async ({ request }) => {
  for (const value of [{ _id: "x", username: "admin" }, 7, ["admin"]]) {
    const refused = await put(request, { assignee: value });

    expect(refused.status(), `assignee: ${JSON.stringify(value)} — ${await refused.text()}`).toBe(
      400
    );
  }

  const long = await put(request, { assignee: "x".repeat(5000) });
  expect(long.status()).toBe(400);
  expect((await long.json()).error.length).toBeLessThan(500);
});

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

  const created = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, {
    headers: ADMIN_AUTH,
    data: { title: "Created assigned", assignee: MEMBER_USERNAME },
  });

  expect(created.status(), await created.text()).toBe(201);
  expect((await created.json()).assignee?.username).toBe(MEMBER_USERNAME);
});
