import { test, expect, type APIRequestContext } from "@playwright/test";
import { RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { ACME, GLOBEX, SHARED_KEY, ORGANISATIONS_API, asOrganisation, bearer, originOf, seedTwoOrganisations, signInOn, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

test.beforeEach(async () => {
  await seedTwoOrganisations();
});

const as = (who: OrganisationFixture) => ({ ...asOrganisation(who), ...bearer(who), "content-type": "application/json" });
const call = (request: APIRequestContext, method: "get" | "post" | "put" | "patch" | "delete", path: string, who: OrganisationFixture, data?: unknown) =>
  request[method](`${ORGANISATIONS_API}${path}`, { headers: as(who), ...(data === undefined ? {} : { data }) });

async function acmeTask(request: APIRequestContext, title = "Acme secret launch plan") {
  const res = await call(request, "post", `/api/projects/${ACME.projectId}/tasks`, ACME, { title });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { _id: string; taskNumber: number };
}

// BP-670: one refusal per route family, each from inside the other organisation with a valid credential there
test.describe("BP-670: what one organisation can reach of another's, route family by route family", () => {
  test("tasks: another organisation's task is not there by id, by number or in a list", async ({ request }) => {
    const task = await acmeTask(request);

    expect((await call(request, "get", `/api/projects/${GLOBEX.projectId}/tasks/${task._id}`, GLOBEX)).status()).toBe(404);
    expect((await call(request, "get", `/api/projects/${ACME.projectId}/tasks/${task._id}`, GLOBEX)).status()).toBe(404);
    expect((await call(request, "get", `/api/projects/${SHARED_KEY}/tasks/${SHARED_KEY}-${task.taskNumber}`, GLOBEX)).status()).toBe(404);

    const list = await call(request, "get", `/api/projects/${SHARED_KEY}/tasks`, GLOBEX);
    expect(list.status()).toBe(200);
    expect(JSON.stringify(await list.json())).not.toContain("Acme secret launch plan");
  });

  test("tasks: another organisation's task cannot be changed or deleted", async ({ request }) => {
    const task = await acmeTask(request);

    const put = await call(request, "put", `/api/projects/${GLOBEX.projectId}/tasks/${task._id}`, GLOBEX, { title: "taken over" });
    const del = await call(request, "delete", `/api/projects/${GLOBEX.projectId}/tasks/${task._id}`, GLOBEX);
    expect([put.status(), del.status()]).toEqual([404, 404]);

    const still = await call(request, "get", `/api/projects/${ACME.projectId}/tasks/${task._id}`, ACME);
    expect((await still.json()).title).toBe("Acme secret launch plan");
  });

  test("comments: nobody comments on another organisation's task", async ({ request }) => {
    const task = await acmeTask(request);

    const res = await call(request, "post", `/api/projects/${GLOBEX.projectId}/tasks/${task._id}/comments`, GLOBEX, { body: "hello from globex" });
    expect(res.status()).toBe(404);

    const comments = await call(request, "get", `/api/projects/${ACME.projectId}/tasks/${task._id}/comments`, ACME);
    expect(JSON.stringify(await comments.json())).not.toContain("hello from globex");
  });

  test("search finds nothing of another organisation's", async ({ request }) => {
    await acmeTask(request, "Zeppelin quarterly review");

    const theirs = await call(request, "get", "/api/search?q=Zeppelin", GLOBEX);
    expect(theirs.status()).toBe(200);
    expect(await theirs.json()).toEqual([]);

    const ours = await call(request, "get", "/api/search?q=Zeppelin", ACME);
    expect(JSON.stringify(await ours.json())).toContain("Zeppelin quarterly review");
  });

  test("my tasks lists only the caller's own organisation's work", async ({ request }) => {
    const task = await acmeTask(request, "Assigned across the fence");
    await call(request, "put", `/api/projects/${ACME.projectId}/tasks/${task._id}`, ACME, { assignee: String(ACME.adminId) });

    const mine = await call(request, "get", "/api/tasks/mine", GLOBEX);
    expect(mine.status()).toBe(200);
    expect(JSON.stringify(await mine.json())).not.toContain("Assigned across the fence");
  });

  test("users: an organisation's admin lists only its own people", async ({ request }) => {
    for (const [who, other] of [
      [ACME, GLOBEX],
      [GLOBEX, ACME],
    ] as const) {
      const res = await call(request, "get", "/api/users", who);
      expect(res.status(), who.slug).toBe(200);
      const emails = ((await res.json()) as { email: string }[]).map((u) => u.email);
      expect(emails, who.slug).toContain(`boss@${who.slug}.example`);
      expect(emails, who.slug).not.toContain(`boss@${other.slug}.example`);
    }
  });

  test("users: another organisation's person cannot be changed or deleted by id", async ({ request }) => {
    const asGlobexAdmin = { ...asOrganisation(GLOBEX), cookie: `__Host-bp_session=${GLOBEX.sessionToken}`, origin: originOf(GLOBEX), "content-type": "application/json" };
    const put = await request.put(`${ORGANISATIONS_API}/api/users/${ACME.adminId}`, { headers: asGlobexAdmin, data: { fullName: "renamed by globex" } });
    const del = await request.delete(`${ORGANISATIONS_API}/api/users/${ACME.adminId}`, { headers: asGlobexAdmin });
    expect([put.status(), del.status()]).toEqual([404, 404]);

    const acmePeople = await call(request, "get", "/api/users", ACME);
    expect(JSON.stringify(await acmePeople.json())).toContain("acme boss");
  });

  test("settings: a change in one organisation leaves the other's alone", async ({ request }) => {
    const put = await request.put(`${ORGANISATIONS_API}/api/settings`, {
      headers: { ...asOrganisation(ACME), cookie: `__Host-bp_session=${ACME.sessionToken}`, origin: originOf(ACME), "content-type": "application/json" },
      data: { pmDefaultModel: "acme/model" },
    });
    expect(put.status(), await put.text()).toBe(200);

    expect((await (await call(request, "get", "/api/settings", ACME)).json()).pmDefaultModel).toBe("acme/model");
    expect((await (await call(request, "get", "/api/settings", GLOBEX)).json()).pmDefaultModel).not.toBe("acme/model");
  });

  test("tokens: each person sees only their own organisation's tokens", async ({ request }) => {
    const res = await call(request, "get", "/api/tokens", GLOBEX);
    expect(res.status()).toBe(200);
    const names = ((await res.json()) as { name: string }[]).map((t) => t.name);
    expect(names).toContain("globex token");
    expect(names).not.toContain("acme token");
  });

  test("invitations: one organisation's invitation is invisible to the other", async ({ request }) => {
    const invite = await request.post(`${ORGANISATIONS_API}/api/invitations`, {
      headers: { ...asOrganisation(ACME), cookie: `__Host-bp_session=${ACME.sessionToken}`, origin: originOf(ACME), "content-type": "application/json" },
      data: { email: "newbie@acme.example" },
    });
    expect(invite.status(), await invite.text()).toBeLessThan(300);

    const theirs = await request.get(`${ORGANISATIONS_API}/api/invitations`, {
      headers: { ...asOrganisation(GLOBEX), cookie: `__Host-bp_session=${GLOBEX.sessionToken}` },
    });
    expect(theirs.status()).toBe(200);
    expect(JSON.stringify(await theirs.json())).not.toContain("newbie@acme.example");
  });

  test("on screen: a task opened by its key shows each organisation its own", async ({ page, request }) => {
    const task = await acmeTask(request, "Only Acme sees this");
    await signInOn(page.context(), GLOBEX);

    await page.goto(`${originOf(GLOBEX)}/projects/${SHARED_KEY}/tasks/${SHARED_KEY}-${task.taskNumber}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(GLOBEX.projectName).first()).toBeVisible();
    await expect(page.getByText("Only Acme sees this")).toHaveCount(0);
  });
});
