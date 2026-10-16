import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { PM_STUB_URL } from "../playwright.config";
import { SAME_ORIGIN } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed, taskFactory } from "./seed";
import { signIn } from "./session";
import { e2eLicence, useLicenceKey } from "./licence-key";

/**
 * BP-872: a cheap lexical shortlist, then one model call that ranks it. The same work in other words
 * is offered, with the model's reason; unrelated work never reaches the model; a key the model names
 * that was not shortlisted is dropped (the stub names whatever "stub-duplicate: KEY" lines say). A
 * shortlist of none asks no model. Free gets the upsell and a 402.
 */

const DUPLICATES = `/api/projects/${PROJECT_KEY}/duplicates`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

async function task(taskNumber: number, title: string, description = "") {
  const _id = new mongoose.Types.ObjectId();
  await (await db()).collection("tasks").insertOne(taskFactory(new Date())({ _id, taskNumber, title, description, status: "todo" }));
  return _id;
}

async function openNewTask(page: Page, title: string, description: string) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();
  const modal = page.getByRole("dialog", { name: "New Task" });
  await expect(modal.getByPlaceholder("Describe what you need")).toBeVisible();
  await modal.getByLabel("Title").fill(title);
  await modal.getByRole("textbox", { name: /^Markdown supported/ }).fill(description);
  return modal;
}

async function lastWrite() {
  return (await fetch(`${PM_STUB_URL}/last-write`)).json();
}

test.beforeEach(async ({ request }) => {
  await seed();
  await useLicenceKey(request, undefined);
  await fetch(`${PM_STUB_URL}/reset`);
  await (await db()).collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { taskCounter: 900 } });
});

test.afterEach(async ({ request }) => {
  await useLicenceKey(request, undefined);
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("on Free the check is an upsell and the route answers 402", async ({ page }) => {
  await signIn(page, "owner");
  const modal = await openNewTask(page, "Download invoices as a CSV file", "");
  await modal.getByRole("button", { name: "Check for duplicates" }).click();
  await expect(modal.getByTestId("pro-upsell")).toContainText("Duplicate detection");
  const refused = await page.request.post(DUPLICATES, { headers: SAME_ORIGIN, data: { title: "x" } });
  expect(refused.status()).toBe(402);
});

test("a new task is offered the same work in other words, and marked a duplicate of it on create", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence());
  const original = await task(801, "Export invoices to CSV", "Accounting wants a spreadsheet of invoices");
  await task(802, "Dark mode toggle in settings");
  await signIn(page, "owner");

  const modal = await openNewTask(page, "Download invoices as a CSV file", "stub-duplicate: TP-801\nstub-duplicate: TP-802\nstub-duplicate: TP-999");
  const checked = page.waitForResponse((r) => r.url().endsWith("/duplicates"));
  await modal.getByRole("button", { name: "Check for duplicates" }).click();
  expect((await checked).status()).toBe(200);
  const found = modal.getByRole("list", { name: "Possible duplicates" });
  await expect(found.getByRole("link", { name: "TP-801 Export invoices to CSV" })).toBeVisible();
  await expect(found.getByText("The stub was told to")).toBeVisible();
  // Asked for by the task's text, but nothing like the draft, so never shortlisted and never shown
  await expect(found.getByText(/TP-802|TP-999/)).toHaveCount(0);
  const sent = await lastWrite();
  expect(sent.tools).toBeNull();
  expect(sent.messages[1].content).toContain("Export invoices to CSV");
  expect(sent.messages[1].content).not.toContain("Dark mode");

  await modal.getByLabel("Duplicate of TP-801").check();
  const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/tasks"));
  const linked = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/links"));
  await modal.getByRole("button", { name: "Create Task" }).click();
  const { taskNumber } = await (await created).json();
  expect((await linked).status()).toBeLessThan(300);
  const made = await (await db()).collection("tasks").findOne({ project: PROJECT_ID, taskNumber });
  expect(made?.relations).toEqual([expect.objectContaining({ type: "duplicates", task: original })]);
});

test("a draft like nothing on the board asks no model", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence());
  await task(801, "Export invoices to CSV");
  await signIn(page, "owner");
  const modal = await openNewTask(page, "Quantum zebra telescope", "");
  await modal.getByRole("button", { name: "Check for duplicates" }).click();
  await expect(modal.getByText("No likely duplicates on this board.")).toBeVisible();
  expect(await lastWrite()).toEqual({});
});

test("an existing task finds its duplicate on demand and marks it through the links route", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence());
  const original = await task(801, "Export invoices to CSV");
  const copy = await task(803, "Invoices CSV download is broken", "stub-duplicate: TP-801");
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/tasks/803`);
  const check = page.getByTestId("duplicates-check");
  await check.getByRole("button", { name: "Find duplicates" }).click();
  await expect(check.getByRole("link", { name: "TP-801 Export invoices to CSV" })).toBeVisible();
  // The task asked about is never its own candidate
  const content: string = (await lastWrite()).messages[1].content;
  const material = JSON.parse(content.slice("<data>\n".length, -"\n</data>".length));
  expect(material.candidates.map((c: { key: string }) => c.key)).toEqual(["TP-801"]);

  await check.getByRole("button", { name: "Mark as a duplicate of TP-801" }).click();
  await expect(check.getByRole("button", { name: "Mark as a duplicate of TP-801" })).toHaveText("Marked");
  const stored = await (await db()).collection("tasks").findOne({ _id: copy });
  expect(stored?.relations).toEqual([expect.objectContaining({ type: "duplicates", task: original })]);
});

test("a task already linked either way is never offered, since marking would replace the link", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence());
  const original = await task(801, "Export invoices to CSV");
  await task(803, "Invoices CSV download is broken", "stub-duplicate: TP-801");
  await (await db()).collection("tasks").updateOne({ _id: original }, { $set: { relations: [{ type: "parent_of", task: (await (await db()).collection("tasks").findOne({ taskNumber: 803, project: PROJECT_ID }))!._id }] } });
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/tasks/803`);
  const check = page.getByTestId("duplicates-check");
  await check.getByRole("button", { name: "Find duplicates" }).click();
  await expect(check.getByText("No likely duplicates on this board.")).toBeVisible();
  expect(await lastWrite()).toEqual({});
});
