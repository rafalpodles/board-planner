import mongoose from "mongoose";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

// Never the development database. The URI is passed to the dev server too, so a mistake here
// would have the browser writing into whatever the developer is using at the time.
export const E2E_MONGODB_URI =
  process.env.E2E_MONGODB_URI ?? "mongodb://localhost:27017/boardplanner_e2e";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "test1234";

// A plain project member, reaching the board through a grant rather than through role "admin".
// withProjectAccess short-circuits on the instance-admin check, so nothing an admin does can
// tell whether the grants path still works.
export const MEMBER_USERNAME = "member";
export const MEMBER_PASSWORD = "test1234";

export const PROJECT_KEY = "TP";
// Deliberately not "Test Project": a project keyed TP also exists in the development database,
// so the name is what proves which one the server is actually reading.
export const PROJECT_NAME = "E2E Run Conflict Board";

export const WORKER_NAME = "e2e-macbook-pro";
// The credential the seeded machine authenticates with, so a spec can drive the claim route itself
// rather than the service behind it
export const WORKER_CREDENTIAL = "e2e-worker-credential";

// Real API tokens: the browser authenticates with a session cookie no APIRequestContext can be
// handed, so every setup call the suite makes over the API carries one of these instead. The
// prefix is the first 11 characters, which is what verifyBearerToken looks a candidate up by.
export const API_TOKEN = "cp_e2e00001deadbeefdeadbeefdeadbeef";
export const MEMBER_API_TOKEN = "cp_e2e00002deadbeefdeadbeefdeadbeef";

// The browser's counterpart to the tokens above: a session row seed() lays down, so a test can
// arrive signed in by setting one cookie instead of driving the sign-in form. 236 calls to a
// hand-rolled signIn() across 31 specs were ~2s each, and the wipe before every test is what made
// them unavoidable. Specs whose subject IS signing in keep the form — see e2e/session.ts.
export const ADMIN_SESSION_TOKEN = "cps_e2e00003deadbeefdeadbeefdeadbeef";
export const MEMBER_SESSION_TOKEN = "cps_e2e00004deadbeefdeadbeefdeadbeef";
export const RUN_PHASE = "agent";

export const HELD_TASK_NUMBER = 1;
export const HELD_TASK_KEY = `${PROJECT_KEY}-${HELD_TASK_NUMBER}`;
export const HELD_TASK_TITLE = "Held by a live worker run";

export const DECOY_TASK_NUMBER = 2;
export const DECOY_TASK_TITLE = "Already in review";

