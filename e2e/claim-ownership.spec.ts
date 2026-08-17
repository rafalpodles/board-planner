import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { changeStatus, claimNextTask, releaseTask, updateTask } from "@/lib/task-service";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  MEMBER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  seed,
} from "./seed";

/**
 * BP-240. These run against a real MongoDB rather than through a browser, because what is under
 * test is an aggregation expression and nothing else can judge one.
 *
 * `CLEAR_WORKER_ASSIGNEE` decides whether releasing a task hands the assignment back or blanks it,
 * and the unit tests next to it compare the expression object to a literal — which proves the
 * source was copied into the test, not that MongoDB reads it the way the comment claims. The last
 * bug of exactly this shape reached production: `""` is falsy in JavaScript and truthy in Mongo's
 * `$cond`, and a suite full of shape assertions never noticed.
 *
 * So: real documents, real updates, and assertions on what is in the collection afterwards.
 *
 * BP-358 renamed this file from claim-scope.spec.ts: the claim no longer reads a project-wide
 * scope/nominee pair, so there is nothing left called "claim scope" to be a spec about. What
 * decides a claim now is the machine's owner — `{ assignee: ownerId, assignedBy: ownerId }` — or
 * the identity of a run it is resuming, and an agent naming the hand-over. The settings-screen
 * describe at the bottom is the one part left untouched: that UI and the schema field behind it
 * still exist, unread by anything now, until the settings-removal task deletes them — this file
 * only rewrites what actually changed.
 */

const APPROVED = "todo";
const ACTIVE = "in_progress";
// Two different accounts on purpose, because they are two different things in production: OWNER is
// the person this machine belongs to — a claim only ever takes a task that person assigned to
// themselves — IDENTITY is the worker's own `worker-<id>` machine account, which a resumed run's
// own claim still has to find again.
const OWNER = ADMIN_ID;
const IDENTITY = "6a70afff45d39cd9bc8bb5ff";
const WORKER = "w-claim-ownership";
// Claim nothing but agent presence, and never resolved — snapshotFor's job starts one layer up, at
// the route this file does not go through
const AGENT_ID = new mongoose.Types.ObjectId();

// The worker's own connection, kept apart from the one connectDB caches for the service under test
async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

let nextNumber = 900;

