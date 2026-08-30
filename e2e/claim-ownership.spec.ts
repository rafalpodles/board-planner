import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { changeStatus, claimNextTask, releaseTask, updateTask } from "@/lib/task-service";
// Statically, though nothing here calls it: `agentUsableOnProject` reaches this model through a
// dynamic import, and under Playwright's loader that resolves the model but not the `@/types` it
// imports. Naming it here puts it in the module cache first, resolved the ordinary way.
import "@/models/agent";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  MEMBER_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  seed,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";

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
 * decides a claim now is the machine's owner — `{ assignee: ownerId, assignedBy: ownerId }` — and
 * an agent naming the hand-over.
 *
 * The settings screen that used to configure the scope and the nominee is gone with them —
 * WorkersSection.test.tsx pins what replaced it (the enable switch and its hint), and
 * e2e/instance-audit.spec.ts already drives that same switch through a real page and a real save.
 * Nothing project-wide is left here to be a settings spec about either.
 */

const APPROVED = "todo";
const ACTIVE = "in_progress";
// Two different accounts on purpose, because they are two different things in production: OWNER is
// the person this machine belongs to — a claim only ever takes a task that person assigned to
// themselves — IDENTITY is the worker's own `worker-<id>` machine account, which the claim
// deliberately no longer matches on, and which only appears here in a document the older code left.
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

// A task exactly as it sits in a database that predates BP-358: the KEY IS ABSENT, which is what
// `assignedBy: null` is not — a missing field and a null both fail an ObjectId equality, but only
// the missing one is what an old document actually looks like, and only it survives a writer that
// starts defaulting the field.
async function addLegacyTask(over: Record<string, unknown> = {}): Promise<mongoose.Types.ObjectId> {
  const _id = await addTask(over);
  const handle = await db();
  await handle.collection("tasks").updateOne({ _id }, { $unset: { assignedBy: "" } });
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
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();
    expect((await read(untouched)).status).toBe(APPROVED);
  });

  test("a task the owner assigned to themselves is taken, and stays assigned to them", async () => {
    const handed = await addTask();

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));
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
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();
  });

  // Somebody else assigning you work is a proposal, and the surface for accepting one does not
  // exist yet — refused rather than run unattended, even though the assignee names the right person
  test("a task assigned to the owner by somebody else is not taken", async () => {
    await addTask({ assignee: OWNER, assignedBy: MEMBER_ID });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();
  });

  test("unassigned work in the column does not hide the one task that was handed over", async () => {
    await addTask({ assignee: null, assignedBy: null, agent: null });
    const handed = await addTask({ order: 5 });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));
    expect(String(claimed?._id)).toBe(String(handed));
  });

  // A task assigned to the worker's own `worker-<id>` account used to be claimable, so that a run
  // could resume one its own older claim had assigned. Under BP-358 a release keeps the person's
  // assignment, so nothing needs resuming that way — and the branch was a hole: anyone who can
  // reach the API can assign to a machine account, and that ran unattended with no assignedBy
  // check at all, which is the shape of BP-345.
  test("a task assigned to the machine's own identity is not taken", async () => {
    await addTask({ assignee: IDENTITY, assignedBy: IDENTITY });

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))).toBeNull();
  });

  // The guard this whole task adds: real ids, a real query, and a real assertion that nothing in
  // the collection moved — not a mock recording whether it was asked to write. Genuinely unassigned,
  // not owner-assigned like the default: an owner-assigned fixture here would pass for the wrong
  // reason, since it could not match a wide-open filter either way.
  test("claims nothing for a machine whose owner is unset", async () => {
    const untouched = await addTask({ assignee: null, assignedBy: null });

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", null)).toBeNull();
    expect((await read(untouched)).status).toBe(APPROVED);
  });
});

/**
 * Every task stored before this branch has no `assignedBy` key, and the deliberate decision is that
 * nothing claims one: the field answers "did this person hand this to themselves", the document
 * does not record it, and guessing converts work somebody else handed you into work you handed
 * yourself. There is no backfill. The way back is the ordinary gesture — assign it — which is the
 * same write the migration off the old project-wide nominee already requires.
 *
 * Real documents rather than sift, because "a missing key never equals an ObjectId" is a claim
 * about MongoDB, and the fixture has to be the absence rather than a null standing in for one.
 */
