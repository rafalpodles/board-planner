import { test, expect, type APIRequestContext } from "@playwright/test";
import { RUN_TENANTS_SERVER } from "../playwright.config";
import { ACME, GLOBEX, SHARED_KEY, TENANTS_API, asTenant, bearer, originOf, seedTwoTenants, type TenantFixture } from "./tenants";

test.skip(!RUN_TENANTS_SERVER, "needs the TENANT_DOMAIN server — set E2E_TENANTS_SERVER=1");

test.beforeEach(async () => {
  await seedTwoTenants();
});

const session = (who: TenantFixture) => ({
  ...asTenant(who),
  cookie: `__Host-bp_session=${who.sessionToken}`,
  origin: originOf(who),
  "content-type": "application/json",
});
const post = (request: APIRequestContext, path: string, who: TenantFixture, data: unknown) =>
  request.post(`${TENANTS_API}${path}`, { headers: session(who), data });
const get = (request: APIRequestContext, path: string, who: TenantFixture) =>
  request.get(`${TENANTS_API}${path}`, { headers: { ...asTenant(who), ...bearer(who) } });

// BP-670: boards, sprints and history, created in one organisation and looked for from the other
test.describe("BP-670: each organisation's boards are its own", () => {
  test("a new board's key is unique within an organisation, and free in the other", async ({ request }) => {
    expect((await post(request, "/api/projects", ACME, { name: "Acme Next", key: "NEXT" })).status()).toBe(201);
    expect((await post(request, "/api/projects", GLOBEX, { name: "Globex Next", key: "NEXT" })).status()).toBe(201);

    const again = await post(request, "/api/projects", ACME, { name: "Acme Next again", key: "NEXT" });
    expect(again.status()).toBe(409);

    for (const [who, name] of [
      [ACME, "Acme Next"],
      [GLOBEX, "Globex Next"],
    ] as const) {
      const res = await get(request, "/api/projects/NEXT", who);
      expect((await res.json()).name, who.slug).toBe(name);
    }
  });

  test("a sprint in one organisation is not in the other's board of the same key", async ({ request }) => {
    const sprint = await post(request, `/api/projects/${ACME.projectId}/sprints`, ACME, {
      name: "Acme sprint 1",
      startDate: "2026-10-01",
      endDate: "2026-10-14",
    });
    expect(sprint.status(), await sprint.text()).toBe(201);

    const theirs = await get(request, `/api/projects/${SHARED_KEY}/sprints`, GLOBEX);
    expect(theirs.status()).toBe(200);
    expect(JSON.stringify(await theirs.json())).not.toContain("Acme sprint 1");
  });

  test("a task's history is not readable from another organisation", async ({ request }) => {
    const created = await post(request, `/api/projects/${ACME.projectId}/tasks`, ACME, { title: "History of Acme" });
    const task = await created.json();

    const foreign = await get(request, `/api/projects/${GLOBEX.projectId}/tasks/${task._id}/activity`, GLOBEX);
    expect(foreign.status()).toBe(404);
  });

  test("task numbers count per organisation's board, so both boards start at 1", async ({ request }) => {
    const a = await (await post(request, `/api/projects/${ACME.projectId}/tasks`, ACME, { title: "Acme first" })).json();
    const g = await (await post(request, `/api/projects/${GLOBEX.projectId}/tasks`, GLOBEX, { title: "Globex first" })).json();

    expect([a.taskNumber, g.taskNumber]).toEqual([1, 1]);
    expect((await (await get(request, `/api/projects/${SHARED_KEY}/tasks/${SHARED_KEY}-1`, ACME)).json()).title).toBe("Acme first");
    expect((await (await get(request, `/api/projects/${SHARED_KEY}/tasks/${SHARED_KEY}-1`, GLOBEX)).json()).title).toBe("Globex first");
  });

  test("on screen: the sidebar of each organisation lists only its own boards", async ({ page, request }) => {
    await post(request, "/api/projects", GLOBEX, { name: "Globex Hidden Board", key: "HIDE" });
    await page.context().addCookies([
      {
        name: "__Host-bp_session",
        value: ACME.sessionToken,
        domain: `${ACME.slug}.tenants.localhost`,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);

    await page.goto(`${originOf(ACME)}/projects`);
    await expect(page.getByText(ACME.projectName).first()).toBeVisible();
    await expect(page.getByText("Globex Hidden Board")).toHaveCount(0);
  });
});