async function addTask(over: Record<string, unknown> = {}): Promise<mongoose.Types.ObjectId> {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  await handle.collection("tasks").insertOne({
    _id,
    project: PROJECT_ID,
    taskNumber: nextNumber++,
    title: `claim ownership ${nextNumber}`,
    description: "",
    priority: "medium",
    category: "user-story",
    status: APPROVED,
    // Satisfies every clause of the claim filter by default, so a test that overrides one field is
    // about that field and nothing else — same reasoning as task-service.test.ts's task() fixture,
    // now checked against a real query engine instead of sift.
    assignee: OWNER,
    assignedBy: OWNER,
    agent: AGENT_ID,
    checklist: [],
    linkedPRs: [],
    blockedBy: [],
    relations: [],
    watchers: [],
    customFieldValues: {},
    order: 0,
    createdBy: ADMIN_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  return _id;
}

async function read(taskId: mongoose.Types.ObjectId) {
  const handle = await db();
  const task = await handle.collection("tasks").findOne({ _id: taskId });
  return {
    status: task?.status as string,
    assignee: task?.assignee ? String(task.assignee) : null,
    // The BSON type, not the value. Mongoose casts a plain $set against the schema and does not
    // cast an update pipeline at all, so the claim once wrote a raw string into an ObjectId ref —
    // which populate still renders, and String() on either side compares equal.
    assigneeType: task?.assignee?._bsontype ?? typeof task?.assignee,
    execution: (task?.execution ?? {}) as Record<string, unknown>,
  };
}

test.beforeEach(async () => {
  await seed();
  // connectDB reads this when it is called, not when the module loads, so setting it here is in
  // time for the service functions imported above
  process.env.MONGODB_URI = E2E_MONGODB_URI;

  // The seed leaves its own work in the approved column, and a claim takes the first card by board
  // order — so without this every "it took the right one" assertion would really be reading a task
  // the test never wrote
  const handle = await db();
  await handle.collection("tasks").deleteMany({ project: PROJECT_ID, status: APPROVED });
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test.describe("what a claim requires", () => {
  test("an approved column full of unassigned work is left alone", async () => {
    const untouched = await addTask({ assignee: null, assignedBy: null, agent: null });
    await addTask({ assignee: null, assignedBy: null, agent: null });
    await addTask({ assignee: null, assignedBy: null, agent: null });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY, String(OWNER))
    ).toBeNull();
    expect((await read(untouched)).status).toBe(APPROVED);
  });

  test("a task the owner assigned to themselves is taken, and stays assigned to them", async () => {
    const handed = await addTask();

    const claimed = await claimNextTask(
      String(PROJECT_ID),
      WORKER,
      "run-1",
      IDENTITY,
      String(OWNER)
    );
    expect(String(claimed?._id)).toBe(String(handed));

    const after = await read(handed);
    expect(after.status).toBe(ACTIVE);
    // Kept, not overwritten: the claim did not put this assignment there, so releasing it must not
    // take it away either
    expect(after.assignee).toBe(String(OWNER));
    expect(after.execution.assignedByRun).toBe(false);
  });

  test("a task assigned to somebody else is not taken", async () => {
    await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY, String(OWNER))
    ).toBeNull();
  });

  // Somebody else assigning you work is a proposal, and the surface for accepting one does not
  // exist yet — refused rather than run unattended, even though the assignee names the right person
  test("a task assigned to the owner by somebody else is not taken", async () => {
    await addTask({ assignee: OWNER, assignedBy: MEMBER_ID });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY, String(OWNER))
    ).toBeNull();
  });

  test("a worker with no identity user still takes what its owner assigned to themselves", async () => {
    await addTask({ assignee: null, assignedBy: null, agent: null });
    const handed = await addTask({ order: 5 });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", null, String(OWNER));
    expect(String(claimed?._id)).toBe(String(handed));
  });

  // The guard this whole task adds: real ids, a real query, and a real assertion that nothing in
  // the collection moved — not a mock recording whether it was asked to write. Genuinely unassigned,
  // not owner-assigned like the default: an owner-assigned fixture here would pass for the wrong
  // reason, since it could not match a wide-open filter either way.
  test("claims nothing for a machine whose owner is unset", async () => {
    const untouched = await addTask({ assignee: null, assignedBy: null });

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY, null)).toBeNull();
    expect((await read(untouched)).status).toBe(APPROVED);
  });
});

/**
 * BP-280. The unit tests judge the filter through sift, which compares JavaScript values — and
 * blockedBy holds ObjectIds, where the whole question is whether MongoDB reads `$nin` over an
 * array of refs the way the claim assumes. Only a real database answers that.
 */
