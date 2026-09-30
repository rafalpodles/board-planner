import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  PROJECT_ID,
  SOURCE_COLUMN,
  TARGET_COLUMN,
  WORKER_CREDENTIAL,
  WORKER_ID,
  WORKER_NAME,
  seed,
} from "./seed";

/**
 * BP-350. `changeStatus` refuses any status change that leaves the column while a run holds the
 * task — right for a person dragging a card away from a machine, wrong for the machine's own
 * report of the run ending. `worker/src/reporter.ts`'s `report()` is a comment, then a move, for
 * every terminal outcome that lands in a column: blocked, gateRejected, failed, delivered, merged.
 * Refusing the holder's own report meant that move always came back 409, the outbox retried it
 * forever, and a delivered or merged run sat in the active column for the full two-hour lease.
 *
 * `byItsHolder` in `src/lib/task-service.ts` already exempts the run's own holder — this file is
 * the coverage the bug's own writeup said did not exist: nothing drove a real worker credential
 * against the real route. `run-conflict.spec.ts` covers the refusal side, through a browser, as a
 * person; this covers the side a person cannot reach at all — the machine's own report — through
 * its own real HTTP call.
 *
 * The seeded worker (`WORKER_ID`/`WORKER_CREDENTIAL`) carries no `identity` by default — nothing
 * before this needed one — but `withProjectAccessOrWorker` refuses any machine with none, so both
 * `PATCH .../status` and `POST .../comments` 403 before ever reaching the guard under test. Each
 * `beforeEach` below gives the worker a real machine identity, the same shape `ensureWorkerUser`
 * produces, and undoes nothing else the shared seed set up.
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

async function readTask(taskId: mongoose.Types.ObjectId) {
  const handle = await db();
  return handle.collection("tasks").findOne({ _id: taskId });
}

function workerHeaders(workerId: string, credential: string) {
  return {
    Authorization: `Bearer ${credential}`,
    "X-Worker-Id": workerId,
    "X-CP-Protocol": "1",
  };
}

test.beforeEach(async () => {
  await seed();
  await giveWorkerAnIdentity(WORKER_ID, "worker-run-completion");
});

test("the run's own holder reports its outcome the way the worker actually does — comment, then move", async ({
  request,
}) => {
  // Mirrors worker/src/reporter.ts's report(): a comment naming the outcome, then the status move.
  // Both go through the same guard, and both used to 409 for the holder.
  const commented = await request.post(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/comments`, {
    headers: workerHeaders(String(WORKER_ID), WORKER_CREDENTIAL),
    data: { body: "Delivered — PR opened." },
  });
  expect(commented.status(), await commented.text()).toBe(201);

  const moved = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/status`, {
    headers: workerHeaders(String(WORKER_ID), WORKER_CREDENTIAL),
    data: { status: TARGET_COLUMN.id },
  });
  expect(moved.status(), await moved.text()).toBe(200);

  const stored = await readTask(HELD_TASK_ID);
  expect(stored?.status).toBe(TARGET_COLUMN.id);
  // Cleared, not merely ignored — the exemption still runs the same $unset the guard stands in
  // front of, it just stops refusing it. changeStatus removes the key entirely (an aggregation
  // $unset), rather than blanking it, so its absence is what "cleared" means here.
  expect(stored?.execution?.runId).toBeUndefined();
});

// The control: the same guard has to still refuse somebody who is not the run's own holder, or the
// exemption above is not an exemption at all — it is the guard doing nothing. A second worker that
// serves the project clears the outer "assigned" gate, which is the case that separates "the
// holder" from "any worker". Holding a run of its own elsewhere on the board used to be enough to
// clear it too; since BP-758 that reaches only the task held, so it is refused before the guard.
test("a different worker serving the project is still refused the first worker's task", async ({
  request,
}) => {
  const otherWorkerId = new mongoose.Types.ObjectId();
  const otherCredential = "e2e-other-worker-credential";
  const handle = await db();
  const repository = "https://github.com/e2e/run-completion";
  await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { repositoryUrl: repository } });

  await handle.collection("workers").insertOne({
    _id: otherWorkerId,
    name: "e2e-other-worker",
    host: "e2e-host",
    platform: "darwin",
    version: "0.0.0-e2e",
    protocolVersion: 1,
    credentialHash: bcrypt.hashSync(otherCredential, 10),
    repos: [{ remote: `${repository}.git`, path: "/Users/someone/run-completion" }],
    owner: ADMIN_ID,
    policy: { pollIntervalMs: 30_000 },
    policyOverrides: [],
    enabled: true,
    lastSeenAt: new Date(),
    identity: null,
    bindingError: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await giveWorkerAnIdentity(otherWorkerId, "worker-run-completion-other");

  const moved = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/status`, {
    headers: workerHeaders(String(otherWorkerId), otherCredential),
    data: { status: TARGET_COLUMN.id },
  });

  expect(moved.status()).toBe(409);
  const body = await moved.json();
  expect(body.error).toContain(HELD_TASK_KEY);
  expect(body.error).toContain(WORKER_NAME);

  const stored = await readTask(HELD_TASK_ID);
  expect(stored?.status).toBe(SOURCE_COLUMN.id);
  expect(stored?.execution?.runId).toBe("e2e-run-0001");
});