// Shares the held task's column so a same-column drop has somewhere to land and a bulk move has
// something it is allowed to take
export const SIBLING_TASK_NUMBER = 3;
export const SIBLING_TASK_KEY = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`;
export const SIBLING_TASK_TITLE = "Free to move";

export const FINISHED_TASK_NUMBER = 4;
export const FINISHED_TASK_KEY = `${PROJECT_KEY}-${FINISHED_TASK_NUMBER}`;
export const FINISHED_TASK_TITLE = "Its run already finished";

// The two below are seeded on request rather than by seed(), and both for the same reason: a
// board-wide "no run badges left" is how several tests prove a run was released, and a second
// badge standing on the board would let that assertion pass without anything being released.
export const SECOND_HELD_TASK_NUMBER = 5;
export const SECOND_HELD_TASK_KEY = `${PROJECT_KEY}-${SECOND_HELD_TASK_NUMBER}`;
export const SECOND_HELD_TASK_TITLE = "Held by a second live worker run";

export const QUIET_TASK_NUMBER = 6;
export const QUIET_TASK_KEY = `${PROJECT_KEY}-${QUIET_TASK_NUMBER}`;
export const QUIET_TASK_TITLE = "Held by a run that has gone quiet";

export const SOURCE_COLUMN = { id: "in_progress", label: "In Progress" };
export const TARGET_COLUMN = { id: "in_review", label: "In Review" };
// Somewhere other than the two the refusal tests use, so the finished-run task is never in the
// way of a drag those tests make
export const SPARE_COLUMN = { id: "todo", label: "To Do" };

const id = (hex: string) => new mongoose.Types.ObjectId(hex);

// Hashed once per worker process rather than once per seed(). bcrypt at cost 10 is ~56ms a call
// and seed() made four of them, which was 224ms of its 378ms — paid before every one of the
// suite's tests. The values are still computed, not pasted, so they cannot go stale.
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const MEMBER_PASSWORD_HASH = bcrypt.hashSync(MEMBER_PASSWORD, 10);
const API_TOKEN_HASH = bcrypt.hashSync(API_TOKEN, 10);
const MEMBER_API_TOKEN_HASH = bcrypt.hashSync(MEMBER_API_TOKEN, 10);
const WORKER_CREDENTIAL_HASH = bcrypt.hashSync(WORKER_CREDENTIAL, 10);

export const ADMIN_ID = id("e2e00000000000000000a001");
export const MEMBER_ID = id("e2e00000000000000000a002");
export const PROJECT_ID = id("e2e00000000000000000c001");
export const WORKER_ID = id("e2e00000000000000000b001");
export const GRANT_ID = id("e2e00000000000000000e001");
export const HELD_TASK_ID = id("e2e00000000000000000d001");
export const DECOY_TASK_ID = id("e2e00000000000000000d002");
export const SIBLING_TASK_ID = id("e2e00000000000000000d003");
export const FINISHED_TASK_ID = id("e2e00000000000000000d004");
export const SECOND_HELD_TASK_ID = id("e2e00000000000000000d005");
export const QUIET_TASK_ID = id("e2e00000000000000000d006");

const COLUMNS = [
  { id: "planned", label: "Planned", color: "#6b7280", role: "backlog", order: 0 },
  { id: "todo", label: "To Do", color: "#3b82f6", role: "approved", order: 1 },
  { id: "in_progress", label: "In Progress", color: "#f59e0b", role: "active", order: 2 },
  { id: "in_review", label: "In Review", color: "#a855f7", role: "review", order: 3 },
  { id: "needs_human_review", label: "Needs Human Review", color: "#f43f5e", role: "review", order: 4 },
  { id: "ready_to_test", label: "Ready to Test", color: "#06b6d4", role: "review", order: 5 },
  { id: "done", label: "Done", color: "#22c55e", role: "done", order: 6 },
].map((c) => ({ _id: new mongoose.Types.ObjectId(), triggersPmReview: c.id === "needs_human_review", ...c }));

const CATEGORIES = [
  { name: "bug", color: "#ef4444" },
  { name: "doc", color: "#3b82f6" },
  { name: "user-story", color: "#22c55e" },
  { name: "idea", color: "#8b5cf6" },
].map((c) => ({ _id: new mongoose.Types.ObjectId(), ...c }));

async function connect() {
  const dbName = new URL(E2E_MONGODB_URI.replace(/^mongodb/, "http")).pathname.slice(1);
  if (!dbName.endsWith("_e2e")) {
    throw new Error(
      `Refusing to touch database "${dbName}": the e2e fixture only runs against a *_e2e database`
    );
  }
  await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection;
}

// The whole database, not a list of collections: this one exists for the fixture, and a run
// leaves activity logs and notifications behind that a fixed list would keep missing.
async function empty(db: mongoose.mongo.Db) {
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  await Promise.all(names.map((name) => db.collection(name).deleteMany({})));
}

export async function wipe() {
  await empty((await connect()).db!);
  await mongoose.disconnect();
}

/**
 * The stored run subdocument, which no endpoint returns: the API publishes only what a reader may
 * see, and a released run is invisible there by design. A test asserting on the absence of a
 * refusal needs to know the fixture still carries the worker that could have caused one.
 */
export async function storedExecution(
  taskId: mongoose.Types.ObjectId
): Promise<Record<string, unknown> | undefined> {
  const db = (await connect()).db!;
  const task = await db.collection("tasks").findOne({ _id: taskId }, { projection: { execution: 1 } });
  await mongoose.disconnect();
  return task?.execution as Record<string, unknown> | undefined;
}

/**
 * A task the product would accept, for specs that need many of them. Exported because a hand-rolled
 * insert drifts from the schema — one without `createdBy` reads as a product bug the day a test
 * loads the board (BP-482 review).
 */
export const taskFactory = (now: Date) => (over: Record<string, unknown>) => ({
  project: PROJECT_ID,
  description: "",
  priority: "medium",
  category: "user-story",
  assignee: null,
  dueDate: null,
  checklist: [],
  linkedPRs: [],
  blockedBy: [],
  relations: [],
  watchers: [],
  sprint: null,
  customFieldValues: {},
  recurrence: null,
  recurringParentId: null,
  order: 0,
  createdBy: ADMIN_ID,
  createdAt: now,
  updatedAt: now,
  ...over,
});

/**
 * Adds a card to the board seed() already laid down, and keeps taskCounter ahead of it so the
 * project could still mint the next number.
 */
async function addTask(over: Record<string, unknown>, taskNumber: number) {
  const db = (await connect()).db!;
  await db.collection("tasks").insertOne(taskFactory(new Date())({ taskNumber, ...over }));
  await db
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: taskNumber } });
  await mongoose.disconnect();
}

/** A second task under a live run, for the bulk move that has to name more than one refusal. */
export async function seedSecondHeldTask() {
  const now = new Date();
  await addTask(
    {
      _id: SECOND_HELD_TASK_ID,
      title: SECOND_HELD_TASK_TITLE,
      status: SOURCE_COLUMN.id,
      order: 2,
      execution: {
        runId: "e2e-run-0002",
        workerId: String(WORKER_ID),
        attempts: 1,
        startedAt: new Date(now.getTime() - 60_000),
        lastError: "",
        phase: RUN_PHASE,
        phaseAt: now,
        phaseSeq: 3,
      },
    },
    SECOND_HELD_TASK_NUMBER
  );
}

// BP-529. A sprint that closed with this task still in it, and never swept to the backlog — the
// one situation where "Remove from sprint" is needed, and the board has no *open* sprint to pair
// it with.
export const STRANDED_SPRINT_ID = id("e2e00000000000000000c105");
export const STRANDED_SPRINT_NAME = "Sprint 2";
export const STRANDED_TASK_ID = id("e2e00000000000000000d007");
export const STRANDED_TASK_NUMBER = 15;
export const STRANDED_TASK_TITLE = "Left in a sprint that already closed";

/** Adds a completed sprint and a task still carrying it, on a board with no open sprint. */
export async function seedTaskInCompletedSprint() {
  const db = (await connect()).db!;
  const now = new Date();
  await db.collection("sprints").insertOne({
    _id: STRANDED_SPRINT_ID,
    project: PROJECT_ID,
    name: STRANDED_SPRINT_NAME,
    goal: "",
    status: "completed",
    startDate: new Date(now.getTime() - 30 * 86_400_000),
    endDate: new Date(now.getTime() - 16 * 86_400_000),
    createdAt: now,
    updatedAt: now,
  });
  await db.collection("tasks").insertOne(
    taskFactory(now)({
      _id: STRANDED_TASK_ID,
      taskNumber: STRANDED_TASK_NUMBER,
      title: STRANDED_TASK_TITLE,
      status: SPARE_COLUMN.id,
      sprint: STRANDED_SPRINT_ID,
      order: 1,
    })
  );
  await db
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: STRANDED_TASK_NUMBER } });
  await mongoose.disconnect();
}

/**
 * A run that still holds its task but has not reported in `quietForMs`. Past the card's threshold
 * it reads quiet rather than live — and runHolding keys on runId, not on the clock, so the server
 * must refuse the move exactly as it does for a chatty one.
 */
/**
 * The project fields CP-250 is about. Two properties are deliberate and load-bearing:
 *
 * - every option id differs from the text it stands for, so an implementation that logs the
 *   stored value instead of the displayed one cannot pass;
 * - the ids sort alphabetically in the *reverse* of the order the project configured, so an
 *   implementation that sorts a multiselect by id rather than by option order cannot pass either.
 *
 * A fixture already shaped like the answer proves nothing, and both of these started life that
 * way before a mutation showed the tests staying green.
 */
export const FIELDS = {
  difficulty: {
    _id: id("e2e00000000000000000f001"),
    name: "Difficulty",
    fieldType: "dropdown",
    options: [
      { id: "zz-small", value: "S", color: "#4ade80", order: 0 },
      { id: "aa-large", value: "L", color: "#f59e0b", order: 1 },
    ],
  },
  platforms: {
    _id: id("e2e00000000000000000f002"),
    name: "Platforms",
    fieldType: "multiselect",
    options: [
      { id: "zz-ios", value: "iOS", color: "#64748b", order: 0 },
      { id: "aa-web", value: "Web", color: "#6b7280", order: 1 },
    ],
  },
  // The punctuation is the point: the task asked whether a field named oddly still reads sensibly
  // once its name is dropped into a sentence.
  spike: { _id: id("e2e00000000000000000f003"), name: "Spike?", fieldType: "checkbox", options: [] },
  points: { _id: id("e2e00000000000000000f004"), name: "Points", fieldType: "number", options: [] },
  target: { _id: id("e2e00000000000000000f005"), name: "Target", fieldType: "date", options: [] },
  notes: { _id: id("e2e00000000000000000f006"), name: "Notes", fieldType: "text", options: [] },
  // Archived, not deleted: its values survive on tasks and stop being policed, so an edit that
  // moves one still has to be recorded.
  retired: {
    _id: id("e2e00000000000000000f007"),
    name: "Retired",
    fieldType: "dropdown",
    archived: true,
    options: [{ id: "kept-value", value: "Kept", color: "#6b7280", order: 0 }],
  },
} as const;

const fieldDefaults = { required: false, showOnCard: false, showInList: false, filterable: false, archived: false };

/**
 * Puts the fields above on the project and, optionally, values on the task the field tests edit.
 * Kept out of seed() so the run-conflict board stays exactly as that suite left it.
 */
export async function seedCustomFields(values: Record<string, unknown> = {}) {
  const db = (await connect()).db!;
  const customFields = Object.values(FIELDS).map((field, order) => ({
    ...fieldDefaults,
    ...field,
    order,
    options: [...field.options],
  }));
  await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { customFields } });
  await db
    .collection("tasks")
    .updateOne({ _id: SIBLING_TASK_ID }, { $set: { customFieldValues: values } });
  await mongoose.disconnect();
}

/** Every history entry on a task, newest first, as the API returns them to the timeline. */
export async function storedActivity(
  taskId: mongoose.Types.ObjectId
): Promise<{ action: string; field: string; oldValue: string; newValue: string }[]> {
  const db = (await connect()).db!;
  const rows = await db
    .collection("activitylogs")
    .find({ task: taskId })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();
  await mongoose.disconnect();
  return rows.map((r) => ({
    action: String(r.action),
    field: String(r.field ?? ""),
    oldValue: String(r.oldValue ?? ""),
    newValue: String(r.newValue ?? ""),
  }));
}

/** Renames a field, or one of its options, after history has already been written about it. */
export async function renameField(
  fieldId: mongoose.Types.ObjectId,
  changes: { name?: string; optionId?: string; optionValue?: string }
) {
  const db = (await connect()).db!;
  const set: Record<string, unknown> = {};
  if (changes.name) set["customFields.$[f].name"] = changes.name;
  if (changes.optionId) set["customFields.$[f].options.$[o].value"] = changes.optionValue;
  await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: set }, {
    arrayFilters: [
      { "f._id": fieldId },
      ...(changes.optionId ? [{ "o.id": changes.optionId }] : []),
    ],
  });
  await mongoose.disconnect();
}

// A sprint with a done and an undone task already in it, plus a fourth task sitting in the
// backlog with no sprint — enough for a drag to cross the boundary in either direction and for
// the header's done/total to have somewhere real to move from.
export const PLANNING_SPRINT_ID = id("e2e00000000000000000c101");
export const PLANNING_SPRINT_NAME = "Sprint Alpha";

export const PLANNING_SPRINT_TASK_NUMBER = 7;
export const PLANNING_SPRINT_TASK_ID = id("e2e00000000000000000d101");
export const PLANNING_SPRINT_TASK_TITLE = "Already in the sprint";

export const PLANNING_SPRINT_DONE_TASK_NUMBER = 8;
export const PLANNING_SPRINT_DONE_TASK_ID = id("e2e00000000000000000d102");
export const PLANNING_SPRINT_DONE_TASK_TITLE = "Already done in the sprint";

export const PLANNING_BACKLOG_TASK_NUMBER = 9;
export const PLANNING_BACKLOG_TASK_ID = id("e2e00000000000000000d103");
export const PLANNING_BACKLOG_TASK_TITLE = "Waiting in the backlog";

export async function seedSprintPlanning() {
  const db = (await connect()).db!;
  const now = new Date();

  await db.collection("sprints").insertOne({
    _id: PLANNING_SPRINT_ID,
    project: PROJECT_ID,
    name: PLANNING_SPRINT_NAME,
    startDate: now,
    endDate: new Date(now.getTime() + 14 * 86_400_000),
    goal: "",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  const task = taskFactory(now);
  await db.collection("tasks").insertMany([
    task({
      _id: PLANNING_SPRINT_TASK_ID,
      taskNumber: PLANNING_SPRINT_TASK_NUMBER,
      title: PLANNING_SPRINT_TASK_TITLE,
      status: SOURCE_COLUMN.id,
      sprint: PLANNING_SPRINT_ID,
      order: 0,
    }),
    task({
      _id: PLANNING_SPRINT_DONE_TASK_ID,
      taskNumber: PLANNING_SPRINT_DONE_TASK_NUMBER,
      title: PLANNING_SPRINT_DONE_TASK_TITLE,
      status: "done",
      sprint: PLANNING_SPRINT_ID,
      order: 1,
    }),
    task({
      _id: PLANNING_BACKLOG_TASK_ID,
      taskNumber: PLANNING_BACKLOG_TASK_NUMBER,
      title: PLANNING_BACKLOG_TASK_TITLE,
      status: SPARE_COLUMN.id,
      sprint: null,
      order: 2,
    }),
  ]);
  await db
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: PLANNING_BACKLOG_TASK_NUMBER } });

  await mongoose.disconnect();
}

// BP-208 Task 11: a sprint whose tasks span every shape a numeric field's stored value takes in
// this database — a genuine number, a value the inline editor wrote as a string ("value: string"
// on ListView's onFieldChange), a string pre-dating CP-213's validation that isn't a number at
// all, and a task nobody ever gave one. Only a real MongoDB can say what $convert does with the
// last two — a unit test mocking Task.aggregate would just echo back whatever it's told to.
export const ESTIMATE_FIELD_ID = id("e2e00000000000000000f008");
export const ESTIMATE_SPRINT_ID = id("e2e00000000000000000c201");
export const ESTIMATE_SPRINT_NAME = "Sprint Estimates";

export const ESTIMATE_DONE_NUMERIC_TASK_ID = id("e2e00000000000000000d201");
export const ESTIMATE_OPEN_STRING_TASK_ID = id("e2e00000000000000000d202");
export const ESTIMATE_DONE_GARBLED_TASK_ID = id("e2e00000000000000000d203");
export const ESTIMATE_OPEN_ABSENT_TASK_ID = id("e2e00000000000000000d204");

export async function seedSprintEstimates() {
  const db = (await connect()).db!;
  const now = new Date();

  const pointsField = {
    ...fieldDefaults,
    _id: ESTIMATE_FIELD_ID,
    name: "Points",
    fieldType: "number",
    options: [],
    order: 0,
  };
  await db.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { customFields: [pointsField], estimateFieldId: String(ESTIMATE_FIELD_ID) } }
  );

  await db.collection("sprints").insertOne({
    _id: ESTIMATE_SPRINT_ID,
    project: PROJECT_ID,
    name: ESTIMATE_SPRINT_NAME,
    startDate: now,
    endDate: new Date(now.getTime() + 14 * 86_400_000),
    goal: "",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  const task = taskFactory(now);
  await db.collection("tasks").insertMany([
    task({
      _id: ESTIMATE_DONE_NUMERIC_TASK_ID,
      taskNumber: 101,
      title: "Estimated and done",
      status: "done",
      sprint: ESTIMATE_SPRINT_ID,
      customFieldValues: { [String(ESTIMATE_FIELD_ID)]: 5 },
      order: 0,
    }),
    task({
      _id: ESTIMATE_OPEN_STRING_TASK_ID,
      taskNumber: 102,
      title: "Estimated through the inline editor, still open",
      status: "in_progress",
      sprint: ESTIMATE_SPRINT_ID,
      customFieldValues: { [String(ESTIMATE_FIELD_ID)]: "3" },
      order: 1,
    }),
    task({
      _id: ESTIMATE_DONE_GARBLED_TASK_ID,
      taskNumber: 103,
      title: "Done, but its value predates validation",
      status: "done",
      sprint: ESTIMATE_SPRINT_ID,
      customFieldValues: { [String(ESTIMATE_FIELD_ID)]: "TBD" },
      order: 2,
    }),
    task({
      _id: ESTIMATE_OPEN_ABSENT_TASK_ID,
      taskNumber: 104,
      title: "Never estimated",
      status: "in_progress",
      sprint: ESTIMATE_SPRINT_ID,
      customFieldValues: {},
      order: 3,
    }),
  ]);
  await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: 104 } });

  await mongoose.disconnect();
}

// BP-389. A board with a sprint history: two sprints already closed, one running with a finished
// and an unfinished task in it, and one planned. A third close puts it on OLDER_COMPLETED_THRESHOLD
// (src/lib/sprint-selection.ts), so a fourth completed sprint hides one behind "Show N older". Enough for the whole lifecycle to be driven from
// the screens — activate, edit, close — and for the velocity chart to have two real totals to
// plot rather than a fixture of its own.
const LIFECYCLE_POINTS_FIELD_ID = id("e2e00000000000000000f009");

export const LIFECYCLE_PAST_ONE_ID = id("e2e00000000000000000c401");
export const LIFECYCLE_PAST_ONE_NAME = "Sprint 5";
// Delivered, and the sprint also carries an unfinished task worth LIFECYCLE_PAST_ONE_ABANDONED —
// so a chart plotting committed points instead of delivered ones reads a different number
export const LIFECYCLE_PAST_ONE_DELIVERED = 8;
export const LIFECYCLE_PAST_ONE_ABANDONED = 4;

const LIFECYCLE_PAST_TWO_ID = id("e2e00000000000000000c402");
// Numbered above every other sprint and *not* the latest-ending one, so the form's suggestion
// tells "the latest sprint plus one" apart from "the highest number plus one"
export const LIFECYCLE_PAST_TWO_NAME = "Sprint 12";
export const LIFECYCLE_PAST_TWO_DELIVERED = 2;

export const LIFECYCLE_CURRENT_ID = id("e2e00000000000000000c403");
export const LIFECYCLE_CURRENT_NAME = "Sprint 7";
export const LIFECYCLE_CURRENT_GOAL = "Get the mooring mast up";

export const LIFECYCLE_PLANNED_ID = id("e2e00000000000000000c404");
export const LIFECYCLE_PLANNED_NAME = "Sprint 8";

const LIFECYCLE_FINISHED_TASK_ID = id("e2e00000000000000000d401");
export const LIFECYCLE_FINISHED_TASK_NUMBER = 120;

const LIFECYCLE_UNFINISHED_TASK_ID = id("e2e00000000000000000d402");
export const LIFECYCLE_UNFINISHED_TASK_NUMBER = 121;

// In the backlog and in the done column at once. Whether the planning view offers it is decided in
// the browser (PlanningView's columnIdsWithRole), and /tasks?sprint=backlog returns it either way —
// so it is the one thing on this board no server response can answer for.
export const LIFECYCLE_BACKLOG_DONE_TASK_NUMBER = 125;
export const LIFECYCLE_BACKLOG_DONE_TASK_TITLE = "Finished long before this sprint";

export async function seedSprintLifecycle() {
  const db = (await connect()).db!;
  const now = new Date();
  const day = 86_400_000;
  const dates = (fromDays: number, toDays: number) => ({
    startDate: new Date(now.getTime() + fromDays * day),
    endDate: new Date(now.getTime() + toDays * day),
  });

  await db.collection("projects").updateOne(
    { _id: PROJECT_ID },
    {
      $set: {
        customFields: [
          {
            ...fieldDefaults,
            _id: LIFECYCLE_POINTS_FIELD_ID,
            name: "Points",
            fieldType: "number",
            options: [],
            order: 0,
          },
        ],
        estimateFieldId: String(LIFECYCLE_POINTS_FIELD_ID),
      },
    }
  );

  const sprint = (over: Record<string, unknown>) => ({
    project: PROJECT_ID,
    goal: "",
    createdAt: now,
    updatedAt: now,
    ...over,
  });

  await db.collection("sprints").insertMany([
    sprint({
      _id: LIFECYCLE_PAST_ONE_ID,
      name: LIFECYCLE_PAST_ONE_NAME,
      status: "completed",
      ...dates(-60, -46),
    }),
    sprint({
      _id: LIFECYCLE_PAST_TWO_ID,
      name: LIFECYCLE_PAST_TWO_NAME,
      status: "completed",
      ...dates(-45, -31),
    }),
    sprint({
      _id: LIFECYCLE_CURRENT_ID,
      name: LIFECYCLE_CURRENT_NAME,
      goal: LIFECYCLE_CURRENT_GOAL,
      status: "active",
      ...dates(-3, 11),
    }),
    // Planned, and ending last, so the new-sprint form's suggestion chains off this one
    sprint({
      _id: LIFECYCLE_PLANNED_ID,
      name: LIFECYCLE_PLANNED_NAME,
      status: "planned",
      ...dates(12, 26),
    }),
  ]);

  const points = (value: number) => ({ [String(LIFECYCLE_POINTS_FIELD_ID)]: value });
  const task = taskFactory(now);
  await db.collection("tasks").insertMany([
    task({
      _id: LIFECYCLE_FINISHED_TASK_ID,
      taskNumber: LIFECYCLE_FINISHED_TASK_NUMBER,
      title: "Finished before the sprint closed",
      status: "done",
      sprint: LIFECYCLE_CURRENT_ID,
      customFieldValues: points(5),
      order: 0,
    }),
    task({
      _id: LIFECYCLE_UNFINISHED_TASK_ID,
      taskNumber: LIFECYCLE_UNFINISHED_TASK_NUMBER,
      title: "Still unfinished when the sprint closed",
      status: "in_progress",
      sprint: LIFECYCLE_CURRENT_ID,
      customFieldValues: points(3),
      order: 1,
    }),
    task({
      taskNumber: 122,
      title: "Delivered in Sprint 5",
      status: "done",
      sprint: LIFECYCLE_PAST_ONE_ID,
      customFieldValues: points(LIFECYCLE_PAST_ONE_DELIVERED),
      order: 0,
    }),
    task({
      taskNumber: LIFECYCLE_BACKLOG_DONE_TASK_NUMBER,
      title: LIFECYCLE_BACKLOG_DONE_TASK_TITLE,
      status: "done",
      sprint: null,
      order: 0,
    }),
    task({
      taskNumber: 124,
      title: "Committed to Sprint 5 and never finished",
      status: "in_progress",
      sprint: LIFECYCLE_PAST_ONE_ID,
      customFieldValues: points(LIFECYCLE_PAST_ONE_ABANDONED),
      order: 1,
    }),
    task({
      taskNumber: 123,
      title: "Delivered in Sprint 6",
      status: "done",
      sprint: LIFECYCLE_PAST_TWO_ID,
      customFieldValues: points(LIFECYCLE_PAST_TWO_DELIVERED),
      order: 0,
    }),
  ]);
  await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: 125 } });

  await mongoose.disconnect();
}

/**
 * Takes the `done` role off the board's only column that carries it, leaving the column itself in
 * place, so nothing on this board can be finished any more.
 */
export async function demoteDoneColumn() {
  const db = (await connect()).db!;
  const result = await db
    .collection("projects")
    .updateOne(
      { _id: PROJECT_ID },
      { $set: { "columns.$[column].role": "review" } },
      { arrayFilters: [{ "column.id": "done" }] }
    );
  await mongoose.disconnect();
  // An array filter matching nothing updates nothing and still succeeds, which would leave the
  // board finishing tasks as usual and the failure naming the product rather than this line
  if (result.modifiedCount !== 1) {
    throw new Error(`demoteDoneColumn changed ${result.modifiedCount} boards, expected 1`);
  }
}

/**
 * Takes the `active` role off the board's only column that carries it, leaving the column in
 * place, so a worker on this board has nowhere to move a task it takes (BP-512). Written straight
 * to the database because the columns endpoint refuses to create this state — which is the point
 * of the specs that use it.
 */
export async function demoteActiveColumn() {
  const db = (await connect()).db!;
  const result = await db
    .collection("projects")
    .updateOne(
      { _id: PROJECT_ID },
      { $set: { "columns.$[column].role": "review" } },
      { arrayFilters: [{ "column.id": "in_progress" }] }
    );
  await mongoose.disconnect();
  if (result.modifiedCount !== 1) {
    throw new Error(`demoteActiveColumn changed ${result.modifiedCount} boards, expected 1`);
  }
}

/** A sprint as the database holds it, for assertions the API's derived counts would blur. */
export async function storedSprint(sprintId: mongoose.Types.ObjectId) {
  const db = (await connect()).db!;
  const row = await db.collection("sprints").findOne({ _id: sprintId });
  await mongoose.disconnect();
  return row;
}

/** The sprint a task belongs to, as an id string, or null when it is back in the backlog. */
export async function storedTaskSprint(taskNumber: number): Promise<string | null> {
  const db = (await connect()).db!;
  const row = await db.collection("tasks").findOne({ project: PROJECT_ID, taskNumber });
  await mongoose.disconnect();
  if (!row) throw new Error(`no task ${taskNumber} on the seeded board`);
  return row.sprint ? String(row.sprint) : null;
}

// BP-402. A second person with a grant on the board and no notification preferences of any kind —
// the control for the task_created row. Their silence is what tells a working opt-in apart from a
// notification pipeline that is not wired up in this environment at all.
export const BYSTANDER_USERNAME = "bystander";
export const BYSTANDER_PASSWORD = "test1234";
const BYSTANDER_PASSWORD_HASH = bcrypt.hashSync(BYSTANDER_PASSWORD, 10);
export const BYSTANDER_ID = id("e2e00000000000000000a005");

export async function seedBoardFeedBystander() {
  const db = (await connect()).db!;
  const now = new Date();

  await db.collection("users").insertOne({
    _id: BYSTANDER_ID,
    username: BYSTANDER_USERNAME,
    password: BYSTANDER_PASSWORD_HASH,
    fullName: "E2E Bystander",
    email: "",
    emailNotifications: false,
    collapseEmptyColumns: false,
    kind: "human",
    role: "member",
    createdAt: now,
  });

  await db.collection("grants").insertOne({
    _id: id("e2e00000000000000000e002"),
    subject: BYSTANDER_ID,
    relation: "member",
    objectType: "project",
    object: PROJECT_ID,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  });

  await mongoose.disconnect();
}

export async function seedQuietTask(quietForMs: number) {
  const now = new Date();
  await addTask(
    {
      _id: QUIET_TASK_ID,
      title: QUIET_TASK_TITLE,
      status: SOURCE_COLUMN.id,
      order: 3,
      execution: {
        runId: "e2e-run-0003",
        workerId: String(WORKER_ID),
        attempts: 1,
        // Older than the silence, so the card cannot read as live off either timestamp: it
        // falls back to startedAt when phaseAt is missing
        startedAt: new Date(now.getTime() - quietForMs - 60_000),
        lastError: "",
        phase: RUN_PHASE,
        phaseAt: new Date(now.getTime() - quietForMs),
        phaseSeq: 2,
      },
    },
    QUIET_TASK_NUMBER
  );
}

/**
 * The board every spec starts from.
 *
 * `withSessions` is what the auth suite turns off: it counts the rows in `sessions` to say what a
 * sign-in, a logout or a password change did, and a session seeded for the convenience of every
 * other spec is a second row those counts cannot tell from the one under test.
 */
async function seedBoard(withSessions: boolean) {
  const db = (await connect()).db!;
  await empty(db);

  const now = new Date();

  const person = (over: Record<string, unknown>) => ({
    email: "",
    emailNotifications: false,
    // Off, so every column stays a real drop target instead of collapsing to a rail
    collapseEmptyColumns: false,
    kind: "human",
    createdAt: now,
    ...over,
  });

  await db.collection("users").insertMany([
    person({
      _id: ADMIN_ID,
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD_HASH,
      fullName: "E2E Admin",
      role: "admin",
    }),
    person({
      _id: MEMBER_ID,
      username: MEMBER_USERNAME,
      password: MEMBER_PASSWORD_HASH,
      fullName: "E2E Member",
      // Not "admin": this account has no standing on the instance at all, and everything it can
      // reach on this project it reaches through the grant below
      role: "member",
    }),
  ]);

  await db.collection("grants").insertOne({
    _id: GRANT_ID,
    subject: MEMBER_ID,
    relation: "member",
    objectType: "project",
    object: PROJECT_ID,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  });

  await db.collection("projects").insertOne({
    _id: PROJECT_ID,
    name: PROJECT_NAME,
    key: PROJECT_KEY,
    description: "Seeded by the Playwright run-conflict test",
    icon: "",
    categories: CATEGORIES,
    columns: COLUMNS,
    taskTemplates: [],
    customFields: [],
    webhooks: [],
    notificationChannels: [],
    pm: {
      // On, so a turn can actually run against the stubbed model. dailyTurnCap must be positive:
      // isOverDailyTurnCap compares used >= cap, so a zero cap refuses the very first turn.
      enabled: true,
      lockedByInstance: false,
      model: "e2e/stub-model",
      contextNotes: "",
      dailyTurnCap: 50,
      autonomy: {
        dailyReview: false,
        reviewHour: 9,
        reviewIntervalHours: 24,
        timezone: "Europe/Warsaw",
        handleNeedsHumanReview: false,
        lastReviewSlot: "",
      },
      links: [],
      mcpServers: [],
    },
    worker: {
      enabled: true,
      policy: {
        autoMerge: false,
        reviewGate: true,
        baseBranch: "main",
        taskTimeoutMs: 1_800_000,
        maxDiffLines: 400,
        maxDiffFiles: 10,
        model: "opus",
        fallbackModel: "sonnet",
        reviewModel: "opus",
      },
      policyOverrides: [],
    },
    repositoryUrl: "",
    githubRepo: "",
    githubToken: "",
    gitlabRepo: "",
    gitlabHost: "https://gitlab.com",
    gitlabToken: "",
    codaHost: "https://coda.io",
    codaDocId: "",
    codaTableId: "",
    codaToken: "",
    taskCounter: 4,
    sortOrder: 0,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  });

  await db.collection("apitokens").insertMany([
    {
      _id: id("e2e00000000000000000a003"),
      user: ADMIN_ID,
      name: "e2e mcp",
      tokenHash: API_TOKEN_HASH,
      prefix: API_TOKEN.slice(0, 11),
      allowedProjects: [],
      lastUsedAt: null,
      createdAt: now,
    },
    {
      _id: id("e2e00000000000000000a004"),
      user: MEMBER_ID,
      name: "e2e member",
      tokenHash: MEMBER_API_TOKEN_HASH,
      prefix: MEMBER_API_TOKEN.slice(0, 11),
      allowedProjects: [],
      lastUsedAt: null,
      createdAt: now,
    },
  ]);

  const sessionRow = (token: string, user: mongoose.Types.ObjectId) => ({
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    user,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    absoluteExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
    lastUsedAt: now,
    userAgent: "",
    ip: "",
    createdAt: now,
  });

  if (withSessions) {
    await db
      .collection("sessions")
      .insertMany([
        sessionRow(ADMIN_SESSION_TOKEN, ADMIN_ID),
        sessionRow(MEMBER_SESSION_TOKEN, MEMBER_ID),
      ]);
  }

  await db.collection("workers").insertOne({
    _id: WORKER_ID,
    name: WORKER_NAME,
    host: "e2e-host",
    platform: "darwin",
    version: "0.0.0-e2e",
    protocolVersion: 1,
    credentialHash: WORKER_CREDENTIAL_HASH,
    repos: [],
    policy: { pollIntervalMs: 30_000 },
    policyOverrides: [],
    enabled: true,
    lockedByInstance: false,
    lastSeenAt: now,
    identity: null,
    bindingError: "",
    preflight: null,
    command: "",
    commandIssuedAt: null,
    commandAckedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const task = taskFactory(now);

  await db.collection("tasks").insertMany([
    task({
      _id: HELD_TASK_ID,
      taskNumber: HELD_TASK_NUMBER,
      title: HELD_TASK_TITLE,
      status: SOURCE_COLUMN.id,
      // runId is what makes the run live: task-service keys the refusal on it, and clears it
      // on release. phaseAt is stamped now so the card reads as alive rather than gone quiet.
      execution: {
        runId: "e2e-run-0001",
        workerId: String(WORKER_ID),
        attempts: 1,
        startedAt: new Date(now.getTime() - 60_000),
        lastError: "",
        phase: RUN_PHASE,
        phaseAt: now,
        phaseSeq: 7,
      },
    }),
    task({
      _id: DECOY_TASK_ID,
      taskNumber: DECOY_TASK_NUMBER,
      title: DECOY_TASK_TITLE,
      status: TARGET_COLUMN.id,
      order: 1,
    }),
    task({
      _id: SIBLING_TASK_ID,
      taskNumber: SIBLING_TASK_NUMBER,
      title: SIBLING_TASK_TITLE,
      status: SOURCE_COLUMN.id,
      order: 1,
    }),
    task({
      _id: FINISHED_TASK_ID,
      taskNumber: FINISHED_TASK_NUMBER,
      title: FINISHED_TASK_TITLE,
      status: SPARE_COLUMN.id,
      // Exactly what a finished run leaves behind: releasing a task $unsets runId and the phase
      // trio, and keeps workerId and startedAt as history. Nothing here still holds the task, so
      // it must move like any other card — no card badge, no refusal, no dialog.
      execution: {
        workerId: String(WORKER_ID),
        attempts: 1,
        startedAt: new Date(now.getTime() - 3_600_000),
        lastError: "",
      },
    }),
  ]);

  await mongoose.disconnect();
}

export const seed = () => seedBoard(true);

/**
 * A board that hands off from two columns at once — a state the settings screen warns about and
 * the product does not support. The flag used to be a per-column checkbox, so a project could
 * carry several; the editor cannot reach the state any more, which is exactly why the fixture has
 * to write it. `escalationColumnId` resolves the first review column carrying the flag, so this
 * makes In Review the survivor and Needs Human Review the stranded one.
 */
export async function seedSecondEscalationColumn() {
  const db = (await connect()).db!;
  await db
    .collection("projects")
    .updateOne(
      { _id: PROJECT_ID, "columns.id": "in_review" },
      { $set: { "columns.$.triggersPmReview": true } }
    );
  await mongoose.disconnect();
}

/**
 * One column id this board does not share with `DEFAULT_PROJECT_COLUMNS`.
 *
 * The seeded columns are byte-identical to those seven, so a reader that forgets to LOAD a board's
 * columns falls back to them and answers exactly as a correct one does — every claim that
 * project-defined columns decide is invisible on this fixture. Renaming one id separates the two
 * answers in both directions: the new id has to be accepted and the old one refused.
 */
export const RENAMED_COLUMN_ID = "parked";

export async function seedRenamedColumn() {
  const db = (await connect()).db!;
  await db
    .collection("projects")
    .updateOne(
      { _id: PROJECT_ID, "columns.id": "planned" },
      { $set: { "columns.$.id": RENAMED_COLUMN_ID, "columns.$.label": "Parked" } }
    );
  await mongoose.disconnect();
}

/** seed(), minus the two session rows — see seedBoard. */
export const seedWithoutSessions = () => seedBoard(false);

// BP-386. Search answers differently depending on who is asking, so the corpus is two boards
// sharing one word: the member holds a grant on TP only, and SEARCH_WORD matches a task on each.
// A single-board fixture cannot tell an enforced project filter from an absent one.
export const OTHER_PROJECT_ID = id("e2e00000000000000000c301");
export const OTHER_PROJECT_KEY = "SB";
export const OTHER_PROJECT_NAME = "E2E Second Search Board";

// Stored capitalised and queried in lower case, so a search that only matches literally cannot pass
export const SEARCH_WORD = "zeppelin";

export const TITLE_HIT_ID = id("e2e00000000000000000d301");
export const TITLE_HIT_NUMBER = 10;
export const TITLE_HIT_TITLE = "Zeppelin mooring mast";

// The word appears nowhere in the title: this is the hit that only a description search finds
export const BODY_HIT_ID = id("e2e00000000000000000d302");
export const BODY_HIT_NUMBER = 11;
export const BODY_HIT_TITLE = "Airship paperwork";
export const BODY_HIT_DESCRIPTION = "Ordered a new Zeppelin cable for the gondola.";

// Carried in a description and in no title anywhere, on both boards. The endpoint ORs title and
// description together, so a project filter pushed into one arm of that $or would leak every
// description on the instance while a title-matched leak test stayed green.
export const BODY_ONLY_WORD = "gondola";

export const OTHER_HIT_ID = id("e2e00000000000000000d303");
export const OTHER_HIT_NUMBER = 1;
export const OTHER_HIT_TITLE = "Zeppelin hangar on the other board";
export const OTHER_HIT_DESCRIPTION = "Spare gondola parts live in this hangar.";
export const OTHER_HIT_KEY = `${OTHER_PROJECT_KEY}-${OTHER_HIT_NUMBER}`;

// A word no seeded task carries, for the no-results state
export const ABSENT_WORD = "quokka";

// Its priority key is deliberately absent, the way a task predating the field is stored. The
// endpoint applies the default on the way out and the page renders a badge from it, so a corpus
// where every task already carries one leaves both unexercised.
export const LEGACY_HIT_ID = id("e2e00000000000000000d304");
export const LEGACY_HIT_NUMBER = 12;
export const LEGACY_HIT_WORD = "dirigible";
export const LEGACY_HIT_TITLE = "Dirigible logbook from before priorities";
export const LEGACY_HIT_KEY = `${PROJECT_KEY}-${LEGACY_HIT_NUMBER}`;

// Regex metacharacters in a title people would actually type. Escaped, "[v2]" finds this one
// task; unescaped it is a character class and matches every title holding a "v" or a "2".
export const META_HIT_ID = id("e2e00000000000000000d305");
export const META_HIT_NUMBER = 13;
export const META_HIT_TITLE = "Rewrite the (old) mast [v2]";
export const META_QUERY = "[v2]";
// Escaped this matches nothing; unescaped it matches everything
export const META_WILDCARD = ".*";

/**
 * Never fold this into seed(). What seed() lays down is a contract other specs count against, in
 * two dimensions:
 *
 * - tasks — kanban-board-core.spec.ts counts cards against SEEDED_TASKS = 4 and asserts the number
 *   the next created task is minted with, so four more tasks on TP and a taskCounter of 13 break it;
 * - projects — a screen that lists every board the reader can reach (the OAuth consent screen is
 *   the one that counts them) would silently gain a row for this second board.
 *
 * Both are elsewhere in the suite, and neither failure names this function.
 */
export async function seedSearchCorpus() {
  const db = (await connect()).db!;
  const now = new Date();

  await db.collection("projects").insertOne({
    _id: OTHER_PROJECT_ID,
    name: OTHER_PROJECT_NAME,
    key: OTHER_PROJECT_KEY,
    description: "",
    icon: "",
    categories: CATEGORIES.map((c) => ({ ...c, _id: new mongoose.Types.ObjectId() })),
    columns: COLUMNS.map((c) => ({ ...c, _id: new mongoose.Types.ObjectId() })),
    taskTemplates: [],
    customFields: [],
    webhooks: [],
    notificationChannels: [],
    pm: {
      enabled: false,
      lockedByInstance: false,
      model: "e2e/stub-model",
      contextNotes: "",
      dailyTurnCap: 50,
      autonomy: {
        dailyReview: false,
        reviewHour: 9,
        reviewIntervalHours: 24,
        timezone: "Europe/Warsaw",
        handleNeedsHumanReview: false,
        lastReviewSlot: "",
      },
      links: [],
      mcpServers: [],
    },
    worker: { enabled: false, policy: {}, policyOverrides: [] },
    repositoryUrl: "",
    githubRepo: "",
    githubToken: "",
    gitlabRepo: "",
    gitlabHost: "https://gitlab.com",
    gitlabToken: "",
    codaHost: "https://coda.io",
    codaDocId: "",
    codaTableId: "",
    codaToken: "",
    taskCounter: OTHER_HIT_NUMBER,
    sortOrder: 1,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  });

  // Distinct updatedAt, because the API sorts on it: the arrow-key test needs to know which hit
  // the cursor starts on and which one it lands on. Inserted in the OPPOSITE order to the one the
  // sort produces — a collection scan returns insertion order, so a corpus inserted newest-first
  // lets the sort be deleted with every test still green.
  const task = taskFactory(now);
  await db.collection("tasks").insertMany([
    task({
      _id: BODY_HIT_ID,
      taskNumber: BODY_HIT_NUMBER,
      title: BODY_HIT_TITLE,
      description: BODY_HIT_DESCRIPTION,
      status: SPARE_COLUMN.id,
      order: 11,
      updatedAt: new Date(now.getTime() - 2_000),
    }),
    task({
      _id: TITLE_HIT_ID,
      taskNumber: TITLE_HIT_NUMBER,
      title: TITLE_HIT_TITLE,
      status: SPARE_COLUMN.id,
      order: 10,
      updatedAt: new Date(now.getTime() - 1_000),
    }),
    task({
      _id: OTHER_HIT_ID,
      project: OTHER_PROJECT_ID,
      taskNumber: OTHER_HIT_NUMBER,
      title: OTHER_HIT_TITLE,
      description: OTHER_HIT_DESCRIPTION,
      status: SPARE_COLUMN.id,
      order: 0,
      updatedAt: new Date(now.getTime() - 3_000),
    }),
    task({
      _id: META_HIT_ID,
      taskNumber: META_HIT_NUMBER,
      title: META_HIT_TITLE,
      status: SPARE_COLUMN.id,
      order: 13,
      updatedAt: new Date(now.getTime() - 4_000),
    }),
  ]);

  // Inserted separately because the factory supplies a priority and this task is defined by not
  // having one — deleting the key is the only way to store the shape the default exists for.
  const legacy: Record<string, unknown> = task({
    _id: LEGACY_HIT_ID,
    taskNumber: LEGACY_HIT_NUMBER,
    title: LEGACY_HIT_TITLE,
    status: SPARE_COLUMN.id,
    order: 12,
    updatedAt: new Date(now.getTime() - 5_000),
  });
  delete legacy.priority;
  await db.collection("tasks").insertOne(legacy);

  await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: META_HIT_NUMBER } });

  await mongoose.disconnect();
}

/**
 * BP-400. Somebody with an account on this instance and no way whatsoever to reach this board:
 * role "member", and no grant. Seeded on request rather than by seed(), so specs that count the
 * instance's accounts keep meaning what they meant.
 *
 * The task comes with them, assigned while they still had access — the row the fix must leave
 * alone, and which the detail rail used to render as "Unassigned" because the roster no longer
 * carries the person it names.
 */
export const OUTSIDER_USERNAME = "outsider";
export const OUTSIDER_PASSWORD = "test1234";
const OUTSIDER_PASSWORD_HASH = bcrypt.hashSync(OUTSIDER_PASSWORD, 10);
export const OUTSIDER_FULL_NAME = "E2E Outsider";
export const OUTSIDER_ID = id("e2e00000000000000000a006");

// 14, not 10: the search fixture already seeds taskNumber 10 on this project and
// {project, taskNumber} is a unique index, so both fixtures in one test would collide
export const OUTSIDER_TASK_NUMBER = 14;
export const OUTSIDER_TASK_KEY = `${PROJECT_KEY}-${OUTSIDER_TASK_NUMBER}`;
export const OUTSIDER_TASK_TITLE = "Assigned before they lost access";

export async function seedAssignmentOutsider() {
  const db = (await connect()).db!;
  const now = new Date();

  await db.collection("users").insertOne({
    _id: OUTSIDER_ID,
    username: OUTSIDER_USERNAME,
    password: OUTSIDER_PASSWORD_HASH,
    fullName: OUTSIDER_FULL_NAME,
    email: "",
    emailNotifications: false,
    collapseEmptyColumns: false,
    kind: "human",
    // No grant is written for them anywhere in this file, and "member" carries no standing on the
    // instance — so this account reaches exactly nothing on this board.
    role: "member",
    createdAt: now,
  });

  await mongoose.disconnect();

  await addTask(
    {
      _id: id("e2e00000000000000000d010"),
      title: OUTSIDER_TASK_TITLE,
      status: "todo",
      assignee: OUTSIDER_ID,
      assignedBy: ADMIN_ID,
      order: 10,
    },
    OUTSIDER_TASK_NUMBER
  );
}

/**
 * BP-407. Delivery itself needs a real receiver, which loopback-blocked `safeFetch` refuses under
 * BP-408 — so what this seeds is the OUTCOME of an attempt, the shape `dispatchWebhooks` writes
 * back onto a webhook row after one, not a delivery this fixture actually performs.
 *
 * Both rows, not just the failed one: a page that always prints "Last delivery failed" regardless
 * of what is stored would pass a fixture carrying only the negative case.
 */
export const WEBHOOK_OK_ID = id("e2e00000000000000000f001");
export const WEBHOOK_UNTRIED_ID = id("e2e00000000000000000ba03");
export const WEBHOOK_FAILED_ID = id("e2e00000000000000000f002");

export async function seedWebhookDeliveryOutcomes() {
  const db = (await connect()).db!;

  await db.collection("projects").updateOne(
    { _id: PROJECT_ID },
    {
      $set: {
        webhooks: [
          {
            _id: WEBHOOK_OK_ID,
            url: "https://e2e-receiver.example/ok",
            events: ["task_created"],
            enabled: true,
            lastAttemptAt: new Date(Date.now() - 5 * 60_000),
            lastStatus: "ok",
            lastError: "",
          },
          {
            _id: WEBHOOK_FAILED_ID,
            url: "https://e2e-receiver.example/fails",
            events: ["task_created"],
            enabled: true,
            lastAttemptAt: new Date(Date.now() - 5 * 60_000),
            lastStatus: "failed",
            lastError: "connect ECONNREFUSED",
          },
          // Never delivered to. The control for the panel: without it, a panel that printed an
          // outcome for every endpoint would satisfy every assertion about the other two.
          {
            _id: WEBHOOK_UNTRIED_ID,
            url: "https://e2e-receiver.example/never-tried",
            events: ["task_created"],
            enabled: true,
          },
        ],
      },
    }
  );

  await mongoose.disconnect();
}

// BP-396. A second board the consent screen offers and the test deliberately leaves unticked, so
// "the token sees only what was granted" has something it could have seen and did not. Without it
// the assertion holds on a board of one project whatever the scope does.
export const SECOND_PROJECT_ID = id("e2e00000000000000000c601");
export const SECOND_PROJECT_KEY = "IB";
export const SECOND_PROJECT_NAME = "E2E Board Nobody Granted";

export async function seedSecondProject() {
  const db = (await connect()).db!;
  const now = new Date();

  await db.collection("projects").insertOne({
    _id: SECOND_PROJECT_ID,
    name: SECOND_PROJECT_NAME,
    key: SECOND_PROJECT_KEY,
    description: "",
    icon: "",
    categories: CATEGORIES,
    columns: COLUMNS,
    taskTemplates: [],
    customFields: [],
    webhooks: [],
    notificationChannels: [],
    worker: { enabled: false, policy: {}, policyOverrides: [] },
    repositoryUrl: "",
    githubRepo: "",
    githubToken: "",
    gitlabRepo: "",
    gitlabHost: "https://gitlab.com",
    gitlabToken: "",
    taskCounter: 0,
    sortOrder: 1,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  });

  await mongoose.disconnect();
}

/**
 * BP-433. A second instance admin, and a card on the second board for them to be given.
 *
 * The point of the shape is what happens after a demotion. This account holds a grant on
 * SECOND_PROJECT_ID and none at all on the seeded board, so demoting it to "member" leaves its
 * accessible list non-empty — which is what makes the read routes' `project: { $in: ... }` clause
 * load-bearing rather than shadowed by their "no boards at all" early return. An account with no
 * grant anywhere would take that early return instead and the filter itself would never run.
 *
 * A demotion is also the door: PUT /api/users/[userId] changes the role and leaves grants,
 * sessions and notifications exactly where they were.
 *
 * Requires seedSecondProject() to have run — the grant and the task both point at that board.
 */
export const AUDITOR_USERNAME = "auditor";
export const AUDITOR_PASSWORD = "test1234";
const AUDITOR_PASSWORD_HASH = bcrypt.hashSync(AUDITOR_PASSWORD, 10);
export const AUDITOR_FULL_NAME = "E2E Auditor";
export const AUDITOR_ID = id("e2e00000000000000000a007");

export const KEPT_TASK_NUMBER = 1;
export const KEPT_TASK_KEY = `${SECOND_PROJECT_KEY}-${KEPT_TASK_NUMBER}`;
export const KEPT_TASK_ID = id("e2e00000000000000000d020");
export const KEPT_TASK_TITLE = "On the board they keep";

export async function seedDemotableAdmin() {
  const db = (await connect()).db!;
  const now = new Date();

  await db.collection("users").insertOne({
    _id: AUDITOR_ID,
    username: AUDITOR_USERNAME,
    password: AUDITOR_PASSWORD_HASH,
    fullName: AUDITOR_FULL_NAME,
    email: "",
    emailNotifications: false,
    collapseEmptyColumns: false,
    kind: "human",
    // Everything this account reaches on the seeded board, it reaches through this and nothing
    // else. Taking it away is the whole test.
    role: "admin",
    createdAt: now,
  });

  await db.collection("grants").insertOne({
    _id: id("e2e00000000000000000e003"),
    subject: AUDITOR_ID,
    relation: "member",
    objectType: "project",
    object: SECOND_PROJECT_ID,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  });

  await db.collection("tasks").insertOne(
    taskFactory(now)({
      _id: KEPT_TASK_ID,
      project: SECOND_PROJECT_ID,
      taskNumber: KEPT_TASK_NUMBER,
      title: KEPT_TASK_TITLE,
      status: "todo",
    })
  );
  await db
    .collection("projects")
    .updateOne({ _id: SECOND_PROJECT_ID }, { $max: { taskCounter: KEPT_TASK_NUMBER } });

  await mongoose.disconnect();
}

/** A webhook on the seeded project, written straight in: adding one through the settings screen is
 * settings-save.spec.ts's subject, and this file's tests are about what happens afterwards. */
export async function seedWebhook(
  url: string,
  events: string[] = ["task_created", "status_changed", "comment_added"]
) {
  const db = (await connect()).db!;
  await db.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { webhooks: [{ _id: new mongoose.Types.ObjectId(), url, events, enabled: true }] } }
  );
  await mongoose.disconnect();
}

/** What a project names as its repository. No token: storing one needs ENCRYPTION_KEY, which this
 * run deliberately does not set, and every assertion here is reached before a token is read. */
export async function seedRepository(fields: {
  repositoryUrl?: string;
  githubToken?: string;
  gitlabToken?: string;
  gitlabHost?: string;
}) {
  const db = (await connect()).db!;
  await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: fields });
  await mongoose.disconnect();
}

// What a sync leaves on a task once a pull request has been matched to its key. Written here
// rather than fetched, because the fetch is the one hop of this integration that cannot be run
// locally: fetchPullRequests names api.github.com in the code, and safe-fetch refuses a loopback
// address for GitLab — see the note at the top of external-integrations.spec.ts.
export const LINKED_PR_NUMBER = 178;
export const LINKED_PR_TITLE = "fix(board): keep the header visible";
export const LINKED_MR_NUMBER = 9;
export const LINKED_MR_TITLE = "TP-3 mirror the fix on the mirror";

export async function seedLinkedPRs() {
  const db = (await connect()).db!;
  const now = new Date();
  await db.collection("tasks").updateOne(
    { _id: SIBLING_TASK_ID },
    {
      $set: {
        linkedPRs: [
          {
            provider: "github",
            number: LINKED_PR_NUMBER,
            title: LINKED_PR_TITLE,
            state: "open",
            url: `https://github.com/example/board/pull/${LINKED_PR_NUMBER}`,
            mergedAt: null,
            updatedAt: now,
          },
          {
            provider: "gitlab",
            number: LINKED_MR_NUMBER,
            title: LINKED_MR_TITLE,
            state: "merged",
            url: `https://gitlab.com/example/board/-/merge_requests/${LINKED_MR_NUMBER}`,
            mergedAt: now,
            updatedAt: now,
          },
        ],
      },
    }
  );
  await mongoose.disconnect();
}

