import mongoose from "mongoose";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

export const E2E_MONGODB_URI =
  process.env.E2E_MONGODB_URI ?? "mongodb://localhost:27017/boardplanner_e2e";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "test1234";

export const MEMBER_USERNAME = "member";
export const MEMBER_PASSWORD = "test1234";

export const OWNER_USERNAME = "owner";
export const OWNER_PASSWORD = "test1234";

export const PROJECT_KEY = "TP";
export const PROJECT_NAME = "E2E Run Conflict Board";

export const WORKER_NAME = "e2e-macbook-pro";
export const WORKER_CREDENTIAL = "e2e-worker-credential";

export const API_TOKEN = "cp_e2e00001deadbeefdeadbeefdeadbeef";
export const MEMBER_API_TOKEN = "cp_e2e00002deadbeefdeadbeefdeadbeef";

export const ADMIN_SESSION_TOKEN = "cps_e2e00003deadbeefdeadbeefdeadbeef";
export const MEMBER_SESSION_TOKEN = "cps_e2e00004deadbeefdeadbeefdeadbeef";
export const OWNER_SESSION_TOKEN = "cps_e2e00005deadbeefdeadbeefdeadbeef";
export const RUN_PHASE = "agent";

export const HELD_TASK_NUMBER = 1;
export const HELD_TASK_KEY = `${PROJECT_KEY}-${HELD_TASK_NUMBER}`;
export const HELD_TASK_TITLE = "Held by a live worker run";

export const DECOY_TASK_NUMBER = 2;
export const DECOY_TASK_TITLE = "Already in review";

