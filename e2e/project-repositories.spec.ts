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