test.describe("a task from before assignedBy existed", () => {
  test("is not claimed, even though its assignee is the machine's owner", async () => {
    const legacy = await addLegacyTask();

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))).toBeNull();
    expect((await read(legacy)).status).toBe(APPROVED);
  });

  // The fixture is only meaningful if the key really is absent: a `null` would also fail the
  // filter, so the test above would pass either way and prove nothing about old documents.
  test("really has no assignedBy key at all, not a null one", async () => {
    const legacy = await addLegacyTask();
    const handle = await db();

    const stored = await handle.collection("tasks").findOne({ _id: legacy });
    expect("assignedBy" in (stored ?? {})).toBe(false);
  });

  // Driven through the real writer, not by setting the field: what has to be true is that the
  // product's own everyday gesture repairs it, and a hand-written $set could not show that.
  test("becomes claimable once its assignee takes it on, through the ordinary write", async () => {
    const legacy = await addLegacyTask();

    const assigned = await updateTask(
      String(PROJECT_ID),
      String(legacy),
      { assignee: ADMIN_USERNAME },
      String(OWNER)
    );
    expect(assigned.ok).toBe(true);

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));
    expect(String(claimed?._id)).toBe(String(legacy));
  });

  /**
   * The other writers of the same field. The PM agent, MCP under a second account and any REST
   * client that GETs a task and PUTs the whole object back all send `assignee` unchanged — and
   * stamping themselves would replace "nobody recorded it" with a definite "somebody else handed
   * you this". The claim refuses both, but only the first is repairable: once a name is stored, the
   * owner re-selecting themselves changes nothing, and the notice for that state offers no remedy.
   *
   * Against a real document because the condition is the ABSENCE of the key, which a mock's
   * `undefined` stands in for a little too willingly.
   */
  test("is not adopted by a third writer that merely echoes its assignee", async () => {
    const legacy = await addLegacyTask();

    const echoed = await updateTask(
      String(PROJECT_ID),
      String(legacy),
      { assignee: ADMIN_USERNAME, title: "renamed by somebody else" },
      String(MEMBER_ID)
    );
    expect(echoed.ok).toBe(true);

    const handle = await db();
    const stored = await handle.collection("tasks").findOne({ _id: legacy });
    expect(stored?.assignedBy ?? null).toBeNull();
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))).toBeNull();
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
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();
    expect((await read(blocked)).status).toBe(APPROVED);
  });

  // The everyday shape this exists for: two cards in the approved column, one waiting on the other.
  // Here the guard has to beat the board order — the blocked card is the one the claim reaches first
  test("the blocker is taken first, against board order", async () => {
    const blocker = await addTask({ order: 2 });
    const blocked = await addTask({ blockedBy: [blocker], order: 1 });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));

    expect(String(claimed?._id)).toBe(String(blocker));
    expect((await read(blocked)).status).toBe(APPROVED);
  });

  // A deleted column leaves its tasks naming no column at all. That is not "finished", and reading
  // it as finished would start work on a promise nothing can confirm
  test("a blocker orphaned by a deleted column still counts as unfinished", async () => {
    const blocker = await addTask({ status: "column_since_deleted", order: 1 });
    await addTask({ blockedBy: [blocker], order: 2 });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();
  });

  test("the unblocked sibling behind it is claimed instead", async () => {
    // Ordered ahead of the sibling, so claiming the sibling can only mean the blocked one was
    // skipped rather than merely sorted second
    const blocker = await addTask({ status: "in_review", order: 1 });
    const blocked = await addTask({ blockedBy: [blocker], order: 2 });
    const free = await addTask({ order: 3 });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));

    expect(String(claimed?._id)).toBe(String(free));
    expect((await read(blocked)).status).toBe(APPROVED);
  });

  test("finishing the blocker makes the task claimable", async () => {
    const blocker = await addTask({ status: "in_review", order: 1 });
    const blocked = await addTask({ blockedBy: [blocker], order: 2 });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();

    const handle = await db();
    await handle.collection("tasks").updateOne({ _id: blocker }, { $set: { status: DONE } });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-2", String(OWNER));
    expect(String(claimed?._id)).toBe(String(blocked));
    expect((await read(blocked)).status).toBe(ACTIVE);
  });
});