// BP-396. seed()'s categories are bug/doc/user-story/idea — character for character the fallback
// `generateTask` uses when a project offers none. A generated task landing on one of those proves
// nothing about the project's own list having been read, which is the CP-213 defect one field
// across. This is a category no fallback can produce.
export const EXTRA_CATEGORY = "chore";

export async function seedExtraCategory() {
  const db = (await connect()).db!;
  await db.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { categories: [...CATEGORIES, { _id: new mongoose.Types.ObjectId(), name: EXTRA_CATEGORY, color: "#0ea5e9" }] } }
  );
  await mongoose.disconnect();
}

/**
 * Backdates an access token's expiry and reports whether the row is still there.
 *
 * Only `accessExpiresAt` is moved. The TTL index sits on `refreshExpiresAt` (`models/oauthToken`),
 * so the row is not made a candidate for the reaper — and the caller asserts it survived anyway,
 * because a refusal caused by a missing row is not the refusal the test is about.
 */
/**
 * The row is there and readable, but carries no expiry — the shape BP-444 found reading
 * `.getTime()` off undefined, so an ordinary refusal left `verifyOAuthAccessToken` as a TypeError.
 * Returns whether the row survived, so a test cannot mistake a reaped row for the refusal.
 */
export async function stripAccessExpiry(accessToken: string): Promise<boolean> {
  const db = (await connect()).db!;
  const accessTokenHash = crypto.createHash("sha256").update(accessToken).digest("hex");
  await db
    .collection("oauthtokens")
    .updateOne({ accessTokenHash }, { $unset: { accessExpiresAt: "" } });
  const still = await db.collection("oauthtokens").findOne({ accessTokenHash });
  await mongoose.disconnect();
  return !!still;
}