export const SIBLING_TASK_NUMBER = 3;
export const SIBLING_TASK_KEY = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`;
export const SIBLING_TASK_TITLE = "Free to move";

export const FINISHED_TASK_NUMBER = 4;
export const FINISHED_TASK_KEY = `${PROJECT_KEY}-${FINISHED_TASK_NUMBER}`;
export const FINISHED_TASK_TITLE = "Its run already finished";

export const SECOND_HELD_TASK_NUMBER = 5;
export const SECOND_HELD_TASK_KEY = `${PROJECT_KEY}-${SECOND_HELD_TASK_NUMBER}`;
export const SECOND_HELD_TASK_TITLE = "Held by a second live worker run";

export const QUIET_TASK_NUMBER = 6;
export const QUIET_TASK_KEY = `${PROJECT_KEY}-${QUIET_TASK_NUMBER}`;
export const QUIET_TASK_TITLE = "Held by a run that has gone quiet";

export const SOURCE_COLUMN = { id: "in_progress", label: "In Progress" };
export const TARGET_COLUMN = { id: "in_review", label: "In Review" };
export const SPARE_COLUMN = { id: "todo", label: "To Do" };

const id = (hex: string) => new mongoose.Types.ObjectId(hex);

const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const MEMBER_PASSWORD_HASH = bcrypt.hashSync(MEMBER_PASSWORD, 10);
const API_TOKEN_HASH = bcrypt.hashSync(API_TOKEN, 10);
const MEMBER_API_TOKEN_HASH = bcrypt.hashSync(MEMBER_API_TOKEN, 10);
const OWNER_PASSWORD_HASH = bcrypt.hashSync(OWNER_PASSWORD, 10);
const WORKER_CREDENTIAL_HASH = bcrypt.hashSync(WORKER_CREDENTIAL, 10);

export const ADMIN_ID = id("e2e00000000000000000a001");
export const MEMBER_ID = id("e2e00000000000000000a002");
export const OWNER_ID = id("e2e00000000000000000a008");
export const PROJECT_ID = id("e2e00000000000000000c001");
export const WORKER_ID = id("e2e00000000000000000b001");
export const GRANT_ID = id("e2e00000000000000000e001");
export const OWNER_GRANT_ID = id("e2e00000000000000000e004");
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

async function empty(db: mongoose.mongo.Db) {
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  await Promise.all(names.map((name) => db.collection(name).deleteMany({})));
}

export async function wipe() {
  await empty((await connect()).db!);
  await mongoose.disconnect();
}

export async function storedExecution(
  taskId: mongoose.Types.ObjectId
): Promise<Record<string, unknown> | undefined> {
  const db = (await connect()).db!;
  const task = await db.collection("tasks").findOne({ _id: taskId }, { projection: { execution: 1 } });
  await mongoose.disconnect();
  return task?.execution as Record<string, unknown> | undefined;
}

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

async function addTask(over: Record<string, unknown>, taskNumber: number) {
  const db = (await connect()).db!;
  await db.collection("tasks").insertOne(taskFactory(new Date())({ taskNumber, ...over }));
  await db
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: taskNumber } });
  await mongoose.disconnect();
}

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

export const STRANDED_SPRINT_ID = id("e2e00000000000000000c105");
export const STRANDED_SPRINT_NAME = "Sprint 2";
export const STRANDED_TASK_ID = id("e2e00000000000000000d007");
export const STRANDED_TASK_NUMBER = 15;
export const STRANDED_TASK_TITLE = "Left in a sprint that already closed";

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
  spike: { _id: id("e2e00000000000000000f003"), name: "Spike?", fieldType: "checkbox", options: [] },
  points: { _id: id("e2e00000000000000000f004"), name: "Points", fieldType: "number", options: [] },
  target: { _id: id("e2e00000000000000000f005"), name: "Target", fieldType: "date", options: [] },
  notes: { _id: id("e2e00000000000000000f006"), name: "Notes", fieldType: "text", options: [] },
  retired: {
    _id: id("e2e00000000000000000f007"),
    name: "Retired",
    fieldType: "dropdown",
    archived: true,
    options: [{ id: "kept-value", value: "Kept", color: "#6b7280", order: 0 }],
  },
} as const;

const fieldDefaults = { required: false, showOnCard: false, showInList: false, filterable: false, archived: false };

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

const LIFECYCLE_POINTS_FIELD_ID = id("e2e00000000000000000f009");

export const LIFECYCLE_PAST_ONE_ID = id("e2e00000000000000000c401");
export const LIFECYCLE_PAST_ONE_NAME = "Sprint 5";
export const LIFECYCLE_PAST_ONE_DELIVERED = 8;
export const LIFECYCLE_PAST_ONE_ABANDONED = 4;

const LIFECYCLE_PAST_TWO_ID = id("e2e00000000000000000c402");
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
  if (result.modifiedCount !== 1) {
    throw new Error(`demoteDoneColumn changed ${result.modifiedCount} boards, expected 1`);
  }
}

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

export async function storedSprint(sprintId: mongoose.Types.ObjectId) {
  const db = (await connect()).db!;
  const row = await db.collection("sprints").findOne({ _id: sprintId });
  await mongoose.disconnect();
  return row;
}

export async function storedTaskSprint(taskNumber: number): Promise<string | null> {
  const db = (await connect()).db!;
  const row = await db.collection("tasks").findOne({ project: PROJECT_ID, taskNumber });
  await mongoose.disconnect();
  if (!row) throw new Error(`no task ${taskNumber} on the seeded board`);
  return row.sprint ? String(row.sprint) : null;
}

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

async function seedBoard(withSessions: boolean) {
  const db = (await connect()).db!;
  await empty(db);

  const now = new Date();

  const person = (over: Record<string, unknown>) => ({
    email: "",
    emailNotifications: false,
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
      role: "member",
    }),
    person({
      _id: OWNER_ID,
      username: OWNER_USERNAME,
      password: OWNER_PASSWORD_HASH,
      fullName: "E2E Owner",
      role: "member",
    }),
  ]);

  await db.collection("grants").insertMany([
    {
      _id: GRANT_ID,
      subject: MEMBER_ID,
      relation: "member",
      objectType: "project",
      object: PROJECT_ID,
      createdBy: ADMIN_ID,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: OWNER_GRANT_ID,
      subject: OWNER_ID,
      relation: "owner",
      objectType: "project",
      object: PROJECT_ID,
      createdBy: ADMIN_ID,
      createdAt: now,
      updatedAt: now,
    },
  ]);

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
        sessionRow(OWNER_SESSION_TOKEN, OWNER_ID),
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

export const seedWithoutSessions = () => seedBoard(false);

export const OTHER_PROJECT_ID = id("e2e00000000000000000c301");
export const OTHER_PROJECT_KEY = "SB";
export const OTHER_PROJECT_NAME = "E2E Second Search Board";

export const SEARCH_WORD = "zeppelin";

export const TITLE_HIT_ID = id("e2e00000000000000000d301");
export const TITLE_HIT_NUMBER = 10;
export const TITLE_HIT_TITLE = "Zeppelin mooring mast";

export const BODY_HIT_ID = id("e2e00000000000000000d302");
export const BODY_HIT_NUMBER = 11;
export const BODY_HIT_TITLE = "Airship paperwork";
export const BODY_HIT_DESCRIPTION = "Ordered a new Zeppelin cable for the gondola.";

export const BODY_ONLY_WORD = "gondola";

export const OTHER_HIT_ID = id("e2e00000000000000000d303");
export const OTHER_HIT_NUMBER = 1;
export const OTHER_HIT_TITLE = "Zeppelin hangar on the other board";
export const OTHER_HIT_DESCRIPTION = "Spare gondola parts live in this hangar.";
export const OTHER_HIT_KEY = `${OTHER_PROJECT_KEY}-${OTHER_HIT_NUMBER}`;

export const ABSENT_WORD = "quokka";

export const LEGACY_HIT_ID = id("e2e00000000000000000d304");
export const LEGACY_HIT_NUMBER = 12;
export const LEGACY_HIT_WORD = "dirigible";
export const LEGACY_HIT_TITLE = "Dirigible logbook from before priorities";
export const LEGACY_HIT_KEY = `${PROJECT_KEY}-${LEGACY_HIT_NUMBER}`;

export const META_HIT_ID = id("e2e00000000000000000d305");
export const META_HIT_NUMBER = 13;
export const META_HIT_TITLE = "Rewrite the (old) mast [v2]";
export const META_QUERY = "[v2]";
export const META_WILDCARD = ".*";

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

export const OUTSIDER_USERNAME = "outsider";
export const OUTSIDER_PASSWORD = "test1234";
const OUTSIDER_PASSWORD_HASH = bcrypt.hashSync(OUTSIDER_PASSWORD, 10);
export const OUTSIDER_FULL_NAME = "E2E Outsider";
export const OUTSIDER_ID = id("e2e00000000000000000a006");

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

export const EXTRA_CATEGORY = "chore";

export async function seedExtraCategory() {
  const db = (await connect()).db!;
  await db.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { categories: [...CATEGORIES, { _id: new mongoose.Types.ObjectId(), name: EXTRA_CATEGORY, color: "#0ea5e9" }] } }
  );
  await mongoose.disconnect();
}

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

export const FOREIGN_ONLY_AGENT_NAME = "Their Runner";
export const FOREIGN_ONLY_AGENT_ID = id("e2e00000000000000000ab03");

export async function seedForeignAgent() {
  const db = (await connect()).db!;
  const now = new Date();
  await db.collection("agents").insertOne({
    _id: FOREIGN_ONLY_AGENT_ID,
    name: FOREIGN_ONLY_AGENT_NAME,
    description: "",
    owner: null,
    project: SECOND_PROJECT_ID,
    scope: "project",
    builtIn: false,
    composition: RUNNABLE_COMPOSITION,
    createdAt: now,
    updatedAt: now,
  });
  await mongoose.disconnect();
}

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

export async function storedTask(taskNumber: number): Promise<Record<string, unknown>> {
  const db = (await connect()).db!;
  const row = await db.collection("tasks").findOne({ project: PROJECT_ID, taskNumber });
  await mongoose.disconnect();
  if (!row) throw new Error(`no task ${taskNumber} on the seeded board`);
  return row as Record<string, unknown>;
}

export const MINE_ACTIVE_NUMBER = 200;
export const MINE_ACTIVE_TITLE = "Painting the mooring mast";

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

export const MINE_ORPHAN_STATUS = "mothballed";
export const MINE_ORPHAN_NUMBER = 204;
export const MINE_ORPHAN_TITLE = "Left in a column that is gone";

export const THEIRS_NUMBER = 205;
export const THEIRS_TITLE = "The member's own rivets";

export const THEIRS_UNREACHABLE_NUMBER = 2;
export const THEIRS_UNREACHABLE_TITLE = "On a board the member cannot reach";

export const MINE_OTHER_BOARD_NUMBER = 3;
export const MINE_OTHER_BOARD_TITLE = "A chore on the other board";

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

export async function deleteProjectRow(projectId: mongoose.Types.ObjectId) {
  const db = (await connect()).db!;
  await db.collection("projects").deleteOne({ _id: projectId });
  await mongoose.disconnect();
}

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

export async function grantMemberOn(projectId: mongoose.Types.ObjectId) {
  const db = (await connect()).db!;
  const now = new Date();
  await db.collection("grants").insertOne({
    subject: MEMBER_ID,
    relation: "member",
    objectType: "project",
    object: projectId,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  });
  await mongoose.disconnect();
}