test.describe("releasing gives back exactly what the claim took", () => {
  test("a hand-over survives the release, so the task can be retried", async () => {
    const handed = await addTask();

    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));
    await releaseTask(String(PROJECT_ID), String(handed));

    const after = await read(handed);
    expect(after.status).toBe(APPROVED);
    // The whole point. Blanking this would drop the task out of what the worker may claim, and
    // nothing would ever pick it up again — a silent loss of work rather than a failure.
    expect(after.assignee).toBe(String(OWNER));

    const again = await claimNextTask(String(PROJECT_ID), WORKER, "run-2", String(OWNER));
    expect(String(again?._id)).toBe(String(handed));
  });

  // A claim can no longer invent an assignment — it only ever matches a task already self-assigned
  // by its owner — so this precondition is reachable only by a run the older code claimed and that
  // is still in flight across the deploy. Seeded directly in the exact shape that claim left one
  // in: releaseTask reads the flag on the document, not how the document got that way, so this is
  // still the real thing under test, only reached differently.
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
    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));
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
    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));

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
      await claimNextTask(String(PROJECT_ID), WORKER, "run-2", String(OWNER))
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
 * BP-358 final round. Choosing a task's agent stopped being an instance-admin act because the claim
 * routes work to the machine of whoever assigned the task to themselves — but the person choosing
 * the agent need not be that person, and authoring a PERSONAL agent takes nothing at all
 * (`POST /api/agents` requires project-admin only for a project-scoped one). So a member could
 * compose `merge` with no review gate ahead of it and point a colleague's self-assigned task at it.
 *
 * Real Agent documents against a real query engine, because the rule is a join between two
 * collections and the unit suite mocks one of them.
 */
