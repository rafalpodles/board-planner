import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  HELD_TASK_NUMBER,
  OWNER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  WORKER_NAME,
  seed,
} from "./seed";
import { signIn } from "./session";
import { ADMIN_AUTH, SAME_ORIGIN } from "./api";

/**
 * BP-381. The protected-paths gate says a human has to review the change and then makes reviewing
 * as hard as it can: `pipeline.ts` withholds the push for exactly that gate, so the work exists
 * only as a commit in a worktree on whichever machine claimed the task. Twice in one afternoon
 * good work went to sit on a laptop.
 *
 * This drives the reply end to end — the machine's own write on its own credential, the panel a
 * person reads, the button, and what the record says afterwards.
 */

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const DIGEST = "b".repeat(64);
const PATCH = 'diff --git a/package.json b/package.json\n+    "build": "next build"\n';
const taskHref = `/projects/${PROJECT_KEY}/tasks/${HELD_TASK_NUMBER}`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

/**
 * The seeded machine belongs to nobody, and `mayDecide` is keyed on its owner — a bar deliberately
 * above project membership, because accepting runs a hostile agent's change under that person's
 * pinned GitHub identity.
 */
async function ownedByTheProjectOwner() {
  const handle = await db();
  await handle.collection("workers").updateOne({ _id: WORKER_ID }, { $set: { owner: OWNER_ID } });
}

function workerHeaders() {
  return {
    Authorization: `Bearer ${WORKER_CREDENTIAL}`,
    "X-Worker-Id": String(WORKER_ID),
    "X-CP-Protocol": "1",
  };
}

function record(over: Record<string, unknown> = {}) {
  return {
    // The seeded held task carries a live run of this very worker, which is what the create route
    // filters on: a record says "this machine is holding this commit", and only a worker that
    // still holds the task can truthfully say so.
    taskId: String(HELD_TASK_ID),
    runId: "e2e-run-0001",
    gate: "protected-paths",
    files: ["package.json", "src/a.ts"],
    protectedFiles: ["package.json"],
    patch: PATCH,
    patchTruncated: false,
    patchSha256: DIGEST,
    commit: COMMIT,
    taskKey: HELD_TASK_KEY,
    title: "Held by a live worker run",
    acceptable: true,
    unacceptableReason: "",
    ...over,
  };
}

async function storedDecision() {
  const handle = await db();
  const task = await handle.collection("tasks").findOne({ _id: HELD_TASK_ID });
  return (task?.decision ?? null) as Record<string, unknown> | null;
}

/** What the machine reports once it has acted on the verdict. */
async function settleAs(state: string, prUrl = "") {
  const handle = await db();
  await handle
    .collection("tasks")
    .updateOne({ _id: HELD_TASK_ID }, { $set: { "decision.state": state, "decision.prUrl": prUrl } });
}

async function openTheTask(page: Page) {
  await page.goto(taskHref);
  // A positive assertion only a loaded task screen can satisfy, before anything below asks whether
  // something is absent. The title is an editable textarea rather than a heading, and it is the
  // one thing on the screen that comes from this task's own document.
  await expect(page.getByLabel("Task title")).toHaveValue(/Held by a live worker run/);
}

test.beforeEach(async () => {
  await seed();
  await ownedByTheProjectOwner();
});

test("the machine records the refusal on its own credential, and the board shows it", async ({
  page,
  request,
}) => {
  const created = await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: workerHeaders(),
    data: record(),
  });
  expect(created.status(), await created.text()).toBe(201);

  await signIn(page, "owner");
  await openTheTask(page);

  const panel = page.getByTestId("decision-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("decision-commit")).toHaveText(COMMIT.slice(0, 12));
  // The gate's hits are a subset; accepting pushes the commit, all of it
  await expect(page.getByTestId("decision-protected-files")).toContainText("package.json");
  await expect(page.getByTestId("decision-file-count")).toContainText("2 files");
  await expect(page.getByTestId("decision-patch")).toContainText('"build": "next build"');
  await expect(panel).toContainText(WORKER_NAME);
});

