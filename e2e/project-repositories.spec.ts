import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-986, the first slice: a project lists its repositories, and the address on the Integrations
 * screen is the first of them. Saving a new address keeps that entry's id, which is what a task or a
 * machine will name it by; clearing it leaves none.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=integrations`;

async function stored(): Promise<{ id: string; url: string }[]> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const project = await mongoose.connection.db!.collection("projects").findOne({ _id: PROJECT_ID });
    return ((project?.repositories ?? []) as { _id: unknown; url: string }[]).map((r) => ({ id: String(r._id), url: r.url }));
  } finally {
    await mongoose.disconnect();
  }
}

async function saveRepository(page: Page, url: string) {
  const field = page.getByLabel("Repository URL");
  await field.fill(url);
  await expect(field).toHaveValue(url);
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}`) && r.request().method() === "PUT"
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  return response.json();
}

test.beforeEach(seed);

test("the repository saved on Integrations is the project's first, and keeps its id when it moves", async ({ page }) => {
  await signIn(page);
  await page.goto(SETTINGS);

  const first = await saveRepository(page, "https://github.com/acme/web");
  const [entry] = await stored();
  expect(entry).toMatchObject({ url: "https://github.com/acme/web" });
  expect(first.repositories).toEqual([{ id: entry.id, url: "https://github.com/acme/web", name: "" }]);

  await page.reload();
  await expect(page.getByLabel("Repository URL")).toHaveValue("https://github.com/acme/web");
  const moved = await saveRepository(page, "https://github.com/acme/web-renamed");
  expect(await stored()).toEqual([{ id: entry.id, url: "https://github.com/acme/web-renamed" }]);
  expect(moved.repositoryUrl).toBe("https://github.com/acme/web-renamed");

  await saveRepository(page, "");
  expect(await stored()).toEqual([]);
});

test("a project read before the migration still answers its one repository", async ({ request }) => {
  await mongoose.connect(E2E_MONGODB_URI);
  await mongoose.connection.db!
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $set: { repositoryUrl: "https://github.com/acme/legacy" }, $unset: { repositories: "" } });
  await mongoose.disconnect();

  const { ADMIN_AUTH } = await import("./api");
  const project = await (await request.get(`/api/projects/${PROJECT_KEY}`, { headers: ADMIN_AUTH })).json();
  expect(project.repositories).toEqual([{ id: "primary", url: "https://github.com/acme/legacy", name: "" }]);
});

// BP-1069. The repositories after the primary one: every task of the project runs in all of them.
async function saveChanges(page: Page) {
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}`) && r.request().method() === "PUT"
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  return saved;
}

async function storedNames(): Promise<string[]> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const project = await mongoose.connection.db!.collection("projects").findOne({ _id: PROJECT_ID });
    return ((project?.repositories ?? []) as { name?: string }[]).map((r) => r.name ?? "");
  } finally {
    await mongoose.disconnect();
  }
}

test("a second repository is added on Integrations, survives a reload and is removed again", async ({ page }) => {
  await signIn(page);
  await page.goto(SETTINGS);
  await saveRepository(page, "https://github.com/acme/web");
  const [primary] = await stored();
  await expect(page.getByLabel("Additional repository 1 URL")).toHaveCount(0);

  await page.getByRole("button", { name: "Add a repository" }).click();
  await page.getByLabel("Additional repository 1 name").fill("API");
  await page.getByLabel("Additional repository 1 URL").fill("https://github.com/acme/api");
  await expect(page.getByText(/holds a checkout of every one/)).toBeVisible();
  const added = await saveChanges(page);
  expect(added.status()).toBe(200);

  expect(await stored()).toEqual([primary, expect.objectContaining({ url: "https://github.com/acme/api" })]);
  expect(await storedNames()).toEqual(["", "API"]);

  await page.reload();
  await expect(page.getByLabel("Additional repository 1 URL")).toHaveValue("https://github.com/acme/api");
  await expect(page.getByLabel("Additional repository 1 name")).toHaveValue("API");
  await expect(page.getByLabel("Repository URL")).toHaveValue("https://github.com/acme/web");

  await page.getByRole("button", { name: "Remove additional repository 1" }).click();
  const removed = await saveChanges(page);
  expect(removed.status()).toBe(200);
  expect(await stored()).toEqual([primary]);
  await expect(page.getByLabel("Additional repository 1 URL")).toHaveCount(0);

  await page.goto(`/projects/${PROJECT_KEY}/settings?section=audit`);
  await expect(page.getByText("Added repository https://github.com/acme/api (API)")).toBeVisible();
  await expect(page.getByText("Removed repository https://github.com/acme/api")).toBeVisible();
});

test("the screen says why a repository that is already listed is refused, and stores nothing", async ({ page }) => {
  await signIn(page);
  await page.goto(SETTINGS);
  await saveRepository(page, "https://github.com/acme/web");

  await page.getByRole("button", { name: "Add a repository" }).click();
  await page.getByLabel("Additional repository 1 URL").fill("git@github.com:acme/web.git");
  const refused = await saveChanges(page);

  expect(refused.status()).toBe(400);
  await expect(page.getByText(/is already listed/)).toBeVisible();
  expect(await stored()).toHaveLength(1);
  await expect(page.getByLabel("Additional repository 1 URL")).toHaveValue("git@github.com:acme/web.git");
});