export async function expireAccessToken(accessToken: string): Promise<boolean> {
  const db = (await connect()).db!;
  const accessTokenHash = crypto.createHash("sha256").update(accessToken).digest("hex");
  await db
    .collection("oauthtokens")
    .updateOne({ accessTokenHash }, { $set: { accessExpiresAt: new Date(Date.now() - 60_000) } });
  const still = await db.collection("oauthtokens").findOne({ accessTokenHash });
  await mongoose.disconnect();
  return !!still;
}

// BP-464. The two agents `update_task` resolves by name, and the two rules that resolution has to
// keep: a project agent anybody who may edit a TP task may choose, and a personal one of the
// admin's that only the admin's own tasks may carry. Both runnable — every agent is born empty,
// and an empty one is a draft a task refuses to carry.
export const PROJECT_AGENT_NAME = "Board Runner";
export const PERSONAL_AGENT_NAME = "Admin's own";

const RUNNABLE_COMPOSITION = {
  analysis: [],
  implementation: [{ key: "implement" }],
  verification: [],
  delivery: [{ key: "push" }],
};

export const PROJECT_AGENT_ID = id("e2e00000000000000000ab01");
export const PERSONAL_AGENT_ID = id("e2e00000000000000000ab02");

export async function seedAgents() {
  const db = (await connect()).db!;
  const now = new Date();
  const agent = (over: Record<string, unknown>) => ({
    description: "",
    owner: null,
    project: null,
    builtIn: false,
    composition: RUNNABLE_COMPOSITION,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  await db.collection("agents").insertMany([
    agent({ _id: PROJECT_AGENT_ID, name: PROJECT_AGENT_NAME, scope: "project", project: PROJECT_ID }),
    agent({ _id: PERSONAL_AGENT_ID, name: PERSONAL_AGENT_NAME, scope: "user", owner: ADMIN_ID }),
  ]);
  await mongoose.disconnect();
}

/**
 * A sprint on the second board, for the cross-project reference BP-314 closed: named through TP,
 * it has to be refused as if it did not exist. Requires seedSecondProject().
 */
export const FOREIGN_SPRINT_ID = id("e2e00000000000000000c701");
export const FOREIGN_SPRINT_NAME = "Their sprint";

export async function seedForeignSprint() {
  const db = (await connect()).db!;
  const now = new Date();
  await db.collection("sprints").insertOne({
    _id: FOREIGN_SPRINT_ID,
    project: SECOND_PROJECT_ID,
    name: FOREIGN_SPRINT_NAME,
    startDate: now,
    endDate: new Date(now.getTime() + 14 * 86_400_000),
    goal: "",
    status: "planned",
    createdAt: now,
    updatedAt: now,
  });
  await mongoose.disconnect();
}

/** A task on the seeded board as the database holds it, for the fields the API populates or renames. */
export async function storedTask(taskNumber: number): Promise<Record<string, unknown>> {
  const db = (await connect()).db!;
  const row = await db.collection("tasks").findOne({ project: PROJECT_ID, taskNumber });
  await mongoose.disconnect();
  if (!row) throw new Error(`no task ${taskNumber} on the seeded board`);
  return row as Record<string, unknown>;
}

// BP-469. The cross-board list on /my-tasks, which is the one screen whose whole subject is tasks
// this reader has on boards that agree on nothing but their column roles.
//
// Requires seedSecondProject(): the second group's tasks live on that board, and a list that spans
// exactly one project cannot tell grouping from a heading.
export const MINE_ACTIVE_NUMBER = 200;
export const MINE_ACTIVE_TITLE = "Painting the mooring mast";

// Two columns this board invented, and both are discriminators.
//
// `Triage Desk` is what role ordering is proved against: keyed on column *ids* it sorts last
// whatever it means, and keyed on the role it sits second. Its colour is the other half of that
// same fix.
//
// `Shipped` is what the Hide done filter is proved against. The board's seeded done column is
// called `done`, so a filter written as `status !== "done"` and one written on the column's role
// agree on it exactly — and the page's filter is the client-side one this spec is about.
export const MINE_CUSTOM_COLUMN = {
  id: "triage_desk",
  label: "Triage Desk",
  color: "#8b5cf6",
  role: "blocked",
  order: 7,
};
export const MINE_DONE_COLUMN = {
  id: "shipped",
  label: "Shipped",
  color: "#0f766e",
  role: "done",
  order: 8,
};
const EXTRA_COLUMNS = [MINE_CUSTOM_COLUMN, MINE_DONE_COLUMN].map((column) => ({
  _id: new mongoose.Types.ObjectId(),
  triggersPmReview: false,
  ...column,
}));

export const MINE_BLOCKED_NUMBER = 201;
export const MINE_BLOCKED_TITLE = "Waiting on the rivet order";

export const MINE_APPROVED_NUMBER = 202;
export const MINE_APPROVED_TITLE = "Ordering the gondola cable";

export const MINE_DONE_NUMBER = 203;
export const MINE_DONE_TITLE = "Riveting the keel, finished";

// Left behind by a deleted column: no such id on the board, so the server can resolve neither role
// nor label nor colour and the page has to show the row anyway.
export const MINE_ORPHAN_STATUS = "mothballed";
export const MINE_ORPHAN_NUMBER = 204;
export const MINE_ORPHAN_TITLE = "Left in a column that is gone";

// Assigned to the member, on the board the member can reach. Two jobs: the admin must not see it
// (the assignee filter), and it is the member's own control against the one below.
export const THEIRS_NUMBER = 205;
export const THEIRS_TITLE = "The member's own rivets";

// On the board the member holds no grant on. Assigned to them, so the only thing keeping it off
// their list is the project filter — which is what this row is here to prove. The spec reads it
// back as the admin, whose list carries no project clause, so that claim has a control.
export const THEIRS_UNREACHABLE_NUMBER = 2;
export const THEIRS_UNREACHABLE_TITLE = "On a board the member cannot reach";

export const MINE_OTHER_BOARD_NUMBER = 3;
export const MINE_OTHER_BOARD_TITLE = "A chore on the other board";

/**
 * `updatedAt` in minutes before now, per task.
 *
 * Deliberately the reverse of the order the page must put them in: the endpoint sorts on
 * `updatedAt` descending, so a page that dropped its sort altogether would render this list
 * backwards rather than in the order it happens to have been seeded in. Every value is distinct,
 * so the secondary key is stated rather than left to Mongo's tie-break.
 */
const MINUTES_OLD: Record<number, number> = {
  [MINE_ORPHAN_NUMBER]: 10,
  [MINE_DONE_NUMBER]: 20,
  [MINE_APPROVED_NUMBER]: 30,
  [MINE_OTHER_BOARD_NUMBER]: 40,
  [MINE_BLOCKED_NUMBER]: 50,
  [MINE_ACTIVE_NUMBER]: 60,
};

export async function seedMyTasks() {
  const db = (await connect()).db!;
  const now = new Date();
  const task = taskFactory(now);
  const aged = (taskNumber: number) => ({
    updatedAt: new Date(now.getTime() - (MINUTES_OLD[taskNumber] ?? 0) * 60_000),
  });

  await db
    .collection<{ columns: unknown[] }>("projects")
    .updateOne({ _id: PROJECT_ID }, { $push: { columns: { $each: EXTRA_COLUMNS } } });

  await db.collection("tasks").insertMany([
    task({
      _id: id("e2e00000000000000000d501"),
      taskNumber: MINE_ACTIVE_NUMBER,
      title: MINE_ACTIVE_TITLE,
      status: "in_progress",
      assignee: ADMIN_ID,
      priority: "high",
      ...aged(MINE_ACTIVE_NUMBER),
    }),
    task({
      _id: id("e2e00000000000000000d502"),
      taskNumber: MINE_BLOCKED_NUMBER,
      title: MINE_BLOCKED_TITLE,
      status: MINE_CUSTOM_COLUMN.id,
      assignee: ADMIN_ID,
      ...aged(MINE_BLOCKED_NUMBER),
    }),
    task({
      _id: id("e2e00000000000000000d503"),
      taskNumber: MINE_APPROVED_NUMBER,
      title: MINE_APPROVED_TITLE,
      status: "todo",
      assignee: ADMIN_ID,
      ...aged(MINE_APPROVED_NUMBER),
    }),
    task({
      _id: id("e2e00000000000000000d504"),
      taskNumber: MINE_DONE_NUMBER,
      title: MINE_DONE_TITLE,
      status: MINE_DONE_COLUMN.id,
      assignee: ADMIN_ID,
      ...aged(MINE_DONE_NUMBER),
    }),
    task({
      _id: id("e2e00000000000000000d505"),
      taskNumber: MINE_ORPHAN_NUMBER,
      title: MINE_ORPHAN_TITLE,
      status: MINE_ORPHAN_STATUS,
      assignee: ADMIN_ID,
      ...aged(MINE_ORPHAN_NUMBER),
    }),
    task({
      _id: id("e2e00000000000000000d506"),
      taskNumber: THEIRS_NUMBER,
      title: THEIRS_TITLE,
      status: "in_progress",
      assignee: MEMBER_ID,
    }),
    task({
      _id: id("e2e00000000000000000d507"),
      project: SECOND_PROJECT_ID,
      taskNumber: THEIRS_UNREACHABLE_NUMBER,
      title: THEIRS_UNREACHABLE_TITLE,
      status: "in_progress",
      assignee: MEMBER_ID,
    }),
    task({
      _id: id("e2e00000000000000000d508"),
      project: SECOND_PROJECT_ID,
      taskNumber: MINE_OTHER_BOARD_NUMBER,
      title: MINE_OTHER_BOARD_TITLE,
      status: "todo",
      assignee: ADMIN_ID,
      ...aged(MINE_OTHER_BOARD_NUMBER),
    }),
  ]);

  await db
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: THEIRS_NUMBER } });
  await db
    .collection("projects")
    .updateOne({ _id: SECOND_PROJECT_ID }, { $max: { taskCounter: MINE_OTHER_BOARD_NUMBER } });

  await mongoose.disconnect();
}

