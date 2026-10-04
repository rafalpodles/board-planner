import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import { E2E_MONGODB_URI, MEMBER_ID, PROJECT_ID, seed } from "./seed";
import { signIn } from "./session";

const ELSEWHERE = new mongoose.Types.ObjectId("0000000000000000000000b2");
const FOREIGN = new mongoose.Types.ObjectId("e2e0000000000000000ff001");
const NOWHERE = new mongoose.Types.ObjectId("e2e0000000000000000ff002");

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  const home = await handle.collection("projects").findOne({ _id: PROJECT_ID });
  await handle.collection("projects").insertOne({ ...home, _id: FOREIGN, tenant: ELSEWHERE, key: "FAR", name: "Elsewhere" });
  await handle.collection("grants").insertOne({
    tenant: ELSEWHERE,
    subject: MEMBER_ID,
    objectType: "project",
    object: FOREIGN,
    relation: "owner",
  });
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

async function answer(request: APIRequestContext, path: string, headers: Record<string, string>) {
  const res = await request.get(path, { headers });
  return { status: res.status(), body: await res.text() };
}

// BP-664: another tenant's project is not there, whoever asks and however they name it
test("an instance admin gets for another tenant's project exactly what a project that does not exist gets", async ({ request }) => {
  for (const suffix of ["", "/tasks", "/sprints"]) {
    const foreign = await answer(request, `/api/projects/${FOREIGN}${suffix}`, ADMIN_AUTH);
    const missing = await answer(request, `/api/projects/${NOWHERE}${suffix}`, ADMIN_AUTH);
    expect(foreign, suffix).toEqual(missing);
    expect(foreign.status, suffix).toBe(404);
  }
  expect(await answer(request, "/api/projects/FAR", ADMIN_AUTH)).toEqual(await answer(request, "/api/projects/NOPE", ADMIN_AUTH));
});

test("a grant held in another tenant carries nobody into it", async ({ request }) => {
  const foreign = await answer(request, `/api/projects/${FOREIGN}`, MEMBER_AUTH);
  const missing = await answer(request, `/api/projects/${NOWHERE}`, MEMBER_AUTH);

  expect(foreign).toEqual(missing);
  expect(foreign.status).toBe(403);
  expect((await answer(request, `/api/projects/${PROJECT_ID}`, ADMIN_AUTH)).status).toBe(200);
});

test("another tenant's project is in nobody's project list", async ({ request }) => {
  for (const auth of [ADMIN_AUTH, MEMBER_AUTH]) {
    const res = await request.get("/api/projects", { headers: auth });
    expect(res.status()).toBe(200);
    const keys = ((await res.json()) as { key: string }[]).map((project) => project.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain("FAR");
  }
});

test("on screen, another tenant's board looks like a board that does not exist", async ({ page }) => {
  await signIn(page, "admin");

  await page.goto("/projects/NOPE");
  await page.waitForLoadState("networkidle");
  const missing = (await page.locator("main").innerText()).replaceAll("NOPE", "?");

  await page.goto("/projects/FAR");
  await page.waitForLoadState("networkidle");
  const foreign = (await page.locator("main").innerText()).replaceAll("FAR", "?");

  expect(foreign).toBe(missing);
  await expect(page.getByText("Elsewhere")).toHaveCount(0);
});