test.describe("blockers", () => {
  const DONE = "done";

  test("a task whose blocker is still open is passed over", async () => {
    // The blocker sits outside the approved column, so the only thing the claim could take is the
    // blocked task — anything but null here means it took work that cannot start
    const blocker = await addTask({ status: "in_review", order: 1 });
    const blocked = await addTask({ blockedBy: [blocker], order: 2 });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY, String(OWNER))
    ).toBeNull();
    expect((await read(blocked)).status).toBe(APPROVED);
  });

  // The everyday shape this exists for: two cards in the approved column, one waiting on the other.
  // Here the guard has to beat the board order — the blocked card is the one the claim reaches first
  test("the blocker is taken first, against board order", async () => {
    const blocker = await addTask({ order: 2 });
    const blocked = await addTask({ blockedBy: [blocker], order: 1 });

    const claimed = await claimNextTask(
      String(PROJECT_ID),
      WORKER,
      "run-1",
      IDENTITY,
      String(OWNER)
    );

    expect(String(claimed?._id)).toBe(String(blocker));
    expect((await read(blocked)).status).toBe(APPROVED);
  });

  // A deleted column leaves its tasks naming no column at all. That is not "finished", and reading
  // it as finished would start work on a promise nothing can confirm
  test("a blocker orphaned by a deleted column still counts as unfinished", async () => {
    const blocker = await addTask({ status: "column_since_deleted", order: 1 });
    await addTask({ blockedBy: [blocker], order: 2 });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY, String(OWNER))
    ).toBeNull();
  });

  test("the unblocked sibling behind it is claimed instead", async () => {
    // Ordered ahead of the sibling, so claiming the sibling can only mean the blocked one was
    // skipped rather than merely sorted second
    const blocker = await addTask({ status: "in_review", order: 1 });
    const blocked = await addTask({ blockedBy: [blocker], order: 2 });
    const free = await addTask({ order: 3 });

    const claimed = await claimNextTask(
      String(PROJECT_ID),
      WORKER,
      "run-1",
      IDENTITY,
      String(OWNER)
    );

    expect(String(claimed?._id)).toBe(String(free));
    expect((await read(blocked)).status).toBe(APPROVED);
  });

  test("finishing the blocker makes the task claimable", async () => {
    const blocker = await addTask({ status: "in_review", order: 1 });
    const blocked = await addTask({ blockedBy: [blocker], order: 2 });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY, String(OWNER))
    ).toBeNull();

    const handle = await db();
    await handle.collection("tasks").updateOne({ _id: blocker }, { $set: { status: DONE } });

    const claimed = await claimNextTask(
      String(PROJECT_ID),
      WORKER,
      "run-2",
      IDENTITY,
      String(OWNER)
    );
    expect(String(claimed?._id)).toBe(String(blocked));
    expect((await read(blocked)).status).toBe(ACTIVE);
  });
});

test.describe("releasing gives back exactly what the claim took", () => {
  test("a hand-over survives the release, so the task can be retried", async () => {
    const handed = await addTask();

    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY, String(OWNER));
    await releaseTask(String(PROJECT_ID), String(handed));

    const after = await read(handed);
    expect(after.status).toBe(APPROVED);
    // The whole point. Blanking this would drop the task out of what the worker may claim, and
    // nothing would ever pick it up again — a silent loss of work rather than a failure.
    expect(after.assignee).toBe(String(OWNER));

    const again = await claimNextTask(String(PROJECT_ID), WORKER, "run-2", IDENTITY, String(OWNER));
    expect(String(again?._id)).toBe(String(handed));
  });

  // A claim can no longer invent an assignment — it only ever matches a task already self-assigned
  // by its owner — so this precondition has no live path through claimNextTask any more. Seeded
  // directly in the exact shape a claim used to leave one in: releaseTask's own logic reads the
  // flag on the document, not how the document got that way, so this is still the real thing under
  // test, only reached differently.
  test("an assignment the claim invented does not survive it", async () => {
    const free = await addTask({
      status: ACTIVE,
      assignee: IDENTITY,
      assignedBy: IDENTITY,
      execution: { workerId: WORKER, runId: "run-1", assignedByRun: true, attempts: 1 },
    });

    await releaseTask(String(PROJECT_ID), String(free));

    const after = await read(free);
    expect(after.status).toBe(APPROVED);
    // Left assigned, the task would be parked forever on a machine that is not running it
    expect(after.assignee).toBeNull();
  });

  // The board drag goes through updateTask, the right-click menu through changeStatus. Both are
  // "moving a card" to the person doing it, and only one of them was fixed — a mutation reverting
  // updateTask passed the whole suite until this existed.
  test("dragging a finished task on the board keeps a fresh assignment", async () => {
    const free = await addTask();
    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY, String(OWNER));
    await releaseTask(String(PROJECT_ID), String(free));

    const handle = await db();
    await handle.collection("tasks").updateOne({ _id: free }, { $set: { assignee: OWNER } });

    // What handleTaskDrop sends: a status and a position, never a status alone
    const moved = await updateTask(
      String(PROJECT_ID),
      String(free),
      { status: ACTIVE, order: 3 },
      String(ADMIN_ID)
    );
    expect(moved.ok).toBe(true);

    expect((await read(free)).assignee).toBe(String(OWNER));
  });

  // Taking a task off a live worker is a person's decision, and it must give back exactly what the
  // claim took: the hand-over stays, so the task is still claimable and gets retried
  test("forcing a held task off a worker keeps the hand-over", async () => {
    const handed = await addTask();
    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY, String(OWNER));

    const forced = await updateTask(
      String(PROJECT_ID),
      String(handed),
      { status: APPROVED, order: 1 },
      String(ADMIN_ID),
      true
    );
    expect(forced.ok).toBe(true);

    const after = await read(handed);
    expect(after.assignee).toBe(String(OWNER));
    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-2", IDENTITY, String(OWNER))
    ).not.toBeNull();
  });

  // workerId as history with no live run: what a task looks like the moment after its run ends,
  // reached directly rather than through claim-then-release. A claim can no longer invent an
  // assignment, so a release can no longer take one away either, and this file has no other tool
  // left that reaches this precondition.
  test("assigning a finished task and then moving it keeps the assignment", async () => {
    const free = await addTask({
      assignee: null,
      assignedBy: null,
      execution: { workerId: WORKER, runId: "", attempts: 1 },
    });

    const handle = await db();
    await handle.collection("tasks").updateOne({ _id: free }, { $set: { assignee: OWNER } });
    expect((await read(free)).execution.workerId).toBe(WORKER);

    const moved = await changeStatus(String(PROJECT_ID), String(free), ACTIVE, String(ADMIN_ID));
    expect(moved.ok).toBe(true);

    expect((await read(free)).assignee).toBe(String(OWNER));
  });
});