test("accepting says what it spends, and the record carries the verdict afterwards", async ({
  page,
  request,
}) => {
  await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: workerHeaders(),
    data: record(),
  });

  await signIn(page, "owner");
  await openTheTask(page);

  await page.getByRole("button", { name: "Accept and push" }).click();
  const dialog = page.getByRole("dialog");
  // The first draft of this design claimed nothing executes until somebody merges. It is false
  // here: CI is `on: push` with no branch filter, so the push alone is the trigger.
  await expect(dialog).toContainText("runs this repository's CI");
  // And whose name it spends, which is the other half of what accepting costs
  await expect(dialog).toContainText("your own GitHub identity");

  const answered = page.waitForResponse(
    (response) =>
      response.url().includes(`/tasks/${HELD_TASK_ID}/decision`) && response.request().method() === "POST"
  );
  await dialog.getByRole("button", { name: "Accept and push" }).click();
  expect((await answered).status()).toBe(200);

  await expect
    .poll(async () => (await storedDecision())?.state)
    .toBe("accepted");
  const stored = await storedDecision();
  expect(String(stored?.decidedBy)).toBe(String(OWNER_ID));
  // Nothing a person read may move: "you accepted this commit" has to go on meaning something
  expect(stored?.commit).toBe(COMMIT);
  expect(stored?.patchSha256).toBe(DIGEST);

  const handle = await db();
  const audited = await handle
    .collection("instanceauditlogs")
    .findOne({ action: "worker_decision_accepted" });
  expect(audited?.target).toBe(WORKER_NAME);
  expect(String(audited?.detail)).toContain(HELD_TASK_KEY);
});

/**
 * `sweepMarkers` treats a decision that has left the live list exactly as it treats a declined one:
 * the worktree goes. So giving up destroys the work, and the panel has to say so and ask — it was
 * the least emphatic control on the screen, named nothing, and asked nothing.
 */
test("giving up says it deletes the work, and asks before it does", async ({ page, request }) => {
  await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: workerHeaders(),
    data: record(),
  });

  await signIn(page, "owner");
  await openTheTask(page);

  await page.getByRole("button", { name: "Give up and delete the work" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("deletes the worktree");

  // Nothing is written until it is confirmed
  expect(await storedDecision().then((d) => d?.state)).toBe("pending");

  const answered = page.waitForResponse(
    (response) =>
      response.url().includes(`/tasks/${HELD_TASK_ID}/decision`) && response.request().method() === "POST"
  );
  await dialog.getByRole("button", { name: "Give up and delete" }).click();
  expect((await answered).status()).toBe(200);

  await expect.poll(async () => (await storedDecision())?.state).toBe("abandoned");
});

test("declining says so without a dialog, and is recorded", async ({ page, request }) => {
  await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: workerHeaders(),
    data: record(),
  });

  await signIn(page, "owner");
  await openTheTask(page);

  const answered = page.waitForResponse(
    (response) =>
      response.url().includes(`/tasks/${HELD_TASK_ID}/decision`) && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Decline and delete" }).click();
  expect((await answered).status()).toBe(200);

  await expect.poll(async () => (await storedDecision())?.state).toBe("declined");
});

/**
 * The panel used to carry one unconditional paragraph — "The branch was not pushed, on purpose…
 * The work is in a worktree on X" — under a headline that by then said "Pushed, and a pull request
 * is open". A sentence contradicting the line above it reads as a bug in the product.
 */
test("a settled record stops claiming the work is still in a worktree", async ({ page, request }) => {
  await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: workerHeaders(),
    data: record(),
  });
  await settleAs("delivered", "https://github.com/owner/repo/pull/42");

  await signIn(page, "owner");
  await openTheTask(page);

  await expect(page.getByTestId("decision-headline")).toContainText("pull request is open");
  await expect(page.getByTestId("decision-pr")).toHaveAttribute(
    "href",
    "https://github.com/owner/repo/pull/42"
  );
  // The control: the record is on screen, so the absence below is about this sentence and not
  // about a panel that failed to render
  await expect(page.getByTestId("decision-patch")).toBeVisible();
  await expect(page.getByTestId("decision-where-the-work-is")).toHaveCount(0);
  await expect(page.getByTestId("decision-file-count")).toHaveCount(0);
});

/**
 * The one family excluded on purpose. Not because workflow files are the line between "executes"
 * and "does not" — almost everything on the protected list executes — but because for a push event
 * GitHub runs the workflow from the pushed ref, so accepting one would run the agent's own CI.
 */
