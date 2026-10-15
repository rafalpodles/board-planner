import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { Readable } from "node:stream";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, PROJECT_NAME, seed } from "./seed";
import { signIn } from "./session";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
const ELSEWHERE = new mongoose.Types.ObjectId("0000000000000000000000b2");

test.beforeEach(seed);

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

async function upload(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post("/api/uploads", {
    headers: ADMIN_AUTH,
    multipart: { file: { name, mimeType: "image/png", buffer: TINY_PNG }, projectId: String(PROJECT_ID) },
  });
  expect(response.status(), await response.text()).toBe(200);
  return new URL((await response.json()).url, "http://x").pathname.split("/").pop()!;
}

// A file of another organisation that names this board: it is never this organisation's to remove
function storeForAnotherOrganisation(): Promise<string> {
  return withDb(async (db) => {
    const stream = new mongoose.mongo.GridFSBucket(db, { bucketName: "uploads" }).openUploadStream("theirs.png", {
      metadata: { contentType: "image/png", project: PROJECT_ID, organisation: ELSEWHERE },
    });
    await new Promise<void>((resolve, reject) => Readable.from(TINY_PNG).pipe(stream).on("finish", resolve).on("error", reject));
    return String(stream.id);
  });
}

const stored = (id: string) =>
  withDb(async (db) => (await db.collection("uploads.files").countDocuments({ _id: new mongoose.Types.ObjectId(id) })) === 1);

const link = (id: string) => `![file](/api/uploads/${id})`;

async function newTask(request: APIRequestContext, title: string, description: string) {
  const response = await request.post(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH, data: { title, description } });
  expect(response.status(), await response.text()).toBe(201);
  const task = await response.json();
  return { id: String(task._id), number: Number(task.taskNumber) };
}

async function comment(request: APIRequestContext, taskId: string, body: string) {
  const response = await request.post(`/api/projects/${PROJECT_KEY}/tasks/${taskId}/comments`, { headers: ADMIN_AUTH, data: { body } });
  expect(response.status(), await response.text()).toBe(201);
}

async function deleteTaskInTheBoard(page: Page, number: number, taskId: string) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${number}`);
  await expect(page.getByTestId("task-top-bar")).toBeVisible();
  await page.getByRole("button", { name: "Delete task" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Delete Task" });
  await expect(dialog).toBeVisible();
  const answered = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/tasks/${taskId}`));
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await answered).status()).toBe(200);
}

test.describe("BP-1054: a file goes with the last thing that names it", () => {
  test("deleting a task removes its files and its comments' files, and keeps one another task still names", async ({ page, request }) => {
    const [description, shared, inComment] = [await upload(request, "own.png"), await upload(request, "shared.png"), await upload(request, "comment.png")];
    const first = await newTask(request, "First owner of the files", `${link(description)} ${link(shared)}`);
    const second = await newTask(request, "Second owner of the shared file", link(shared));
    await comment(request, first.id, `see ${link(inComment)}`);
    for (const id of [description, shared, inComment]) expect(await stored(id), "uploaded before the delete").toBe(true);

    await signIn(page, "owner");
    await deleteTaskInTheBoard(page, first.number, first.id);

    await expect.poll(() => stored(description)).toBe(false);
    expect(await stored(inComment)).toBe(false);
    expect(await stored(shared), "the second task still shows it").toBe(true);

    await deleteTaskInTheBoard(page, second.number, second.id);
    await expect.poll(() => stored(shared)).toBe(false);
  });

  test("deleting a comment removes the file only it named, and not one the task description still shows", async ({ page, request }) => {
    const [onlyHere, alsoInTask] = [await upload(request, "only-comment.png"), await upload(request, "also-task.png")];
    const task = await newTask(request, "A thread with images", link(alsoInTask));
    await comment(request, task.id, `${link(onlyHere)} and ${link(alsoInTask)}`);

    await signIn(page, "admin");
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${task.number}`);
    const card = page.locator("#main-content div.bg-bg-input").filter({ has: page.getByRole("button", { name: "Delete" }) }).first();
    await card.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Comment" });
    const answered = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes(`/tasks/${task.id}/comments`));
    await dialog.getByRole("button", { name: "Delete" }).click();
    expect((await answered).status()).toBe(200);

    await expect.poll(() => stored(onlyHere)).toBe(false);
    expect(await stored(alsoInTask), "the description still shows it").toBe(true);
  });

  test("deleting a board removes every file recorded against it and nothing of another organisation's", async ({ page, request }) => {
    const [first, second] = [await upload(request, "board-one.png"), await upload(request, "board-two.png")];
    const theirs = await storeForAnotherOrganisation();
    await newTask(request, "Names one of them", link(first));

    await signIn(page, "owner");
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=general`);
    await expect(page.getByLabel("Project name")).toHaveValue(PROJECT_NAME);
    const deleted = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/projects/${PROJECT_KEY}` && r.request().method() === "DELETE"
    );
    await page.getByRole("button", { name: "Delete project..." }).click();
    await page.getByRole("button", { name: "Delete project", exact: true }).click();
    expect((await deleted).status()).toBe(200);

    await expect.poll(() => stored(first)).toBe(false);
    expect(await stored(second)).toBe(false);
    expect(await stored(theirs), "another organisation's file is not this board's to remove").toBe(true);
  });
});