/**
 * Everything this reader has, finished. The page has two empty states and they say different
 * things — a fixture with no tasks at all can only reach the first. The board's own `Shipped`
 * column comes with it, for the same reason seedMyTasks adds it.
 */
export const MINE_ONLY_DONE_NUMBER = 210;
export const MINE_ONLY_DONE_TITLE = "The only thing left, and it is done";

export async function seedMyTasksAllDone() {
  const db = (await connect()).db!;
  await db
    .collection<{ columns: unknown[] }>("projects")
    .updateOne({ _id: PROJECT_ID }, { $push: { columns: { $each: EXTRA_COLUMNS } } });
  await mongoose.disconnect();

  await addTask(
    {
      _id: id("e2e00000000000000000d510"),
      title: MINE_ONLY_DONE_TITLE,
      status: MINE_DONE_COLUMN.id,
      assignee: ADMIN_ID,
    },
    MINE_ONLY_DONE_NUMBER
  );
}

/** Deletes a project row and nothing else, which is a state the product itself never leaves. */
export async function deleteProjectRow(projectId: mongoose.Types.ObjectId) {
  const db = (await connect()).db!;
  await db.collection("projects").deleteOne({ _id: projectId });
  await mongoose.disconnect();
}

/**
 * BP-469. A third board, for the one claim the projects list makes that a two-board fixture
 * cannot separate: the order.
 *
 * `/api/projects` sorts `{ sortOrder: 1, createdAt: -1 }`. This board is seeded last, so it is the
 * newest of the three, and carries sortOrder 0 like the seeded board — which puts it first under
 * the real rule and second under a sort that only reads createdAt (IB is newer than TP and would
 * come between them).
 *
 * It also carries a description and an icon of its own, where IB has neither, so the card's two
 * conditional halves both have a case.
 */
export const NEWEST_PROJECT_ID = id("e2e00000000000000000c801");
export const NEWEST_PROJECT_KEY = "NB";
export const NEWEST_PROJECT_NAME = "E2E Newest Board";
export const NEWEST_PROJECT_DESCRIPTION = "Seeded last, and dragged to the top";
export const NEWEST_PROJECT_ICON = "🚀";

export async function seedNewestProject() {
  const db = (await connect()).db!;
  const now = new Date();

  await db.collection("projects").insertOne({
    _id: NEWEST_PROJECT_ID,
    name: NEWEST_PROJECT_NAME,
    key: NEWEST_PROJECT_KEY,
    description: NEWEST_PROJECT_DESCRIPTION,
    icon: NEWEST_PROJECT_ICON,
    categories: CATEGORIES,
    columns: COLUMNS,
    taskTemplates: [],
    customFields: [],
    webhooks: [],
    notificationChannels: [],
    worker: { enabled: false, policy: {}, policyOverrides: [] },
    repositoryUrl: "",
    githubRepo: "",
    githubToken: "",
    gitlabRepo: "",
    gitlabHost: "https://gitlab.com",
    gitlabToken: "",
    taskCounter: 0,
    sortOrder: 0,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  });

  await mongoose.disconnect();
}
