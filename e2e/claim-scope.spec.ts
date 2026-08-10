import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { changeStatus, claimNextTask, releaseTask } from "@/lib/task-service";
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
 */

const APPROVED = "todo";
const ACTIVE = "in_progress";
const IDENTITY = String(ADMIN_ID);
const WORKER = "w-claim-scope";

// The worker's own connection, kept apart from the one connectDB caches for the service under test
async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function setScope(scope: "assigned" | "any") {
  const handle = await db();
  await handle
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $set: { "worker.policy.claimScope": scope } });
}

let nextNumber = 900;

async function addTask(over: Record<string, unknown> = {}): Promise<mongoose.Types.ObjectId> {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  await handle.collection("tasks").insertOne({
    _id,
    project: PROJECT_ID,
    taskNumber: nextNumber++,
    title: `claim scope ${nextNumber}`,
    description: "",
    priority: "medium",
    category: "user-story",
    status: APPROVED,
    assignee: null,
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

test.describe("claimScope: assigned", () => {
  test("an approved column full of unassigned work is left alone", async () => {
    await setScope("assigned");
    const untouched = await addTask();
    await addTask();
    await addTask();

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY)).toBeNull();
    expect((await read(untouched)).status).toBe(APPROVED);
  });

  test("a task handed to the worker is taken, and stays handed to it", async () => {
    await setScope("assigned");
    const handed = await addTask({ assignee: ADMIN_ID });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY);
    expect(String(claimed?._id)).toBe(String(handed));

    const after = await read(handed);
    expect(after.status).toBe(ACTIVE);
    expect(after.assignee).toBe(IDENTITY);
    // The claim did not put it there, and the release is about to depend on knowing that
    expect(after.execution.assignedByRun).toBe(false);
  });

  test("a task parked for somebody else is not taken", async () => {
    await setScope("assigned");
    await addTask({ assignee: MEMBER_ID });

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY)).toBeNull();
  });

  test("a worker with no identity user claims nothing rather than everything", async () => {
    await setScope("assigned");
    await addTask();
    await addTask({ assignee: ADMIN_ID });

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", null)).toBeNull();
  });
});

test.describe("claimScope: any", () => {
  test("an unassigned task is taken and assigned to the worker", async () => {
    await setScope("any");
    const free = await addTask();

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY);
    expect(String(claimed?._id)).toBe(String(free));

    const after = await read(free);
    expect(after.assignee).toBe(IDENTITY);
    expect(after.execution.assignedByRun).toBe(true);
  });

  // What CLAUDE.md has always described — "assigned to claude or unassigned" — and what the code
  // did not do: before this, an explicit hand-over was the one thing a worker would not pick up
  test("a task handed to the worker is taken too", async () => {
    await setScope("any");
    const handed = await addTask({ assignee: ADMIN_ID, order: 5 });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY);
    expect(String(claimed?._id)).toBe(String(handed));
  });

  test("a task parked for a person is still not taken", async () => {
    await setScope("any");
    await addTask({ assignee: MEMBER_ID });

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY)).toBeNull();
  });
});

test.describe("releasing gives back exactly what the claim took", () => {
  test("a hand-over survives the release, so the task can be retried", async () => {
    await setScope("assigned");
    const handed = await addTask({ assignee: ADMIN_ID });

    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY);
    await releaseTask(String(PROJECT_ID), String(handed));

    const after = await read(handed);
    expect(after.status).toBe(APPROVED);
    // The whole point. Blanking this would drop the task out of what the worker may claim, and
    // nothing would ever pick it up again — a silent loss of work rather than a failure.
    expect(after.assignee).toBe(IDENTITY);

    const again = await claimNextTask(String(PROJECT_ID), WORKER, "run-2", IDENTITY);
    expect(String(again?._id)).toBe(String(handed));
  });

  test("an assignment the claim invented does not survive it", async () => {
    await setScope("any");
    const free = await addTask();

    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY);
    await releaseTask(String(PROJECT_ID), String(free));

    const after = await read(free);
    expect(after.status).toBe(APPROVED);
    // Left assigned, the task would be parked forever on a machine that is not running it
    expect(after.assignee).toBeNull();
  });

  test("assigning a finished task and then moving it keeps the assignment", async () => {
    await setScope("any");
    const free = await addTask();
    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", IDENTITY);
    await releaseTask(String(PROJECT_ID), String(free));

    // workerId is deliberately left behind as history, so this is a task that looks worked-on and
    // is not. Assign it, move it: the ordinary path a person takes.
    const handle = await db();
    await handle.collection("tasks").updateOne({ _id: free }, { $set: { assignee: ADMIN_ID } });
    expect((await read(free)).execution.workerId).toBe(WORKER);

    const moved = await changeStatus(String(PROJECT_ID), String(free), ACTIVE, String(ADMIN_ID));
    expect(moved.ok).toBe(true);

    expect((await read(free)).assignee).toBe(IDENTITY);
  });
});

/**
 * The setting also has to be reachable, because a safe default nobody can widen is a broken
 * product rather than a safe one — and a route that moved role while its component still gated on
 * `isAdmin` is a mistake this repo has made more than once.
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
    await expect(page.getByText("Nothing is picked up until you assign a task")).toBeVisible();

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
})