test.describe("whose task a personal agent may go on", () => {
  const MINE = new mongoose.Types.ObjectId();
  const PROJECTS = new mongoose.Types.ObjectId();
  // Seeded only by the test that needs it: an agent belonging to the person a task is handed TO is
  // the case that separates "the new assignee owns it" from "the actor owns it"
  const THEIRS = new mongoose.Types.ObjectId();
  const RUNNABLE = { analysis: [], implementation: [{ key: "write-the-change" }], verification: [], delivery: [] };

  test.beforeEach(async () => {
    const handle = await db();
    await handle.collection("agents").deleteMany({ _id: { $in: [MINE, PROJECTS, THEIRS] } });
    await handle.collection("agents").insertMany([
      // The member's own, composed by them, vetted by nobody
      { _id: MINE, name: "Member's own", description: "", scope: "user", owner: MEMBER_ID, project: null, composition: RUNNABLE, builtIn: false },
      // The board's, which only a project admin can add
      { _id: PROJECTS, name: "The project's", description: "", scope: "project", owner: null, project: PROJECT_ID, composition: RUNNABLE, builtIn: false },
    ]);
  });

  /** The real route, under a real credential — the seam a direct service call steps over */
  function put(
    request: APIRequestContext,
    taskId: mongoose.Types.ObjectId,
    data: Record<string, unknown>,
    auth: Record<string, string>
  ) {
    return request.put(`/api/projects/${PROJECT_ID}/tasks/${taskId}`, { headers: auth, data });
  }

  const signIn = (page: Page, username: string, password: string) =>
    username === ADMIN_USERNAME
      ? arriveSignedIn(page)
      : username === MEMBER_USERNAME
        ? arriveSignedIn(page, "member")
        : signInThroughForm(page, username, password);

  test("goes on its owner's own task, and that owner's machine takes it", async () => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: null });

    const chosen = await updateTask(
      String(PROJECT_ID),
      String(own),
      { agent: String(MINE) },
      String(MEMBER_ID)
    );

    expect(chosen.ok).toBe(true);
    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(MEMBER_ID))
    ).not.toBeNull();
  });

  // The hole this round closes: the task is the admin's, the agent is the member's, and the machine
  // it would have reached is the admin's
  test("is refused on a colleague's self-assigned task, and nothing is written", async () => {
    const theirs = await addTask({ assignee: ADMIN_ID, assignedBy: ADMIN_ID, agent: null });

    const chosen = await updateTask(
      String(PROJECT_ID),
      String(theirs),
      { agent: String(MINE) },
      String(MEMBER_ID)
    );

    expect(chosen.ok).toBe(false);
    expect((chosen as { error: string }).error).toMatch(/personal agent/i);
    const handle = await db();
    expect((await handle.collection("tasks").findOne({ _id: theirs }))?.agent).toBeNull();
    // …and with no agent on it there is nothing for the colleague's machine to take
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))).toBeNull();
  });

  // The other half of the same decision: what the PROJECT sanctioned still goes anywhere the
  // project's work goes, which is what keeps the bar down rather than putting it back
  test("a project's own agent goes on a colleague's task, and their machine takes it", async () => {
    const theirs = await addTask({ assignee: ADMIN_ID, assignedBy: ADMIN_ID, agent: null });

    const chosen = await updateTask(
      String(PROJECT_ID),
      String(theirs),
      { agent: String(PROJECTS) },
      String(MEMBER_ID)
    );

    expect(chosen.ok).toBe(true);
    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))
    ).not.toBeNull();
  });

  /**
   * The residue the round before this one reported, closed. Handing a task away did NOT re-check
   * the agent already on it — the check runs on the writer of `agent`, and this write does not name
   * that field — so the member's personal agent stayed on a task that was now the admin's. The
   * claim's other half hid it for exactly one gesture (this write stamps `assignedBy` as the
   * member), and stopped hiding it on the next.
   *
   * "An agent is the hand-over" is the design's own sentence, so this is a NEW hand-over and the
   * old agent has no standing on it. The test that used to pin the surviving agent is this one,
   * rewritten rather than deleted.
   */
  test("does not survive a hand-over to somebody who could not have chosen it", async () => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: null });
    await updateTask(String(PROJECT_ID), String(own), { agent: String(MINE) }, String(MEMBER_ID));

    const handed = await updateTask(
      String(PROJECT_ID),
      String(own),
      { assignee: ADMIN_USERNAME },
      String(MEMBER_ID)
    );

    expect(handed.ok).toBe(true);
    const handle = await db();
    const after = await handle.collection("tasks").findOne({ _id: own });
    expect(after?.agent).toBeNull();
    expect(String(after?.assignedBy)).toBe(String(MEMBER_ID));
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))).toBeNull();
  });

  // The other half of the same rule, and the one that separates "the new assignee owns it" from
  // "the actor owns it": the agent belongs to the person the task is going TO, and neither of them
  // is the writer. It survives, and their machine takes it once they hold it by their own hand.
  test("survives a hand-over to the person it belongs to", async () => {
    const handle = await db();
    await handle.collection("agents").insertOne({
      _id: THEIRS,
      name: "The admin's own",
      description: "",
      scope: "user",
      owner: ADMIN_ID,
      project: null,
      composition: RUNNABLE,
      builtIn: false,
    });
    const held = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: THEIRS });

    const handed = await updateTask(
      String(PROJECT_ID),
      String(held),
      { assignee: ADMIN_USERNAME },
      String(MEMBER_ID)
    );
    expect(handed.ok).toBe(true);
    expect(String((await handle.collection("tasks").findOne({ _id: held }))?.agent)).toBe(
      String(THEIRS)
    );
    // No machine acts on it yet, and that is the OTHER half of the claim rather than this rule:
    // being handed work is a proposal, so `assignedBy` naming the member is what holds it.
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))).toBeNull();
  });

  // Keyed on the assignee MOVING, not on the task being written to. An edit that leaves the
  // hand-over exactly as it was must not cost somebody the agent they chose — and this is the
  // shape that actually runs, so the clearing rule is checked against a live claim rather than
  // against a field alone.
  test("an edit that does not move the assignee leaves the agent, and it still runs", async ({
    request,
  }) => {
    const handle = await db();
    await handle.collection("agents").insertOne({
      _id: THEIRS,
      name: "The admin's own",
      description: "",
      scope: "user",
      owner: ADMIN_ID,
      project: null,
      composition: RUNNABLE,
      builtIn: false,
    });
    const own = await addTask({ assignee: ADMIN_ID, assignedBy: ADMIN_ID, agent: THEIRS });

    const renamed = await put(request, own, { title: "renamed" }, ADMIN_AUTH);
    expect(renamed.status(), await renamed.text()).toBe(200);

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID));
    expect(String(claimed?._id)).toBe(String(own));
    expect(String(claimed?.agent)).toBe(String(THEIRS));
  });

  // What the PROJECT sanctioned is not anybody's personal composition, and clearing it on every
  // ordinary reassignment would be a gratuitous loss
  test("a project's agent survives the same hand-over", async () => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: PROJECTS });

    await updateTask(String(PROJECT_ID), String(own), { assignee: ADMIN_USERNAME }, String(MEMBER_ID));

    const handle = await db();
    expect(String((await handle.collection("tasks").findOne({ _id: own }))?.agent)).toBe(
      String(PROJECTS)
    );
  });

  /**
   * The reproduction itself: four gestures by two people, each one a real request to the real
   * route under that person's own credential. A direct service call steps over the seam the last
   * two defects on this branch lived in — the body the route accepts, the whitelist, the principal
   * it resolves — so the reproduction goes over HTTP even though the verdict is read from the
   * database.
   */
  test("the four gestures that used to end with my composition on their machine", async ({
    request,
  }) => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: null });
    const handle = await db();
    const stored = () => handle.collection("tasks").findOne({ _id: own });

    // 1. It is my task, and I point it at my own personal agent — allowed, and the machine that
    //    would run it is mine
    const chose = await put(request, own, { agent: String(MINE) }, MEMBER_AUTH);
    expect(chose.status(), await chose.text()).toBe(200);
    expect(String((await stored())?.agent)).toBe(String(MINE));

    // 2. I hand it to the admin. `agent` is not in this body — this is the write that used to
    //    leave my composition on their task.
    const handed = await put(request, own, { assignee: ADMIN_USERNAME }, MEMBER_AUTH);
    expect(handed.status(), await handed.text()).toBe(200);
    expect((await handed.json()).agent).toBeNull();
    expect((await stored())?.agent).toBeNull();

    // 3 and 4. The admin unassigns and takes it on themselves, which restores
    //    `assignee === assignedBy` — the pair that used to let their machine claim it
    expect((await put(request, own, { assignee: null }, ADMIN_AUTH)).status()).toBe(200);
    expect((await put(request, own, { assignee: ADMIN_USERNAME }, ADMIN_AUTH)).status()).toBe(200);

    const after = await stored();
    expect(String(after?.assignee)).toBe(String(ADMIN_ID));
    expect(String(after?.assignedBy)).toBe(String(ADMIN_ID));
    expect(after?.agent).toBeNull();
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))).toBeNull();
  });

  /**
   * The same rule against the other half of the pair, and the shape "the assignee moved" walks
   * past. A task stored before BP-358 records no assigner, so no machine looks at it — and the
   * repair the product prints on the task itself, assign it to yourself again, is what records
   * one. The assignee never moves, and that one gesture is what makes the task claimable for the
   * first time, carrying whatever agent it has carried all along.
   *
   * The key is genuinely ABSENT here, not null: only a missing field is what an old document looks
   * like, and only it survives a writer that starts defaulting the field.
   */
  test("a legacy repair does not arm the repairer's machine with somebody else's agent", async ({
    request,
  }) => {
    const old = await addLegacyTask({ assignee: ADMIN_ID, agent: MINE });
    const handle = await db();
    expect(await handle.collection("tasks").findOne({ _id: old })).not.toHaveProperty("assignedBy");

    const repaired = await put(request, old, { assignee: ADMIN_USERNAME }, ADMIN_AUTH);
    expect(repaired.status(), await repaired.text()).toBe(200);

    const after = await handle.collection("tasks").findOne({ _id: old });
    expect(String(after?.assignedBy)).toBe(String(ADMIN_ID));
    expect(after?.agent).toBeNull();
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))).toBeNull();
  });

  // …and the repair still does what it exists for, on the ordinary task: their own agent stays,
  // and recording the assigner is exactly what lets their machine take it
  test("a legacy repair keeps the repairer's own agent, and their machine then takes it", async () => {
    const handle = await db();
    await handle.collection("agents").insertOne({
      _id: THEIRS,
      name: "The admin's own",
      description: "",
      scope: "user",
      owner: ADMIN_ID,
      project: null,
      composition: RUNNABLE,
      builtIn: false,
    });
    const old = await addLegacyTask({ assignee: ADMIN_ID, agent: THEIRS });

    const repaired = await updateTask(
      String(PROJECT_ID),
      String(old),
      { assignee: ADMIN_USERNAME },
      String(ADMIN_ID)
    );
    expect(repaired.ok).toBe(true);

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID));
    expect(String(claimed?._id)).toBe(String(old));
    expect(String(claimed?.agent)).toBe(String(THEIRS));
  });

  // A field a write changed without being asked to has to be answerable for afterwards
  test("the drop is written to the task's history", async ({ request }) => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: MINE });

    await put(request, own, { assignee: ADMIN_USERNAME }, MEMBER_AUTH);

    const handle = await db();
    const rows = await handle.collection("activitylogs").find({ task: own, field: "agent" }).toArray();
    expect(rows.map((r) => [String(r.oldValue), String(r.newValue ?? "")])).toEqual([
      [String(MINE), ""],
    ]);
  });

  /**
   * The populate that names the agent hands the history comparison a mongoose DOCUMENT where the
   * before-image holds a raw id, and `String()` on a document is its inspect output. The unit test
   * for this is handed a plain `{ _id, name }`, which is not what mongoose returns — so the shape
   * that could actually break it only exists here.
   */
  test("an ordinary edit invents no agent change, though the answer comes back populated", async ({
    request,
  }) => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: MINE });

    const renamed = await put(request, own, { title: "renamed" }, MEMBER_AUTH);
    expect(renamed.status(), await renamed.text()).toBe(200);
    // …and the agent really did come back as a named document rather than a bare id
    expect((await renamed.json()).agent).toMatchObject({ name: "Member's own" });

    const handle = await db();
    expect(await handle.collection("activitylogs").countDocuments({ task: own, field: "agent" })).toBe(0);
  });

  /**
   * The other defect this round closes, through the surface it appears on. `/api/agents` never
   * answers with somebody else's personal agent, so the picker could not resolve the id and
   * rendered its empty state — "No agent" printed over a task carrying one, on the very field the
   * consent model rests on.
   *
   * The state is ordinary and permanent, not a leftover: the member's own agent on the member's
   * own task, read by a colleague.
   */
  test("names the agent it may not offer, rather than showing the row empty", async ({ page }) => {
    const theirs = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: MINE });
    const handle = await db();
    const number = (await handle.collection("tasks").findOne({ _id: theirs }))?.taskNumber;

    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${number}`);

    await expect(page.getByTestId("agent-not-offered")).toHaveText("Member's own");
    await expect(page.getByTestId("agent-not-offered-reason")).toContainText(
      /only offered to the person who composed it/i
    );
  });

  // The member sees their own agent as an ordinary choice, in the same place the colleague above
  // gets a read-only name — so the branch above is a reader-specific answer rather than a field
  // that has stopped being editable
  test("and offers the same agent to the person it belongs to", async ({ page }) => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: MINE });
    const handle = await db();
    const number = (await handle.collection("tasks").findOne({ _id: own }))?.taskNumber;

    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${number}`);

    await expect(page.getByTestId("agent-not-offered")).toHaveCount(0);
    await expect(
      page.getByRole("combobox").filter({ hasText: /^Agent/ })
    ).toContainText("Member's own");
  });

  // Assignee and agent travel in one PUT — the detail view's auto-save sends every edited field
  // together — so a check reading the STORED assignee would pass on a pairing the same write ends
  test("is refused in the write that hands the task away, though it was mine when it was read", async () => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: null });

    const chosen = await updateTask(
      String(PROJECT_ID),
      String(own),
      { assignee: ADMIN_USERNAME, agent: String(MINE) },
      String(MEMBER_ID)
    );

    expect(chosen.ok).toBe(false);
    const handle = await db();
    const after = await handle.collection("tasks").findOne({ _id: own });
    expect(after?.agent).toBeNull();
    expect(String(after?.assignee)).toBe(String(MEMBER_ID));
  });
});