/**
 * The setting also has to be reachable, because a safe default nobody can widen is a broken
 * product rather than a safe one — and a route that moved role while its component still gated on
 * `isAdmin` is a mistake this repo has made more than once.
 *
 * Untouched by BP-358: claimNextTask stopped reading this setting, but the schema field and this
 * screen are both still live until the settings-removal task deletes them, so an admin toggling
 * this control today still gets the persistence this describe verifies.
 */
test.describe("through the settings screen", () => {
  const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

  async function openWorkers(page: import("@playwright/test").Page) {
    // Without one the card refuses to offer the toggle at all — no machine can be matched to a
    // project that names no repository, and the hint under test lives on that toggle
    const handle = await db();
    await handle
      .collection("projects")
      .updateOne(
        { _id: PROJECT_ID },
        { $set: { repositoryUrl: "git@github.com:rafalpodles/board-planner.git" } }
      );

    await page.goto("/login");
    await page.getByLabel("Username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/projects/);
    await page.goto(SETTINGS);
    await page.getByRole("button", { name: "Workers", exact: true }).first().click();
    // By an option it contains, not by its text: a <select> renders no text of its own, so
    // hasText matches nothing however plainly the control reads on screen
    return page
      .getByRole("combobox")
      .filter({ has: page.getByRole("option", { name: "Only tasks assigned to the worker" }) });
  }

  test("an admin can read the scope and widen it, and the board keeps the choice", async ({
    page,
  }) => {
    const select = await openWorkers(page);
    await expect(select).toBeVisible();

    // The enable toggle's hint has to describe the scope, or it promises work will be picked up
    // that never will be
    await expect(page.getByText("Only tasks handed over below are picked up")).toBeVisible();

    await select.selectOption("any");
    await expect(page.getByText(/Any unassigned task in an approved column/)).toBeVisible();
    // Awaited, not merely clicked: the save bar closes on the committed draft, and reading the
    // collection off that alone raced the write and failed on a fix that was already correct
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/projects/") && r.request().method() === "PUT"
      ),
      page.getByRole("button", { name: "Save changes" }).click(),
    ]);
    await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();

    // Pinned, not merely equal to a default: a value that happens to match one cannot be told
    // apart from a value nobody chose
    const handle = await db();
    const project = await handle.collection("projects").findOne({ _id: PROJECT_ID });
    expect(project?.worker?.policy?.claimScope).toBe("any");
    expect(project?.worker?.policyOverrides).toContain("claimScope");
  });
});
