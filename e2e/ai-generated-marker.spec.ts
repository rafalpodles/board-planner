import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import mongoose from "mongoose";
import { PM_STUB_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

const PM_MODEL = "e2e/text-only-model";
const PM_MARK = { kind: "ai", feature: "pm_agent", model: PM_MODEL };

test.beforeEach(async ({ request }) => {
  await seed();
  await request.post(`${PM_STUB_URL}/reset`);
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    await mongoose.connection.db!.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { "pm.model": PM_MODEL } });
  } finally {
    await mongoose.disconnect();
  }
});

test.afterEach(async ({ request }) => {
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});

async function askThePm(page: Page, prompt: string, call: Record<string, unknown>) {
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  const box = page.getByPlaceholder(/Message the PM/);
  await expect(box).toBeVisible();
  const chips = page.getByRole("link", { name: new RegExp(`${PROJECT_KEY}-\\d+`) });
  const before = await chips.count();
  await box.fill(`${prompt} <<${JSON.stringify(call)}>>`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => chips.count(), { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(box).toBeEnabled({ timeout: 30_000 });
}

async function api(request: APIRequestContext, path: string) {
  const response = await request.get(`/api/projects/${PROJECT_KEY}${path}`, { headers: ADMIN_AUTH });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function exported(page: Page): Promise<{ collection: string; document: Record<string, unknown> }[]> {
  await page.goto("/settings/export");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download the export" }).click(),
  ]);
  const text = gunzipSync(readFileSync((await download.path())!)).toString("utf8");
  const [, ...rows] = text.trim().split("\n").map((line) => mongoose.mongo.BSON.EJSON.parse(line));
  return rows as { collection: string; document: Record<string, unknown> }[];
}

test("a task and a comment the PM writes carry its mark in the API and in the export", async ({ page, request }) => {
  await signIn(page);
  const title = "Release checklist the agent filed";
  await askThePm(page, "File the release checklist.", { name: "create_task", arguments: { title } });

  const listed: { _id: string; taskNumber: number; title: string }[] = await api(request, "/tasks");
  const created = listed.find((task) => task.title === title)!;
  expect(created, "the PM's task was not created").toBeTruthy();
  const taskKey = `${PROJECT_KEY}-${created.taskNumber}`;

  await askThePm(page, "Comment on it.", { name: "add_comment", arguments: { taskKey, body: "Filed from the chat." } });

  const own = await request.post(`/api/projects/${PROJECT_KEY}/tasks/${created._id}/comments`, {
    headers: ADMIN_AUTH,
    data: { body: "Written by hand." },
  });
  expect(own.status()).toBe(201);

  await test.step("the REST API", async () => {
    expect((await api(request, `/tasks/${created._id}`)).generatedBy).toEqual(PM_MARK);
    const comments: { body: string; generatedBy?: unknown }[] = await api(request, `/tasks/${created._id}/comments`);
    expect(comments.find((c) => c.body === "Filed from the chat.")?.generatedBy).toEqual(PM_MARK);
    expect(comments.find((c) => c.body === "Written by hand.")).not.toHaveProperty("generatedBy");
    const history: { action: string; generatedBy?: unknown }[] = await api(request, `/tasks/${created._id}/activity`);
    expect(history.filter((row) => row.action === "created" || row.action === "comment_added").map((row) => row.generatedBy)).toEqual(
      expect.arrayContaining([PM_MARK, PM_MARK])
    );
    expect(history.filter((row) => !row.generatedBy).map((row) => row.action)).toEqual(["comment_added"]);
  });

  await test.step("the organisation's export", async () => {
    const rows = await exported(page);
    const task = rows.find((row) => row.collection === "Task" && row.document.title === title);
    expect(task?.document.generatedBy).toEqual(PM_MARK);
    const comment = rows.find((row) => row.collection === "Comment" && row.document.body === "Filed from the chat.");
    expect(comment?.document.generatedBy).toEqual(PM_MARK);
    const byHand = rows.find((row) => row.collection === "Comment" && row.document.body === "Written by hand.");
    expect(byHand?.document).not.toHaveProperty("generatedBy");
  });
});