/**
 * The fourth walk, and the one check that is not a writer.
 *
 * Everything above is enforced where `agent` is WRITTEN, and three consecutive rounds of BP-358
 * each closed one writer and were each followed by another hole of the same shape. So this block
 * goes through the claim route itself — the point where a composition is actually picked up and
 * handed to a machine — and starts from documents no writer will ever look at again: the ones this
 * branch's own intermediate commits could store, and the ones `main` holds today.
 *
 * The route rather than the service, deliberately. `snapshotFor` is called nowhere else, and the
 * machine's owner only exists at that layer: the two defects before this one lived in exactly the
 * seam a direct service call steps over.
 */
test.describe("what the machine refuses at the moment it picks the work up", () => {
  const MINE = new mongoose.Types.ObjectId();
  const THEIRS = new mongoose.Types.ObjectId();
  const PROJECTS = new mongoose.Types.ObjectId();
  // A key the catalog really carries: this block is RESOLVED here rather than merely stored, and
  // snapshotFor refuses a composition naming a key with no block behind it
  const RUNNABLE = { analysis: [], implementation: [{ key: "implement" }], verification: [], delivery: [] };
  const REMOTE = "e2e-owner/e2e-repo";

  // OWNER is the admin, so the three ids stay apart: the machine belongs to one person, MINE is
  // that person's own composition, THEIRS is the member's, and neither is the machine's id.
  test.beforeEach(async () => {
    const handle = await db();
    // seed() empties the whole database, and the block catalog is written at server BOOT — so by
    // the second test of any run it is gone. A missing block refuses the claim for a reason that
    // has nothing to do with ownership, which is exactly how the two positive controls below would
    // stop controlling anything.
    await handle.collection("agentblocks").updateOne(
      { key: "implement" },
      { $set: { key: "implement", kind: "step", name: "Implement", description: "", prompt: "make the change", capability: "edit", model: "opus", fallbackModel: "sonnet", deterministic: false, builtIn: true } },
      { upsert: true }
    );
    await handle.collection("agents").deleteMany({ _id: { $in: [MINE, THEIRS, PROJECTS] } });
    await handle.collection("agents").insertMany([
      { _id: MINE, name: "The owner's own", description: "", scope: "user", owner: OWNER, project: null, composition: RUNNABLE, builtIn: false },
      { _id: THEIRS, name: "The member's own", description: "", scope: "user", owner: MEMBER_ID, project: null, composition: RUNNABLE, builtIn: false },
      { _id: PROJECTS, name: "The project's", description: "", scope: "project", owner: null, project: PROJECT_ID, composition: RUNNABLE, builtIn: false },
    ]);
    // What verdictFor wants before it will let this machine claim at all: an owner who can reach
    // the project, and a reported checkout of the project's own repository.
    await handle.collection("workers").updateOne(
      { _id: WORKER_ID },
      { $set: { owner: OWNER, repos: [{ remote: REMOTE, path: "/e2e/checkout" }], lastSeenAt: new Date() } }
    );
    await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { githubRepo: REMOTE } });
  });

  function claim(request: APIRequestContext, runId: string) {
    return request.post(`/api/projects/${PROJECT_ID}/tasks/claim`, {
      headers: {
        authorization: `Bearer ${WORKER_CREDENTIAL}`,
        "x-worker-id": String(WORKER_ID),
        "x-cp-protocol": "1",
      },
      data: { runId },
    });
  }

  // Nothing below means anything without this: a 204 proves a refusal only if a claim through the
  // same harness can succeed
  test("takes a task carrying the machine owner's own composition", async ({ request }) => {
    const own = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: MINE });

    const claimed = await claim(request, "run-owner");

    expect(claimed.status(), await claimed.text()).toBe(200);
    const body = await claimed.json();
    expect(String(body._id)).toBe(String(own));
    expect(body.agent).toMatchObject({ agentId: String(MINE), name: "The owner's own" });
    expect((await read(own)).status).toBe(ACTIVE);
  });

  /**
   * The residue this round exists for. `f127d26` let anybody put their personal agent on anybody's
   * self-assigned task, so a document in exactly this pairing can already be sitting in a database
   * — and no writer re-judges a task nobody is editing. The claim's own filter matches it: it is
   * assigned to the machine's owner, by the machine's owner, and it names an agent.
   */
  test("refuses a stranger's composition on a document no writer will look at again", async ({
    request,
  }) => {
    const armed = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: THEIRS });

    const claimed = await claim(request, "run-alien");

    expect(claimed.status()).toBe(204);
    const after = await read(armed);
    expect(after.status).toBe(APPROVED);
    // Not repaired, only refused: the field is still what it was, and the attempt was spent rather
    // than refunded, which is what stops the task starving every other one behind it
    const handle = await db();
    expect(String((await handle.collection("tasks").findOne({ _id: armed }))?.agent)).toBe(String(THEIRS));
    expect(after.execution.attempts).toBe(1);
  });

  /**
   * What the board sees, which is the question a silent refusal fails. It is not silent and it is
   * not forever: the attempt is spent on each cycle, and the third one parks the task in the
   * escalation column — a review column a person reads, and the one that queues a PM triage.
   */
  test("parks it where a person reads, rather than handing it back forever", async ({ request }) => {
    const armed = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: THEIRS });

    expect((await claim(request, "run-1")).status()).toBe(204);
    expect((await claim(request, "run-2")).status()).toBe(204);
    expect((await claim(request, "run-3")).status()).toBe(204);

    const after = await read(armed);
    expect(after.status).toBe("needs_human_review");
    expect(after.execution.attempts).toBe(3);
  });

  // The other half of the same rule, at this layer too: what the PROJECT sanctioned is nobody's
  // personal composition, so it runs on whichever member's machine holds the work
  test("still runs the project's own agent on a machine belonging to anybody", async ({ request }) => {
    const sanctioned = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: PROJECTS });

    const claimed = await claim(request, "run-project");

    expect(claimed.status(), await claimed.text()).toBe(200);
    expect((await claimed.json()).agent).toMatchObject({ name: "The project's" });
    expect((await read(sanctioned)).status).toBe(ACTIVE);
  });

  /**
   * The agent row changing under a task that was written correctly. Nothing in the product edits an
   * agent's scope — `PUT /api/agents/:id` takes name, description and composition and nothing else
   * — so this is a hand-edited database rather than a gesture anybody can make. It is here because
   * that is precisely the difference between a check at the writer and a check at the point of
   * execution: this one does not care how the pairing came about.
   */
  test("refuses an agent that became somebody's own after the task chose it", async ({ request }) => {
    const chosen = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: PROJECTS });
    const handle = await db();
    await handle
      .collection("agents")
      .updateOne({ _id: PROJECTS }, { $set: { scope: "user", owner: MEMBER_ID, project: null } });

    expect((await claim(request, "run-rescoped")).status()).toBe(204);
    expect((await read(chosen)).status).toBe(APPROVED);
  });

  /**
   * What the fourth walk turned up, and the reason a residue is not a one-off document.
   *
   * `createNextRecurrence` copies `assignee`, `assignedBy` and `agent` forward together and judges
   * none of them — it is not `updateTask`, and it has no actor to judge against. The copy lands in
   * the backlog column, and the gesture that approves it is a status change, which is not
   * `updateTask` either. So a series whose parent was paired before the writers were fixed
   * reproduces that pairing every week, for good, and no gesture anybody makes will ever clean it.
   *
   * Nothing here re-judges. This is the only thing that stops each copy.
   */
  test("refuses every copy a recurring series makes of a pairing nothing re-judges", async ({
    request,
  }) => {
    const parent = await addTask({
      status: ACTIVE,
      assignee: OWNER,
      assignedBy: OWNER,
      agent: THEIRS,
      dueDate: new Date(),
      recurrence: { frequency: "weekly", interval: 1 },
    });
    const handle = await db();

    await changeStatus(String(PROJECT_ID), String(parent), "done", String(OWNER));

    // The next occurrence is created fire-and-forget, after the status change has answered
    await expect
      .poll(async () => await handle.collection("tasks").countDocuments({ recurringParentId: parent }))
      .toBe(1);
    const copy = (await handle.collection("tasks").findOne({ recurringParentId: parent }))!;
    // Carried forward untouched, which is the finding rather than the bug: the copy is only as good
    // as the pairing it came from
    expect(String(copy.agent)).toBe(String(THEIRS));
    expect(String(copy.assignedBy)).toBe(String(OWNER));

    // Approving it is a status change, not an edit, so nothing judges the agent on the way either
    await changeStatus(String(PROJECT_ID), String(copy._id), APPROVED, String(OWNER));

    expect((await claim(request, "run-recurrence")).status()).toBe(204);
    expect((await read(copy._id)).status).toBe(APPROVED);
  });

  // BP-329. The runId is the only caller-controlled string the claim interpolates into an update
  // PIPELINE, where Mongoose casts nothing and a leading `$` is a field path. Refused at the door,
  // and written as `$literal` regardless — the two tests below are the door, the ones at the end of
  // this file are the write.
  for (const shape of ["$$REMOVE", "$execution.workerId", "a".repeat(65), "run 1", "run/1"]) {
    test(`refuses a runId of ${JSON.stringify(shape)}`, async ({ request }) => {
      const armed = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: MINE });

      const answer = await claim(request, shape);

      expect(answer.status(), await answer.text()).toBe(400);
      // Not merely refused: the work is still there to be claimed by a request that asks properly
      expect((await read(armed)).status).toBe(APPROVED);
    });
  }

  // The control the refusals are worthless without: the shape the worker actually mints
  test("takes the work when the runId is the uuid a worker mints", async ({ request }) => {
    const armed = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: MINE });

    const answer = await claim(request, randomUUID());

    expect(answer.status(), await answer.text()).toBe(200);
    expect((await read(armed)).status).toBe(ACTIVE);
  });

  // A dangling owner is not a match for anybody, least of all for the machine standing in front of
  // it: populate renders a deleted reference as null, and only the stored id decides here
  test("refuses one whose owner no longer exists at all", async ({ request }) => {
    const gone = new mongoose.Types.ObjectId();
    const handle = await db();
    await handle.collection("agents").updateOne({ _id: THEIRS }, { $set: { owner: gone } });
    const armed = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: THEIRS });

    expect((await claim(request, "run-orphan")).status()).toBe(204);
    expect((await read(armed)).status).toBe(APPROVED);
  });
});

