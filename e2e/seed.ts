import mongoose from "mongoose";
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

const taskFactory = (now: Date) => (over: Record<string, unknown>) => ({
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

// BP-402. A second person with a grant on the board and no notification preferences of any kind —
// the control for the task_created row. Their silence is what tells a working opt-in apart from a
// notification pipeline that is not wired up in this environment at all.
export const BYSTANDER_USERNAME = "bystander";
export const BYSTANDER_PASSWORD = "test1234";
export const BYSTANDER_ID = id("e2e00000000000000000a005");

export async function seedBoardFeedBystander() {
  const db = (await connect()).db!;
  const now = new Date();

  await db.collection("users").insertOne({
    _id: BYSTANDER_ID,
    username: BYSTANDER_USERNAME,
    password: bcrypt.hashSync(BYSTANDER_PASSWORD, 10),
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

export async function seed() {
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
      password: bcrypt.hashSync(ADMIN_PASSWORD, 10),
      fullName: "E2E Admin",
      role: "admin",
    }),
    person({
      _id: MEMBER_ID,
      username: MEMBER_USERNAME,
      password: bcrypt.hashSync(MEMBER_PASSWORD, 10),
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
      tokenHash: bcrypt.hashSync(API_TOKEN, 10),
      prefix: API_TOKEN.slice(0, 11),
      allowedProjects: [],
      lastUsedAt: null,
      createdAt: now,
    },
    {
      _id: id("e2e00000000000000000a004"),
      user: MEMBER_ID,
      name: "e2e member",
      tokenHash: bcrypt.hashSync(MEMBER_API_TOKEN, 10),
      prefix: MEMBER_API_TOKEN.slice(0, 11),
      allowedProjects: [],
      lastUsedAt: null,
      createdAt: now,
    },
  ]);

  await db.collection("workers").insertOne({
    _id: WORKER_ID,
    name: WORKER_NAME,
    host: "e2e-host",
    platform: "darwin",
    version: "0.0.0-e2e",
    protocolVersion: 1,
    credentialHash: bcrypt.hashSync(WORKER_CREDENTIAL, 10),
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