test("a change that edits what CI does is shown, explained, and cannot be accepted", async ({
  page,
  request,
}) => {
  await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: workerHeaders(),
    data: record({
      files: [".github/workflows/ci.yml"],
      protectedFiles: [".github/workflows/ci.yml"],
      acceptable: false,
      unacceptableReason: "the change edits what CI itself does (.github/workflows/ci.yml).",
    }),
  });

  await signIn(page, "owner");
  await openTheTask(page);

  await expect(page.getByTestId("decision-unacceptable")).toContainText(".github/workflows/ci.yml");
  await expect(page.getByRole("button", { name: "Accept and push" })).toHaveCount(0);
  // The control: the work must not be stuck on that laptop either way
  await expect(page.getByRole("button", { name: "Decline and delete" })).toBeVisible();

  // SAME_ORIGIN because Playwright's request context sends no Origin and the provenance check is
  // fail-closed — without it every refusal below would be that 403 rather than the one under test
  const refused = await page.request.post(
    `/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/decision`,
    { headers: SAME_ORIGIN, data: { verdict: "accept" } }
  );
  expect(refused.status()).toBe(409);
  expect(await refused.text()).toContain("CI itself does");
  expect(await storedDecision().then((d) => d?.state)).toBe("pending");
});

test("a project member who does not own the machine is offered nothing, and refused if they ask", async ({
  page,
  request,
}) => {
  await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: workerHeaders(),
    data: record(),
  });

  await signIn(page, "member");
  await openTheTask(page);

  // They can read it — the control for the assertion below, which would pass on a blank screen
  await expect(page.getByTestId("decision-patch")).toBeVisible();
  await expect(page.getByTestId("decision-not-yours")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept and push" })).toHaveCount(0);

  const refused = await page.request.post(
    `/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/decision`,
    { headers: SAME_ORIGIN, data: { verdict: "accept" } }
  );
  expect(refused.status()).toBe(403);
  // Named, not just counted: the provenance check answers 403 too, and a bare status cannot tell
  // this refusal from that one
  expect(await refused.text()).toContain("instance admin");
  expect(await storedDecision().then((d) => d?.state)).toBe("pending");
});

/**
 * An unattended agent must not take work off a machine, and must not authorise a push under
 * somebody's GitHub identity either. Driven on the real route with a real machine credential,
 * because that is the door a unit test of the handler cannot prove is shut.
 */
test("a machine credential cannot answer, however much access it has", async ({ request }) => {
  await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: workerHeaders(),
    data: record(),
  });

  // An instance-admin API token: every door on this board is open to it, and this one is not
  const refused = await request.post(
    `/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/decision`,
    { headers: ADMIN_AUTH, data: { verdict: "accept" } }
  );
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toContain("interactive session");
  expect(await storedDecision().then((d) => d?.state)).toBe("pending");
});

test("the machine is told what is waiting on it, on the refresh it already makes", async ({
  request,
}) => {
  await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: workerHeaders(),
    data: record(),
  });

  const state = await request.get(`/api/workers/${WORKER_ID}`, { headers: workerHeaders() });
  expect(state.status()).toBe(200);
  const body = await state.json();

  expect(body.decisions).toEqual([
    {
      taskId: String(HELD_TASK_ID),
      projectId: String(PROJECT_ID),
      taskKey: HELD_TASK_KEY,
      title: "Held by a live worker run",
      commit: COMMIT,
      patchSha256: DIGEST,
      state: "pending",
      attempts: 0,
    },
  ]);
});

/**
 * The board loads every task, and a refused change carries the whole patch — up to 200 KB per
 * card, to every member, on every poll.
 */
test("the board's task list does not carry the patch", async ({ request }) => {
  await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: workerHeaders(),
    data: record(),
  });

  const list = await request.get(`/api/projects/${PROJECT_ID}/tasks`, { headers: ADMIN_AUTH });
  expect(list.status(), await list.text()).toBe(200);
  const tasks = (await list.json()) as { _id: string; decision?: unknown }[];

  // The control: the record really is there, on the very task this list carries
  expect(await storedDecision()).not.toBeNull();
  expect(tasks.some((task) => task._id === String(HELD_TASK_ID))).toBe(true);
  for (const task of tasks) expect(task.decision).toBeUndefined();
});