/**
 * BP-329, the other half. The route above refuses these shapes, so the only way to reach the write
 * with one is to call the service the way the route does — which is what the `$literal` in
 * `claimNextTask` is for: it protects the write from every caller there will ever be, not just the
 * one this repository can see today.
 */
test.describe("a run identity is text, whatever it looks like", () => {
  test("an ordinary uuid is stored verbatim", async () => {
    const armed = await addTask();
    const runId = randomUUID();

    await claimNextTask(String(PROJECT_ID), WORKER, runId, String(OWNER));

    expect((await read(armed)).execution.runId).toBe(runId);
  });

  // Without `$literal` this stored NOTHING: the task went active holding a run with no identity, so
  // no report could address it and nothing but the two-hour lease could get it back.
  test("$$REMOVE is a run identity, not an instruction to drop the field", async () => {
    const armed = await addTask();

    await claimNextTask(String(PROJECT_ID), WORKER, "$$REMOVE", String(OWNER));

    expect((await read(armed)).execution.runId).toBe("$$REMOVE");
  });

  // And this stored the WORKER'S OWN id — a claim whose identity was a copy of another field
  test("a field path is a run identity, not the value of that field", async () => {
    const armed = await addTask();

    await claimNextTask(String(PROJECT_ID), WORKER, "$execution.workerId", String(OWNER));

    const after = await read(armed);
    expect(after.execution.runId).toBe("$execution.workerId");
    expect(after.execution.workerId).toBe(WORKER);
  });
});
