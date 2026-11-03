import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { createApiClient } from "../worker/src/api";
import { createOutbox, type Store } from "../worker/src/outbox";
import { createQueuedMerges, watchQueuedMerges, type QueuedMerge } from "../worker/src/queued-merges";
import type { PullRequestState } from "../worker/src/delivery";
import { signIn } from "./session";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  WORKER_NAME,
  seed,
  taskFactory,
} from "./seed";

/**
 * BP-1128. A run whose Merge step armed GitHub's auto-merge reports "delivered" and ends, leaving
 * its task in review; the GitHub sync never moves a task. So the worker watches the pull request
 * itself. Driven here with the worker's own watcher, outbox and API client against the real board,
 * only GitHub's answer stubbed, and read back through the task page a person would open.
 */

const REPOSITORY = "https://github.com/e2e/queued-merge";
const MERGED = { id: new mongoose.Types.ObjectId(), number: 9_128, pr: `${REPOSITORY}/pull/1` };
const CLOSED = { id: new mongoose.Types.ObjectId(), number: 9_129, pr: `${REPOSITORY}/pull/2` };
const MOVED = { id: new mongoose.Types.ObjectId(), number: 9_130, pr: `${REPOSITORY}/pull/3` };

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function serveTheProject() {
  const handle = await db();
  const identityId = new mongoose.Types.ObjectId();
  await handle.collection("users").insertOne({
    _id: identityId,
    username: "worker-queued-merge",
    fullName: "rig · worker-queued-merge",
    password: await bcrypt.hash("unused-queued-merge", 4),
    email: "",
    kind: "machine",
    role: "member",
    createdAt: new Date(),
  });
  await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { repositoryUrl: REPOSITORY } });
  await handle.collection("workers").updateOne(
    { _id: WORKER_ID },
    { $set: { identity: identityId, owner: ADMIN_ID, repos: [{ remote: `${REPOSITORY}.git`, path: "/Users/someone/queued-merge" }] } }
  );
  const task = taskFactory(new Date());
  await handle.collection("tasks").insertMany([
    task({ _id: MERGED.id, taskNumber: MERGED.number, title: "Queued and merged", status: "in_review" }),
    task({ _id: CLOSED.id, taskNumber: CLOSED.number, title: "Queued and closed", status: "in_review" }),
    // A person took this one back to the queue after the run reported it
    task({ _id: MOVED.id, taskNumber: MOVED.number, title: "Queued and moved by a person", status: "todo" }),
  ]);
  await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: MOVED.number } });
}

function memoryStore(): Store {
  let text = "";
  return { read: () => text, write: (next) => void (text = next) };
}

function queued(task: typeof MERGED): QueuedMerge {
  return {
    projectId: String(PROJECT_ID),
    taskId: String(task.id),
    taskKey: `${PROJECT_KEY}-${task.number}`,
    prUrls: [task.pr],
    review: "in_review",
    done: "done",
    queuedAt: new Date().toISOString(),
  };
}

async function openTask(page: Page, number: number) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${number}`);
  return page.getByRole("main").getByRole("combobox", { name: "Status", exact: true });
}

test.beforeEach(async () => {
  await seed();
  await serveTheProject();
});

test("the worker moves a task whose queued pull request merged to done, and leaves a closed one in review with a comment", async ({
  page,
  baseURL,
}) => {
  const api = createApiClient(
    {
      apiBaseUrl: baseURL!,
      apiToken: "",
      enrolmentToken: "",
      enrolmentTokenError: "",
      enrolmentTokenFile: "",
      workerName: WORKER_NAME,
      stateDir: "/nonexistent",
    },
    fetch,
    { read: () => JSON.stringify({ workerId: String(WORKER_ID), credential: WORKER_CREDENTIAL }) }
  );
  const merges = createQueuedMerges(memoryStore());
  for (const task of [MERGED, CLOSED, MOVED]) merges.add(queued(task));
  const states: Record<string, PullRequestState> = { [MERGED.pr]: "merged", [CLOSED.pr]: "closed", [MOVED.pr]: "merged" };
  const outbox = createOutbox(memoryStore(), () => {});

  await watchQueuedMerges({ merges, pullRequestState: async (url) => states[url], outbox, now: () => Date.now() });
  // Three comments and two moves; the move a person pre-empted is refused for good, not retried
  expect(await outbox.flush(api)).toEqual({ delivered: 4, pending: 0, dropped: 1 });
  expect(merges.list()).toEqual([]);

  await signIn(page, "admin");

  const merged = await openTask(page, MERGED.number);
  await expect(merged).toContainText("Done");
  await expect(page.locator("div.group", { hasText: `GitHub merged ${MERGED.pr}.` })).toBeVisible();

  const closed = await openTask(page, CLOSED.number);
  await expect(page.locator("div.group", { hasText: `${CLOSED.pr} was closed without being merged` })).toBeVisible();
  await expect(closed).toContainText("In Review");

  const moved = await openTask(page, MOVED.number);
  await expect(page.locator("div.group", { hasText: `GitHub merged ${MOVED.pr}.` })).toBeVisible();
  await expect(moved).toContainText("To Do");
});
