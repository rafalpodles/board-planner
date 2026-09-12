import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { signIn } from "./session";
import {
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  PROJECT_ID,
  SIBLING_TASK_ID,
  SIBLING_TASK_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  seed,
} from "./seed";

/**
 * BP-609. A machine that cannot confine the agent, or cannot reach the base branch, hands its task
 * back exactly the way a usage limit does — released, attempt refunded, a comment on the card. The
 * outcome the run is recorded with was `released` for both, so the run history could not tell an
 * operator which of their machines had stopped working; only the free-text detail could, and
 * nothing reads that as a state.
 *
 * Driven end to end rather than in the unit suites because the two halves are in different
 * packages: `AGENT_RUN_OUTCOMES` decides whether the worker's POST is a 400 at the one moment the
 * run has nothing left to retry with, and `run-outcome.ts` decides what the fleet screen shows. A
 * green unit test on either side is compatible with the other refusing the word.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function giveWorkerAnIdentity(workerId: mongoose.Types.ObjectId, username: string) {
  const handle = await db();
  const identityId = new mongoose.Types.ObjectId();
  await handle.collection("users").insertOne({
    _id: identityId,
    username,
    fullName: `rig · ${username}`,
    password: await bcrypt.hash(`unused-${username}`, 4),
    email: "",
    kind: "machine",
    role: "member",
    createdAt: new Date(),
  });
  await handle.collection("workers").updateOne({ _id: workerId }, { $set: { identity: identityId } });
}

function workerHeaders() {
  return {
    Authorization: `Bearer ${WORKER_CREDENTIAL}`,
    "X-Worker-Id": String(WORKER_ID),
    "X-CP-Protocol": "1",
  };
}

function postRun(
  request: import("@playwright/test").APIRequestContext,
  outcome: string,
  taskId: mongoose.Types.ObjectId,
  taskKey: string,
  detail: string
) {
  return request.post(`/api/projects/${PROJECT_ID}/runs`, {
    headers: workerHeaders(),
    data: {
      taskId: String(taskId),
      taskKey,
      outcome,
      detail,
      workerId: String(WORKER_ID),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date().toISOString(),
      costUsd: 0,
    },
  });
}

test.beforeEach(async () => {
  await seed();
  await giveWorkerAnIdentity(WORKER_ID, "worker-machine-fault");
});

// The worker's own vocabulary maps machineFault onto this word (worker/src/run-record.ts), so a
// server that does not accept it answers 400 and the run leaves no record at all.
test("the server records a machine fault under its own outcome", async ({ request }) => {
  const posted = await postRun(
    request,
    "machineFault",
    HELD_TASK_ID,
    HELD_TASK_KEY,
    "this machine has no sandbox"
  );

  expect(posted.status(), await posted.text()).toBe(201);

  const stored = await (await db())
    .collection("agentruns")
    .findOne({ taskKey: HELD_TASK_KEY }, { sort: { finishedAt: -1 } });
  expect(stored?.outcome).toBe("machineFault");
});

test("the run history shows a machine fault apart from a release, and marks only the fault badly", async ({
  page,
  request,
}) => {
  const faulted = await postRun(
    request,
    "machineFault",
    HELD_TASK_ID,
    HELD_TASK_KEY,
    "this machine has no sandbox"
  );
  expect(faulted.status(), await faulted.text()).toBe(201);
  const released = await postRun(
    request,
    "released",
    SIBLING_TASK_ID,
    SIBLING_TASK_KEY,
    "usage limit reached"
  );
  expect(released.status(), await released.text()).toBe(201);

  await signIn(page);
  await page.goto("/settings/workers/runs");
  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();

  const faultRow = page.locator("tr", { hasText: HELD_TASK_KEY }).first();
  const releaseRow = page.locator("tr", { hasText: SIBLING_TASK_KEY }).first();

  // The two words, not one word twice — the whole point of recording them apart
  await expect(faultRow.getByText("Machine fault")).toBeVisible();
  await expect(releaseRow.getByText("Released")).toBeVisible();
  await expect(faultRow.getByText("Released")).toHaveCount(0);

  // And the colour, which is what an operator scanning the column actually reads. The class is
  // asserted rather than the computed colour: text-danger and text-success are the two tokens the
  // page picks between, and a screenshot cannot say which branch ran.
  await expect(faultRow.locator("td.text-danger")).toHaveCount(1);
  await expect(releaseRow.locator("td.text-success")).toHaveCount(1);
});
